import { describe, expect, it, vi } from "vitest";

import { RealtimePublishRateLimitError } from "../../lib/realtime/signal-governor";
import {
  RealtimeRoomSession,
  type RealtimeEnvelope,
  type RoomSessionOptions,
  type RealtimeToken,
  type RealtimeTransportAdapter,
  type RealtimeTransportSubscription,
} from "../../lib/realtime/room-session";

class FakeClock {
  nowValue = 1_000_000;
  private nextTimerId = 1;
  private timers = new Map<number, { dueAt: number; callback: () => void }>();
  readonly delays: number[] = [];

  now = () => this.nowValue;

  setTimeout = (callback: () => void, delayMs: number) => {
    const timerId = this.nextTimerId++;
    this.delays.push(delayMs);
    this.timers.set(timerId, { dueAt: this.nowValue + delayMs, callback });
    return timerId as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };

  advance(ms: number) {
    this.nowValue += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.nowValue)
      .sort(([, left], [, right]) => left.dueAt - right.dueAt);
    for (const [timerId, timer] of due) {
      this.timers.delete(timerId);
      timer.callback();
    }
  }
}

type Connection = {
  input: Parameters<RealtimeTransportAdapter["connect"]>[0];
  unsubscribe: ReturnType<typeof vi.fn<() => void>>;
  publish: ReturnType<typeof vi.fn<(message: RealtimeEnvelope) => void>>;
};

function createTransport(outcomes: Array<"success" | Error> = ["success"]) {
  const connections: Connection[] = [];
  const connect = vi.fn(async (input: Parameters<RealtimeTransportAdapter["connect"]>[0]) => {
    const outcome = outcomes.shift() ?? "success";
    if (outcome instanceof Error) throw outcome;
    const connection: Connection = {
      input,
      unsubscribe: vi.fn<() => void>(() => undefined),
      publish: vi.fn<(message: RealtimeEnvelope) => void>(() => undefined),
    };
    connections.push(connection);
    return connection;
  });
  return { transport: { connect } satisfies RealtimeTransportAdapter, connect, connections };
}

function token(expiresAt: number, authorizationVersion = 1): RealtimeToken {
  return { tokenRequest: { synthetic: true }, expiresAt, authorizationVersion };
}

function message(clock: FakeClock, overrides: Partial<RealtimeEnvelope> = {}): RealtimeEnvelope {
  return {
    v: 1,
    kind: "interaction.cursor",
    messageId: "message-1",
    sender: { clientId: "remote-client", clientInstanceId: "remote-tab-a", connectionEpoch: 1 },
    missionId: "mission-a",
    roomId: "room-a",
    issuedAtMs: clock.now(),
    expiresAtMs: clock.now() + 10_000,
    clientSeq: 1,
    payload: { targetId: "canvas-1", x: 0.5, y: 0.5, mode: "map" },
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("RealtimeRoomSession", () => {
  it("connects with the exact Mission/room scope and keeps durable state outside the session", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const tokenProvider = vi.fn(async () => token(clock.now() + 300_000));
    const session = new RealtimeRoomSession({ tokenProvider, transport, clock });
    const scope = { missionId: "mission-a", roomId: "room-a" };

    await session.start(scope);

    expect(session.state).toBe("live");
    expect(session.scope).toEqual(scope);
    expect(tokenProvider).toHaveBeenCalledWith(scope);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ scope, connectionEpoch: 1 }));
    expect(await session.publish(message(clock))).toBe(true);
    expect(connections[0]!.publish).toHaveBeenCalledWith(expect.objectContaining({ missionId: "mission-a", roomId: "room-a" }));
    expect(await session.publish(message(clock, { missionId: "mission-b" }))).toBe(false);
    expect(await session.publish(message(clock, { roomId: "room-b" }))).toBe(false);

    await session.stop();
    expect(session.state).toBe("stopped");
    expect(session.scope).toBeUndefined();
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("refreshes before expiry and clears transient signals when durable authorization rotates", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const tokenProvider = vi
      .fn<() => Promise<RealtimeToken>>()
      .mockResolvedValueOnce(token(clock.now() + 90_000, 1))
      .mockResolvedValueOnce(token(clock.now() + 390_000, 2));
    const cleared: string[] = [];
    const received: RealtimeEnvelope[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider,
      transport,
      clock,
      onMessage: (value) => received.push(value),
      onTransientStateCleared: (reason) => cleared.push(reason),
    });

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    connections[0]!.input.onMessage(message(clock));
    expect(received).toHaveLength(1);

    clock.advance(60_000);
    await vi.waitFor(() => expect(connections).toHaveLength(2));

    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(connections).toHaveLength(2);
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(cleared).toEqual(expect.arrayContaining(["reconnect", "authorization-changed"]));
    connections[1]!.input.onMessage(message(clock, { messageId: "new-epoch", sender: { clientId: "remote-client", clientInstanceId: "remote-tab-a", connectionEpoch: 1 } }));
    expect(received).toHaveLength(2);
  });

  it("uses bounded reconnect delay, reports degraded state, and recovers without blocking durable work", async () => {
    const clock = new FakeClock();
    const networkError = new Error("network unavailable");
    const { transport, connect } = createTransport([networkError, "success"]);
    const states: string[] = [];
    const failures: unknown[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      reconnectDelayMs: () => 99_999,
      onStateChange: (state) => states.push(state),
      onTransportFailure: (error) => failures.push(error),
    });

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    expect(session.state).toBe("degraded");
    expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
    expect(clock.delays).toContain(30_000);

    clock.advance(30_000);
    await vi.waitFor(() => expect(session.state).toBe("live"));

    expect(session.state).toBe("live");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(states).toEqual(expect.arrayContaining(["connecting", "degraded", "reconnecting", "live"]));
  });

  it("stops retrying after the configured bounded reconnect budget", async () => {
    const clock = new FakeClock();
    const networkError = new Error("network unavailable");
    const { transport, connect } = createTransport([networkError, networkError, networkError]);
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      reconnectDelayMs: () => 10,
      maxReconnectAttempts: 1,
    });

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    clock.advance(10);
    await flush();
    clock.advance(30_000);
    await flush();

    expect(session.state).toBe("degraded");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("detaches immediately on an authorization failure and never retries cached access", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport, clock });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const unauthorized = new Error("Unauthorized");
    connections[0]!.input.onFailure(unauthorized);
    clock.advance(30_000);
    await flush();

    expect(session.state).toBe("unauthorized");
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("detaches the old subscription before handing off to an exact new room scope", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const cleared: string[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      onTransientStateCleared: (reason) => cleared.push(reason),
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    await session.start({ missionId: "mission-a", roomId: "room-b" });

    expect(connections).toHaveLength(2);
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(connections[1]!.input.scope).toEqual({ missionId: "mission-a", roomId: "room-b" });
    expect(session.scope).toEqual({ missionId: "mission-a", roomId: "room-b" });
    expect(cleared).toContain("scope-changed");
  });

  it("keeps the new exact scope live when a stale initial connection completes after a handoff", async () => {
    const clock = new FakeClock();
    const connections: Connection[] = [];
    let resolveOldConnection: ((connection: Connection) => void) | undefined;
    const connect = vi.fn((input: Parameters<RealtimeTransportAdapter["connect"]>[0]) => {
      const connection: Connection = {
        input,
        unsubscribe: vi.fn<() => void>(() => undefined),
        publish: vi.fn<(message: RealtimeEnvelope) => void>(() => undefined),
      };
      connections.push(connection);
      if (input.scope.roomId === "room-a") {
        return new Promise<Connection>((resolve) => { resolveOldConnection = resolve; });
      }
      return Promise.resolve(connection);
    });
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport: { connect },
      clock,
    });
    const oldStart = session.start({ missionId: "mission-a", roomId: "room-a" });
    await flush();
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    const newStart = session.start(newScope);
    await newStart;

    expect(session.state).toBe("live");
    expect(session.scope).toEqual(newScope);
    expect(connections[1]!.input.scope).toEqual(newScope);

    resolveOldConnection?.(connections[0]!);
    await oldStart;
    await flush();

    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("live");
    expect(session.scope).toEqual(newScope);
  });

  it("rejects expired, malformed, cross-scope, stale-epoch, duplicate, and stale-sequence signals", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport, clock, onMessage: (value) => received.push(value) });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const deliver = connections[0]!.input.onMessage;

    deliver(message(clock, { messageId: "sequence-4", clientSeq: 4 }));
    deliver(message(clock, { messageId: "sequence-4", clientSeq: 4 }));
    deliver(message(clock, { messageId: "sequence-3", clientSeq: 3 }));
    deliver(message(clock, { messageId: "sequence-5", clientSeq: 5 }));
    deliver(message(clock, { messageId: "old-epoch", sender: { clientId: "remote-client", clientInstanceId: "remote-tab-a", connectionEpoch: 0 }, clientSeq: 99 }));
    deliver(message(clock, { messageId: "other-tab", sender: { clientId: "remote-client", clientInstanceId: "remote-tab-b", connectionEpoch: 1 }, clientSeq: 0 }));
    deliver(message(clock, { messageId: "expired", expiresAtMs: clock.now() }));
    deliver(message(clock, { messageId: "other-mission", missionId: "mission-b" }));
    deliver(message(clock, { messageId: "other-room", roomId: "room-b" }));
    deliver(message(clock, { messageId: "bad-version", v: 2 as 1 }));
    deliver(message(clock, { messageId: "future-issued", issuedAtMs: clock.now() + 5_001, expiresAtMs: clock.now() + 6_001 }));
    deliver(message(clock, { messageId: "oversized-ttl", expiresAtMs: clock.now() + 45_001 }));

    expect(received.map((value) => value.messageId)).toEqual(["sequence-4", "sequence-5", "other-tab"]);
  });

  it("rejects unknown, schema-invalid, and extra-field inbound signal payloads", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport, clock, onMessage: (value) => received.push(value) });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const deliver = connections[0]!.input.onMessage;

    deliver(message(clock, { messageId: "unknown-kind", kind: "interaction.unknown" }));
    deliver(message(clock, { messageId: "invalid-coordinate", payload: { targetId: "canvas-1", x: 1.01, y: 0.5, mode: "map" } }));
    deliver(message(clock, { messageId: "extra-field", payload: { targetId: "canvas-1", x: 0.5, y: 0.5, mode: "map", unexpected: true } }));

    expect(received).toEqual([]);
  });

  it("bounds hostile inbound message ids and rotating client-instance streams", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      maxTrackedMessageIds: 2,
      maxTrackedSenderStreams: 1,
      onMessage: (value) => received.push(value),
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const deliver = connections[0]!.input.onMessage;

    deliver(message(clock, { messageId: "stream-a-1", sender: { clientId: "remote-client", clientInstanceId: "tab-a", connectionEpoch: 1 }, clientSeq: 1 }));
    deliver(message(clock, { messageId: "stream-b-1", sender: { clientId: "remote-client", clientInstanceId: "tab-b", connectionEpoch: 1 }, clientSeq: 1 }));
    deliver(message(clock, { messageId: "message-capacity", sender: { clientId: "remote-client", clientInstanceId: "tab-c", connectionEpoch: 1 }, clientSeq: 1 }));
    expect(received.map((value) => value.messageId)).toEqual(["stream-a-1", "stream-b-1"]);

    clock.advance(10_001);
    deliver(message(clock, { messageId: "stream-a-reused", sender: { clientId: "remote-client", clientInstanceId: "tab-a", connectionEpoch: 1 }, clientSeq: 1 }));
    expect(received.map((value) => value.messageId)).toEqual(["stream-a-1", "stream-b-1", "stream-a-reused"]);
  });

  it("drops oversized and cyclic payloads without surfacing them to the transient view", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport, clock, onMessage: (value) => received.push(value) });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const deliver = connections[0]!.input.onMessage;
    deliver(message(clock, { messageId: "oversized", payload: "x".repeat(2_049) }));
    deliver(message(clock, { messageId: "cyclic", payload: cyclic }));

    expect(received).toEqual([]);
  });

  it("never publishes expired, cross-scope, oversized, or cyclic outbound signals", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport, clock });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    await expect(session.publish(message(clock, { expiresAtMs: clock.now() }))).resolves.toBe(false);
    await expect(session.publish(message(clock, { missionId: "mission-b" }))).resolves.toBe(false);
    await expect(session.publish(message(clock, { payload: "x".repeat(2_049) }))).resolves.toBe(false);
    await expect(session.publish(message(clock, { payload: cyclic }))).resolves.toBe(false);

    expect(connections[0]!.publish).not.toHaveBeenCalled();
  });

  it("never publishes unknown, schema-invalid, or extra-field outbound signal payloads", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport, clock });
    await session.start({ missionId: "mission-a", roomId: "room-a" });

    await expect(session.publish(message(clock, { kind: "interaction.unknown" }))).resolves.toBe(false);
    await expect(session.publish(message(clock, { payload: { targetId: "canvas-1", x: -0.01, y: 0.5, mode: "map" } }))).resolves.toBe(false);
    await expect(session.publish(message(clock, { payload: { targetId: "canvas-1", x: 0.5, y: 0.5, mode: "map", unexpected: true } }))).resolves.toBe(false);

    expect(connections[0]!.publish).not.toHaveBeenCalled();
  });

  it("treats local publish-rate denials as nonfatal flow control", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const states: string[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      onStateChange: (state) => states.push(state),
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    connections[0]!.publish.mockRejectedValueOnce(new RealtimePublishRateLimitError(250));

    await expect(session.publish(message(clock))).resolves.toBe(false);
    expect(session.state).toBe("live");
    expect(states).not.toContain("degraded");
  });

  it("deduplicates concurrent same-scope starts and fails safe for invalid numeric options", async () => {
    const clock = new FakeClock();
    const { transport, connect } = createTransport([new Error("network unavailable")]);
    let resolveToken: ((value: RealtimeToken) => void) | undefined;
    const tokenProvider = vi.fn(() => new Promise<RealtimeToken>((resolve) => { resolveToken = resolve; }));
    const session = new RealtimeRoomSession({
      tokenProvider,
      transport,
      clock,
      refreshSkewMs: Number.NaN,
      minimumRefreshDelayMs: Number.NaN,
      maxReconnectAttempts: Number.NaN,
      maxMessageTtlMs: Number.NaN,
      maxFutureIssuedAtMs: Number.NaN,
      maxSerializedPayloadBytes: Number.NaN,
      random: () => Number.NaN,
    });
    const scope = { missionId: "mission-a", roomId: "room-a" };
    const firstStart = session.start(scope);
    const secondStart = session.start(scope);
    await flush();
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    resolveToken?.(token(clock.now() + 300_000));
    await Promise.all([firstStart, secondStart]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("degraded");
    expect(clock.delays).toContain(500);
  });

  it("bounds token acquisition, degrades and reconnects, and ignores a late token after the deadline", async () => {
    const clock = new FakeClock();
    const { transport, connect } = createTransport();
    const delayedToken = deferred<RealtimeToken>();
    const tokenProvider = vi
      .fn<() => Promise<RealtimeToken>>()
      .mockImplementationOnce(() => delayedToken.promise)
      .mockImplementationOnce(async () => token(clock.now() + 300_000));
    const states: string[] = [];
    const failures: unknown[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider,
      transport,
      clock,
      tokenAcquisitionTimeoutMs: 7,
      reconnectDelayMs: () => 11,
      onStateChange: (state) => states.push(state),
      onTransportFailure: (error) => failures.push(error),
    });
    const scope = { missionId: "mission-a", roomId: "room-a" };
    const start = session.start(scope);

    await flush();
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();

    clock.advance(7);
    await flush();
    await start;

    expect(session.state).toBe("degraded");
    expect(failures).toHaveLength(1);
    expect(connect).not.toHaveBeenCalled();
    expect(clock.delays).toEqual(expect.arrayContaining([7, 11]));

    delayedToken.resolve(token(clock.now() + 300_000));
    await flush();
    expect(connect).not.toHaveBeenCalled();
    expect(session.state).toBe("degraded");

    clock.advance(11);
    await vi.waitFor(() => expect(session.state).toBe("live"));

    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("live");
    expect(states).toEqual(expect.arrayContaining(["connecting", "degraded", "reconnecting", "live"]));
  });

  it("contains synchronous and rejected token provider failures without opening a transport connection", async () => {
    const providerSecret = "token-provider-secret";
    const providers = [
      () => { throw new Error(providerSecret); },
      () => Promise.reject(new Error(providerSecret)),
    ];

    for (const tokenProvider of providers) {
      const clock = new FakeClock();
      const { transport, connect } = createTransport();
      const failures: unknown[] = [];
      const session = new RealtimeRoomSession({
        tokenProvider,
        transport,
        clock,
        maxReconnectAttempts: 0,
        onTransportFailure: (error) => failures.push(error),
      });

      await session.start({ missionId: "mission-a", roomId: "room-a" });

      expect(session.state).toBe("degraded");
      expect(connect).not.toHaveBeenCalled();
      expect(failures).toHaveLength(1);
      expect(String(failures[0])).not.toContain(providerSecret);
    }
  });

  it("contains hostile resolved token getters without connecting or exposing provider details", async () => {
    const providerSecret = "hostile-token-getter-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const hostileTokens = [
        Object.defineProperties({ tokenRequest: { synthetic: true }, authorizationVersion: 1 }, {
          expiresAt: { get: () => { throw new Error(providerSecret); } },
        }),
        Object.defineProperties({ tokenRequest: { synthetic: true }, expiresAt: 1_300_000 }, {
          authorizationVersion: { get: () => { throw new Error(providerSecret); } },
        }),
      ];

      for (const hostileToken of hostileTokens) {
        const clock = new FakeClock();
        const { transport, connect } = createTransport();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => hostileToken as RealtimeToken,
          transport,
          clock,
          maxReconnectAttempts: 0,
          onTransportFailure: (error) => failures.push(error),
        });

        await session.start({ missionId: "mission-a", roomId: "room-a" });

        expect(session.state).toBe("degraded");
        expect(connect).not.toHaveBeenCalled();
        expect(failures).toHaveLength(1);
        expect(failures[0]).toEqual(expect.objectContaining({ message: expect.stringMatching(/^Realtime /) }));
        expect(String(failures[0])).not.toContain(providerSecret);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("connects when a token arrives before its bounded deadline and normalizes an invalid deadline option", async () => {
    const clock = new FakeClock();
    const { transport, connect } = createTransport();
    const tokenProvider = vi.fn(async () => token(clock.now() + 300_000));
    const session = new RealtimeRoomSession({
      tokenProvider,
      transport,
      clock,
      tokenAcquisitionTimeoutMs: Number.NaN,
    });

    await session.start({ missionId: "mission-a", roomId: "room-a" });

    expect(session.state).toBe("live");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clock.delays).toContain(10_000);

    const timelyClock = new FakeClock();
    const { transport: timelyTransport, connect: timelyConnect } = createTransport();
    const timelyToken = deferred<RealtimeToken>();
    const timelySession = new RealtimeRoomSession({
      tokenProvider: () => timelyToken.promise,
      transport: timelyTransport,
      clock: timelyClock,
      tokenAcquisitionTimeoutMs: 7,
    });
    const start = timelySession.start({ missionId: "mission-a", roomId: "room-a" });

    await flush();
    timelyClock.advance(6);
    await flush();
    expect(timelyConnect).not.toHaveBeenCalled();
    timelyToken.resolve(token(timelyClock.now() + 300_000));
    await start;
    timelyClock.advance(1);
    await flush();

    expect(timelySession.state).toBe("live");
    expect(timelyConnect).toHaveBeenCalledTimes(1);
  });

  it("cancels pending token acquisition on stop and scope handoff without allowing stale deadlines or tokens to connect", async () => {
    const clock = new FakeClock();
    const { transport, connect } = createTransport();
    const stoppedToken = deferred<RealtimeToken>();
    const handedOffToken = deferred<RealtimeToken>();
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    const tokenProvider = vi.fn((scope: { missionId: string; roomId: string }) => {
      if (scope.roomId === "room-b") return Promise.resolve(token(clock.now() + 300_000));
      return tokenProvider.mock.calls.filter(([requestedScope]) => requestedScope.roomId === "room-a").length === 1
        ? stoppedToken.promise
        : handedOffToken.promise;
    });
    const failures: unknown[] = [];
    const states: string[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider,
      transport,
      clock,
      tokenAcquisitionTimeoutMs: 7,
      onTransportFailure: (error) => failures.push(error),
      onStateChange: (state) => states.push(state),
    });

    const stoppedStart = session.start(oldScope);
    let stoppedStartSettled = false;
    void stoppedStart.then(() => { stoppedStartSettled = true; });
    await flush();
    expect(tokenProvider).toHaveBeenCalledTimes(1);

    await session.stop();
    await flush();
    expect(stoppedStartSettled).toBe(true);
    expect(session.state).toBe("stopped");
    clock.advance(7);
    await flush();
    expect(failures).toEqual([]);
    expect(connect).not.toHaveBeenCalled();

    stoppedToken.resolve(token(clock.now() + 300_000));
    await flush();
    expect(connect).not.toHaveBeenCalled();

    const handedOffStart = session.start(oldScope);
    let handedOffStartSettled = false;
    void handedOffStart.then(() => { handedOffStartSettled = true; });
    await flush();
    expect(tokenProvider).toHaveBeenCalledTimes(2);

    await session.start(newScope);
    await flush();
    expect(handedOffStartSettled).toBe(true);
    expect(session.state).toBe("live");
    expect(session.scope).toEqual(newScope);
    expect(connect).toHaveBeenCalledTimes(1);

    clock.advance(7);
    await flush();
    expect(session.state).toBe("live");
    expect(failures).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);

    handedOffToken.resolve(token(clock.now() + 300_000));
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.scope).toEqual(newScope);
    expect(states).not.toContain("degraded");
  });

  it("bounds a pending transport connection, retries it, and disposes a late subscription without activating it", async () => {
    const clock = new FakeClock();
    const lateConnection = deferred<RealtimeTransportSubscription>();
    const lateSubscription = { unsubscribe: vi.fn(() => undefined), publish: vi.fn(async () => undefined) };
    const recoveredSubscription = { unsubscribe: vi.fn(() => undefined), publish: vi.fn(async () => undefined) };
    const connect = vi.fn(() => connect.mock.calls.length === 1
      ? lateConnection.promise
      : Promise.resolve(recoveredSubscription));
    const failures: unknown[] = [];
    const states: string[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport: { connect } as RealtimeTransportAdapter,
      clock,
      transportConnectionTimeoutMs: 7,
      reconnectDelayMs: () => 11,
      onTransportFailure: (error) => failures.push(error),
      onStateChange: (state) => states.push(state),
    });
    const start = session.start({ missionId: "mission-a", roomId: "room-a" });

    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    clock.advance(7);
    await flush();
    await start;

    expect(session.state).toBe("degraded");
    expect(failures).toHaveLength(1);
    expect(clock.delays).toEqual(expect.arrayContaining([7, 11]));

    clock.advance(11);
    await vi.waitFor(() => expect(session.state).toBe("live"));
    expect(session.state).toBe("live");
    expect(connect).toHaveBeenCalledTimes(2);

    lateConnection.resolve(lateSubscription);
    await flush();
    expect(lateSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(recoveredSubscription.unsubscribe).not.toHaveBeenCalled();
    await expect(session.publish(message(clock))).resolves.toBe(true);
    expect(recoveredSubscription.publish).toHaveBeenCalledTimes(1);
    expect(lateSubscription.publish).not.toHaveBeenCalled();
    expect(states).toEqual(expect.arrayContaining(["connecting", "degraded", "reconnecting", "live"]));
  });

  it("cancels pending transport connections on stop and scope handoff, disposing every late old-scope subscription", async () => {
    const clock = new FakeClock();
    const stoppedConnection = deferred<RealtimeTransportSubscription>();
    const handedOffConnection = deferred<RealtimeTransportSubscription>();
    const stoppedSubscription = { unsubscribe: vi.fn(() => undefined) };
    const handedOffSubscription = { unsubscribe: vi.fn(() => undefined) };
    const newSubscription = { unsubscribe: vi.fn(() => undefined) };
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    const connect = vi.fn((input: Parameters<RealtimeTransportAdapter["connect"]>[0]) => {
      if (input.scope.roomId === "room-b") return Promise.resolve(newSubscription);
      return connect.mock.calls.filter(([requestedInput]) => requestedInput.scope.roomId === "room-a").length === 1
        ? stoppedConnection.promise
        : handedOffConnection.promise;
    });
    const failures: unknown[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport: { connect } as RealtimeTransportAdapter,
      clock,
      transportConnectionTimeoutMs: 7,
      onTransportFailure: (error) => failures.push(error),
    });

    const stoppedStart = session.start(oldScope);
    let stoppedStartSettled = false;
    void stoppedStart.then(() => { stoppedStartSettled = true; });
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    await session.stop();
    await flush();
    expect(stoppedStartSettled).toBe(true);
    clock.advance(7);
    await flush();
    expect(session.state).toBe("stopped");
    expect(failures).toEqual([]);

    stoppedConnection.resolve(stoppedSubscription);
    await flush();
    expect(stoppedSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);

    const handedOffStart = session.start(oldScope);
    let handedOffStartSettled = false;
    void handedOffStart.then(() => { handedOffStartSettled = true; });
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    await session.start(newScope);
    await flush();
    expect(handedOffStartSettled).toBe(true);
    expect(session.state).toBe("live");
    expect(session.scope).toEqual(newScope);
    expect(connect).toHaveBeenCalledTimes(3);

    clock.advance(7);
    await flush();
    expect(session.state).toBe("live");
    expect(failures).toEqual([]);
    handedOffConnection.resolve(handedOffSubscription);
    await flush();
    expect(handedOffSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(session.scope).toEqual(newScope);
  });

  it("clears a timely transport deadline and normalizes an invalid connection deadline option", async () => {
    const invalidClock = new FakeClock();
    const { transport: invalidTransport, connect: invalidConnect } = createTransport();
    const invalidSession = new RealtimeRoomSession({
      tokenProvider: async () => token(invalidClock.now() + 300_000),
      transport: invalidTransport,
      clock: invalidClock,
      transportConnectionTimeoutMs: Number.NaN,
    });
    await invalidSession.start({ missionId: "mission-a", roomId: "room-a" });
    expect(invalidSession.state).toBe("live");
    expect(invalidConnect).toHaveBeenCalledTimes(1);
    expect(invalidClock.delays).toContain(10_000);

    const clock = new FakeClock();
    const timelyConnection = deferred<RealtimeTransportSubscription>();
    const timelyConnect = vi.fn(() => timelyConnection.promise);
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport: { connect: timelyConnect } as RealtimeTransportAdapter,
      clock,
      transportConnectionTimeoutMs: 7,
    });
    const start = session.start({ missionId: "mission-a", roomId: "room-a" });

    await flush();
    expect(timelyConnect).toHaveBeenCalledTimes(1);
    clock.advance(6);
    await flush();
    timelyConnection.resolve({ unsubscribe: vi.fn(() => undefined) });
    await start;
    clock.advance(1);
    await flush();

    expect(session.state).toBe("live");
    expect(timelyConnect).toHaveBeenCalledTimes(1);
  });

  it("contains hostile transport and subscription cleanup surfaces without exposing provider failures", async () => {
    const providerSecret = "transport-provider-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const hostileConnectors = [
        () => { throw new Error(providerSecret); },
        () => Promise.reject(new Error(providerSecret)),
        () => Promise.resolve({}),
        () => Promise.resolve(Object.defineProperties({}, {
          unsubscribe: { get: () => { throw new Error(providerSecret); } },
        })),
      ];
      for (const connect of hostileConnectors) {
        const clock = new FakeClock();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport: { connect } as unknown as RealtimeTransportAdapter,
          clock,
          maxReconnectAttempts: 0,
          onTransportFailure: (error) => failures.push(error),
        });

        await session.start({ missionId: "mission-a", roomId: "room-a" });

        expect(session.state).toBe("degraded");
        expect(failures).toHaveLength(1);
        expect(failures[0]).toEqual(expect.objectContaining({ message: expect.stringMatching(/^Realtime /) }));
        expect(String(failures[0])).not.toContain(providerSecret);
      }

      for (const unsubscribe of [
        () => { throw new Error(providerSecret); },
        () => Promise.reject(new Error(providerSecret)),
      ]) {
        const clock = new FakeClock();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport: { connect: async () => ({ unsubscribe }) },
          clock,
          onTransportFailure: (error) => failures.push(error),
        });

        await session.start({ missionId: "mission-a", roomId: "room-a" });
        await session.stop();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(session.state).toBe("stopped");
        expect(failures).toEqual([]);
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("disposes timely and late invalid publish candidates without activating them or exposing provider details", async () => {
    const providerSecret = "hostile-transport-publish-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const candidates = [
        () => {
          const unsubscribe = vi.fn(() => undefined);
          return {
            candidate: Object.defineProperties({}, {
              unsubscribe: { value: unsubscribe },
              publish: { get: () => { throw new Error(providerSecret); } },
            }),
            unsubscribe,
          };
        },
        () => {
          const unsubscribe = vi.fn(() => undefined);
          return { candidate: { unsubscribe, publish: "not-a-function" }, unsubscribe };
        },
      ];

      for (const makeCandidate of candidates) {
        const clock = new FakeClock();
        const { candidate, unsubscribe } = makeCandidate();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport: { connect: async () => candidate } as unknown as RealtimeTransportAdapter,
          clock,
          maxReconnectAttempts: 0,
          onTransportFailure: (error) => failures.push(error),
        });

        await session.start({ missionId: "mission-a", roomId: "room-a" });

        expect(session.state).toBe("degraded");
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        await expect(session.publish(message(clock))).resolves.toBe(false);
        expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
        expect(String(failures[0])).not.toContain(providerSecret);
      }

      for (const makeCandidate of candidates) {
        const clock = new FakeClock();
        const { candidate, unsubscribe } = makeCandidate();
        const lateCandidate = deferred<unknown>();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport: { connect: () => lateCandidate.promise } as unknown as RealtimeTransportAdapter,
          clock,
          transportConnectionTimeoutMs: 7,
          maxReconnectAttempts: 0,
          onTransportFailure: (error) => failures.push(error),
        });
        const start = session.start({ missionId: "mission-a", roomId: "room-a" });

        await flush();
        clock.advance(7);
        await start;
        lateCandidate.resolve(candidate);
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));

        expect(session.state).toBe("degraded");
        await expect(session.publish(message(clock))).resolves.toBe(false);
        expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
        expect(String(failures[0])).not.toContain(providerSecret);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("bounds hanging cleanup for timely and late invalid publish candidates without activating either connection", async () => {
    const providerSecret = "hanging-invalid-candidate-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const candidates = [
        () => {
          const cleanup = deferred<void>();
          const unsubscribe = vi.fn(() => cleanup.promise);
          return {
            candidate: Object.defineProperties({}, {
              unsubscribe: { value: unsubscribe },
              publish: { get: () => { throw new Error(providerSecret); } },
            }),
            cleanup,
            unsubscribe,
          };
        },
        () => {
          const cleanup = deferred<void>();
          const unsubscribe = vi.fn(() => cleanup.promise);
          return { candidate: { unsubscribe, publish: "not-a-function" }, cleanup, unsubscribe };
        },
      ];

      for (const makeCandidate of candidates) {
        const clock = new FakeClock();
        const { candidate, cleanup, unsubscribe } = makeCandidate();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport: { connect: async () => candidate } as unknown as RealtimeTransportAdapter,
          clock,
          tokenAcquisitionTimeoutMs: 3,
          transportConnectionTimeoutMs: 4,
          transportDisposalTimeoutMs: 7,
          maxReconnectAttempts: 0,
          onTransportFailure: (error) => failures.push(error),
        });

        await session.start({ missionId: "mission-a", roomId: "room-a" });
        expect(session.state).toBe("degraded");
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(clock.delays.filter((delay) => delay === 7)).toHaveLength(1);
        await expect(session.publish(message(clock))).resolves.toBe(false);
        expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
        expect(String(failures[0])).not.toContain(providerSecret);

        clock.advance(7);
        await flush();
        expect(failures).toHaveLength(1);
        cleanup.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(failures).toHaveLength(1);
      }

      for (const makeCandidate of candidates) {
        const clock = new FakeClock();
        const { candidate, cleanup, unsubscribe } = makeCandidate();
        const lateCandidate = deferred<unknown>();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport: { connect: () => lateCandidate.promise } as unknown as RealtimeTransportAdapter,
          clock,
          tokenAcquisitionTimeoutMs: 3,
          transportConnectionTimeoutMs: 4,
          transportDisposalTimeoutMs: 7,
          maxReconnectAttempts: 0,
          onTransportFailure: (error) => failures.push(error),
        });
        const start = session.start({ missionId: "mission-a", roomId: "room-a" });

        await flush();
        clock.advance(4);
        await start;
        lateCandidate.resolve(candidate);
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
        expect(session.state).toBe("degraded");
        expect(clock.delays.filter((delay) => delay === 7)).toHaveLength(1);
        await expect(session.publish(message(clock))).resolves.toBe(false);
        expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
        expect(String(failures[0])).not.toContain(providerSecret);

        clock.advance(7);
        await flush();
        expect(failures).toHaveLength(1);
        cleanup.reject(new Error(providerSecret));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(failures).toHaveLength(1);
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("bounds a pending transport publish, returns false, and recovers only through a new connection generation", async () => {
    const clock = new FakeClock();
    const pendingPublication = deferred<void>();
    const originalSubscription = {
      unsubscribe: vi.fn(() => undefined),
      publish: vi.fn(() => pendingPublication.promise),
    };
    const recoveredSubscription = {
      unsubscribe: vi.fn(() => undefined),
      publish: vi.fn(async () => undefined),
    };
    const connect = vi.fn(() => connect.mock.calls.length === 1
      ? Promise.resolve(originalSubscription)
      : Promise.resolve(recoveredSubscription));
    const failures: unknown[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport: { connect } as RealtimeTransportAdapter,
      clock,
      transportPublishTimeoutMs: 7,
      reconnectDelayMs: () => 11,
      onTransportFailure: (error) => failures.push(error),
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });

    const pendingPublish = session.publish(message(clock));
    await vi.waitFor(() => expect(originalSubscription.publish).toHaveBeenCalledTimes(1));
    clock.advance(7);

    await expect(pendingPublish).resolves.toBe(false);
    expect(session.state).toBe("degraded");
    expect(failures).toHaveLength(1);
    expect(originalSubscription.unsubscribe).toHaveBeenCalledTimes(1);

    clock.advance(11);
    await vi.waitFor(() => expect(session.state).toBe("live"));
    expect(connect).toHaveBeenCalledTimes(2);

    pendingPublication.resolve();
    await flush();
    expect(session.state).toBe("live");
    await expect(session.publish(message(clock, { messageId: "recovered-publish" }))).resolves.toBe(true);
    expect(recoveredSubscription.publish).toHaveBeenCalledTimes(1);
  });

  it("cancels concurrent publishes on stop and scope handoff so late completions cannot affect the new room", async () => {
    const clock = new FakeClock();
    const stoppedResolve = deferred<void>();
    const stoppedReject = deferred<void>();
    const handedOffResolve = deferred<void>();
    const handedOffReject = deferred<void>();
    const stoppedSubscription = {
      unsubscribe: vi.fn(() => undefined),
      publish: vi.fn()
        .mockImplementationOnce(() => stoppedResolve.promise)
        .mockImplementationOnce(() => stoppedReject.promise),
    };
    const handedOffSubscription = {
      unsubscribe: vi.fn(() => undefined),
      publish: vi.fn()
        .mockImplementationOnce(() => handedOffResolve.promise)
        .mockImplementationOnce(() => handedOffReject.promise),
    };
    const newSubscription = { unsubscribe: vi.fn(() => undefined), publish: vi.fn(async () => undefined) };
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    const connect = vi.fn((input: Parameters<RealtimeTransportAdapter["connect"]>[0]) => {
      if (input.scope.roomId === "room-b") return Promise.resolve(newSubscription);
      return connect.mock.calls.filter(([requestedInput]) => requestedInput.scope.roomId === "room-a").length === 1
        ? Promise.resolve(stoppedSubscription)
        : Promise.resolve(handedOffSubscription);
    });
    const failures: unknown[] = [];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const session = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport: { connect } as RealtimeTransportAdapter,
        clock,
        transportPublishTimeoutMs: 7,
        onTransportFailure: (error) => failures.push(error),
      });
      await session.start(oldScope);
      const stoppedPublishes = [
        session.publish(message(clock, { messageId: "stopped-resolve" })),
        session.publish(message(clock, { messageId: "stopped-reject" })),
      ];
      await vi.waitFor(() => expect(stoppedSubscription.publish).toHaveBeenCalledTimes(2));

      await session.stop();
      await expect(Promise.all(stoppedPublishes)).resolves.toEqual([false, false]);
      clock.advance(7);
      await flush();
      expect(session.state).toBe("stopped");
      expect(failures).toEqual([]);

      stoppedResolve.resolve();
      stoppedReject.reject(new Error("old-stop-provider-secret"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(failures).toEqual([]);

      await session.start(oldScope);
      const handedOffPublishes = [
        session.publish(message(clock, { messageId: "handoff-resolve" })),
        session.publish(message(clock, { messageId: "handoff-reject" })),
      ];
      await vi.waitFor(() => expect(handedOffSubscription.publish).toHaveBeenCalledTimes(2));

      await session.start(newScope);
      await expect(Promise.all(handedOffPublishes)).resolves.toEqual([false, false]);
      expect(session.state).toBe("live");
      expect(session.scope).toEqual(newScope);
      expect(connect).toHaveBeenCalledTimes(3);

      handedOffResolve.resolve();
      handedOffReject.reject(new Error("old-handoff-provider-secret"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.state).toBe("live");
      expect(session.scope).toEqual(newScope);
      expect(failures).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("clears a timely publication deadline and normalizes an invalid publish timeout option", async () => {
    const invalidClock = new FakeClock();
    const invalidSubscription = { unsubscribe: vi.fn(() => undefined), publish: vi.fn(async () => undefined) };
    const invalidSession = new RealtimeRoomSession({
      tokenProvider: async () => token(invalidClock.now() + 300_000),
      transport: { connect: async () => invalidSubscription },
      clock: invalidClock,
      tokenAcquisitionTimeoutMs: 3,
      transportConnectionTimeoutMs: 4,
      transportPublishTimeoutMs: Number.NaN,
    });
    await invalidSession.start({ missionId: "mission-a", roomId: "room-a" });
    await expect(invalidSession.publish(message(invalidClock))).resolves.toBe(true);
    expect(invalidClock.delays).toContain(10_000);

    const clock = new FakeClock();
    const timelyPublication = deferred<void>();
    const subscription = { unsubscribe: vi.fn(() => undefined), publish: vi.fn(() => timelyPublication.promise) };
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport: { connect: async () => subscription },
      clock,
      transportPublishTimeoutMs: 7,
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const publication = session.publish(message(clock));
    await vi.waitFor(() => expect(subscription.publish).toHaveBeenCalledTimes(1));
    clock.advance(6);
    await flush();
    expect(session.state).toBe("live");
    timelyPublication.resolve();
    await expect(publication).resolves.toBe(true);
    clock.advance(1);
    await flush();
    expect(session.state).toBe("live");
  });

  it("contains synchronous, rejected, and hostile publication failures without degrading on rate limiting", async () => {
    const providerSecret = "publish-provider-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const hostileThenable = Object.defineProperty({}, "then", {
        get: () => { throw new Error(providerSecret); },
      });
      for (const publish of [
        () => { throw new Error(providerSecret); },
        () => Promise.reject(new Error(providerSecret)),
        () => hostileThenable,
      ]) {
        const clock = new FakeClock();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport: { connect: async () => ({ unsubscribe: () => undefined, publish }) } as unknown as RealtimeTransportAdapter,
          clock,
          maxReconnectAttempts: 0,
          onTransportFailure: (error) => failures.push(error),
        });
        await session.start({ missionId: "mission-a", roomId: "room-a" });

        await expect(session.publish(message(clock))).resolves.toBe(false);
        expect(session.state).toBe("degraded");
        expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
        expect(String(failures[0])).not.toContain(providerSecret);
      }

      const clock = new FakeClock();
      const rateLimitedSession = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport: {
          connect: async () => ({
            unsubscribe: () => undefined,
            publish: () => Promise.reject(new RealtimePublishRateLimitError(250)),
          }),
        },
        clock,
      });
      await rateLimitedSession.start({ missionId: "mission-a", roomId: "room-a" });
      await expect(rateLimitedSession.publish(message(clock))).resolves.toBe(false);
      expect(rateLimitedSession.state).toBe("live");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("cancels a pending publish when the active connection fails without scheduling duplicate failure work", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const latePublication = deferred<void>();
    const failures: unknown[] = [];
    const states: string[] = [];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const session = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        clock,
        transportPublishTimeoutMs: 7,
        reconnectDelayMs: () => 11,
        onTransportFailure: (error) => failures.push(error),
        onStateChange: (state) => states.push(state),
      });
      await session.start({ missionId: "mission-a", roomId: "room-a" });
      connections[0]!.publish.mockImplementation(() => latePublication.promise);
      const pendingPublish = session.publish(message(clock));
      await vi.waitFor(() => expect(connections[0]!.publish).toHaveBeenCalledTimes(1));

      connections[0]!.input.onFailure(new Error("active-connection-provider-secret"));
      await expect(pendingPublish).resolves.toBe(false);
      expect(session.state).toBe("degraded");
      expect(failures).toHaveLength(1);
      expect(states.filter((state) => state === "degraded")).toHaveLength(1);

      clock.advance(7);
      await flush();
      expect(session.state).toBe("degraded");
      expect(failures).toHaveLength(1);
      expect(connect).toHaveBeenCalledTimes(1);

      clock.advance(4);
      await vi.waitFor(() => expect(session.state).toBe("live"));
      expect(connect).toHaveBeenCalledTimes(2);

      latePublication.reject(new Error("late-publish-provider-secret"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.state).toBe("live");
      expect(failures).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("cancels a pending publish before refresh replaces its connection and contains late settlement", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const latePublication = deferred<void>();
    const failures: unknown[] = [];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const session = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        clock,
        transportPublishTimeoutMs: 7,
        onTransportFailure: (error) => failures.push(error),
      });
      await session.start({ missionId: "mission-a", roomId: "room-a" });
      connections[0]!.publish.mockImplementation(() => latePublication.promise);
      const pendingPublish = session.publish(message(clock));
      await vi.waitFor(() => expect(connections[0]!.publish).toHaveBeenCalledTimes(1));

      await session.refresh();
      await expect(pendingPublish).resolves.toBe(false);
      expect(session.state).toBe("live");
      expect(connect).toHaveBeenCalledTimes(2);
      expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);

      clock.advance(7);
      await flush();
      expect(session.state).toBe("live");
      expect(failures).toEqual([]);
      latePublication.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.state).toBe("live");
      expect(connect).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("keeps stop, refresh, failure, and room handoff prompt while disposing each old subscription once", async () => {
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    for (const lifecycle of ["stop", "refresh", "failure", "handoff"] as const) {
      const clock = new FakeClock();
      const { transport, connect, connections } = createTransport();
      const cleanup = deferred<void>();
      const failures: unknown[] = [];
      const session = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        clock,
        tokenAcquisitionTimeoutMs: 3,
        transportConnectionTimeoutMs: 4,
        transportPublishTimeoutMs: 5,
        transportDisposalTimeoutMs: 7,
        reconnectDelayMs: () => 11,
        onTransportFailure: (error) => failures.push(error),
      });
      await session.start(oldScope);
      connections[0]!.unsubscribe.mockImplementation(() => cleanup.promise);

      if (lifecycle === "stop") {
        await Promise.all([session.stop(), session.stop()]);
        expect(session.state).toBe("stopped");
      } else if (lifecycle === "refresh") {
        await session.refresh();
        expect(session.state).toBe("live");
        expect(connect).toHaveBeenCalledTimes(2);
      } else if (lifecycle === "failure") {
        connections[0]!.input.onFailure(new Error("connection-failure"));
        expect(session.state).toBe("degraded");
      } else {
        await session.start(newScope);
        expect(session.state).toBe("live");
        expect(session.scope).toEqual(newScope);
        expect(connect).toHaveBeenCalledTimes(2);
      }

      expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      expect(clock.delays.filter((delay) => delay === 7)).toHaveLength(1);
      clock.advance(7);
      await flush();
      expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      expect(failures).toHaveLength(lifecycle === "failure" ? 1 : 0);

      if (lifecycle === "failure") {
        clock.advance(4);
        await vi.waitFor(() => expect(session.state).toBe("live"));
        expect(connect).toHaveBeenCalledTimes(2);
      }

      cleanup.reject(new Error("late-disposal-provider-secret"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      expect(failures).toHaveLength(lifecycle === "failure" ? 1 : 0);
      if (lifecycle === "stop") expect(session.state).toBe("stopped");
      else if (lifecycle === "handoff") expect(session.scope).toEqual(newScope);
      else expect(session.state).toBe("live");
    }
  });

  it("bounds throwing, rejected, never-settling, and hostile cleanup without leaking provider details or rejections", async () => {
    const providerSecret = "unsubscribe-provider-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const neverSettling = deferred<void>();
      const cleanupVariants = [
        () => { throw new Error(providerSecret); },
        () => Promise.reject(new Error(providerSecret)),
        () => neverSettling.promise,
        () => Object.defineProperty({}, "then", { get: () => { throw new Error(providerSecret); } }),
      ];
      for (const unsubscribe of cleanupVariants) {
        const clock = new FakeClock();
        const { transport, connections } = createTransport();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          transportDisposalTimeoutMs: 7,
          onTransportFailure: (error) => failures.push(error),
        });
        await session.start({ missionId: "mission-a", roomId: "room-a" });
        connections[0]!.unsubscribe.mockImplementation(unsubscribe);

        await session.stop();
        expect(session.state).toBe("stopped");
        expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(clock.delays.filter((delay) => delay === 7)).toHaveLength(1);
        clock.advance(7);
        await flush();

        expect(failures).toEqual([]);
        expect(session.state).toBe("stopped");
      }
      neverSettling.reject(new Error(providerSecret));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("clears a timely disposal deadline so late clock advancement cannot affect the replacement session", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const cleanup = deferred<void>();
    const failures: unknown[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      transportDisposalTimeoutMs: 7,
      onTransportFailure: (error) => failures.push(error),
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    connections[0]!.unsubscribe.mockImplementation(() => cleanup.promise);

    await session.refresh();
    expect(session.state).toBe("live");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(clock.delays.filter((delay) => delay === 7)).toHaveLength(1);
    cleanup.resolve();
    await flush();
    clock.advance(7);
    await flush();

    expect(session.state).toBe("live");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([]);
  });

  it("normalizes the disposal deadline independently from acquisition, connection, publication, refresh, and reconnect timers", async () => {
    const cases: Array<{ option?: number; expectedDelay: number }> = [
      { expectedDelay: 10_000 },
      { option: 0, expectedDelay: 1 },
      { option: 300_001, expectedDelay: 30_000 },
      { option: Number.NaN, expectedDelay: 10_000 },
    ];
    for (const { option, expectedDelay } of cases) {
      const clock = new FakeClock();
      const { transport, connections } = createTransport();
      const session = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        clock,
        tokenAcquisitionTimeoutMs: 3,
        transportConnectionTimeoutMs: 4,
        transportPublishTimeoutMs: 5,
        ...(option === undefined ? {} : { transportDisposalTimeoutMs: option }),
      });
      await session.start({ missionId: "mission-a", roomId: "room-a" });
      await session.stop();

      expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      expect(clock.delays).toEqual(expect.arrayContaining([3, 4, expectedDelay]));
      expect(clock.delays.filter((delay) => delay === expectedDelay)).toHaveLength(1);
    }
  });

  it("contains every observer hook while preserving lifecycle, receiver, snapshot, and expiry behavior", async () => {
    const providerSecret = "observer-provider-secret";
    const modes = ["throw", "reject", "hostile-thenable", "late-reject"] as const;
    for (const mode of modes) {
      const clock = new FakeClock();
      const { transport, connections } = createTransport([new Error(providerSecret), "success", "success"]);
      const reads = {
        onStateChange: 0,
        onMessage: 0,
        onTransientStateCleared: 0,
        onTransportFailure: 0,
        onTransientMessageExpired: 0,
      };
      const receivers: unknown[] = [];
      const calls: Array<{ hook: keyof typeof reads; value: unknown }> = [];
      const lateRejections: Array<ReturnType<typeof deferred<void>>> = [];
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", observeUnhandled);
      try {
        const options: RoomSessionOptions = {
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          reconnectDelayMs: () => 11,
        };
        const observer = (hook: keyof typeof reads) => function (this: unknown, value: unknown) {
          receivers.push(this);
          calls.push({ hook, value });
          if (mode === "throw") throw new Error(providerSecret);
          if (mode === "reject") return Promise.reject(new Error(providerSecret));
          if (mode === "hostile-thenable") return Object.defineProperty({}, "then", {
            get: () => { throw new Error(providerSecret); },
          });
          const late = deferred<void>();
          lateRejections.push(late);
          return late.promise;
        };
        for (const hook of Object.keys(reads) as Array<keyof typeof reads>) {
          Object.defineProperty(options, hook, {
            get: () => {
              reads[hook] += 1;
              return observer(hook);
            },
          });
        }
        const session = new RealtimeRoomSession(options);

        await session.start({ missionId: "mission-a", roomId: "room-a" });
        expect(session.state).toBe("degraded");
        clock.advance(11);
        await vi.waitFor(() => expect(session.state).toBe("live"));
        expect(connections).toHaveLength(1);

        const shortLived = message(clock, { messageId: `observer-${mode}`, expiresAtMs: clock.now() + 6 });
        connections[0]!.input.onMessage(shortLived);
        connections[0]!.input.onMessage(shortLived);
        clock.advance(6);
        await flush();

        await session.refresh();
        expect(session.state).toBe("live");
        expect(connections).toHaveLength(2);
        await session.stop();
        expect(session.state).toBe("stopped");

        expect(calls.filter((call) => call.hook === "onMessage")).toHaveLength(1);
        expect(calls.filter((call) => call.hook === "onTransientMessageExpired")).toHaveLength(1);
        expect(calls.map((call) => call.hook)).toEqual(expect.arrayContaining([
          "onStateChange",
          "onMessage",
          "onTransientStateCleared",
          "onTransportFailure",
          "onTransientMessageExpired",
        ]));
        expect(calls.filter((call) => call.hook === "onTransientStateCleared").map((call) => call.value)).toEqual(expect.arrayContaining(["reconnect", "stopped"]));
        expect(calls.filter((call) => call.hook === "onTransportFailure").map((call) => String(call.value))).not.toContain(providerSecret);
        expect(reads).toEqual({
          onStateChange: 1,
          onMessage: 1,
          onTransientStateCleared: 1,
          onTransportFailure: 1,
          onTransientMessageExpired: 1,
        });
        expect(receivers).toEqual(expect.arrayContaining([options]));
        expect(receivers).toHaveLength(calls.length);
        expect(receivers.every((receiver) => receiver === options)).toBe(true);

        for (const late of lateRejections) late.reject(new Error(providerSecret));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(session.state).toBe("stopped");
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", observeUnhandled);
      }
    }
  });

  it("contains reentrant transport-failure observers that stop or hand off before stale recovery can continue", async () => {
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    for (const action of ["stop", "handoff"] as const) {
      const clock = new FakeClock();
      const { transport, connect, connections } = createTransport([new Error("initial connection failure"), "success"]);
      const states: string[] = [];
      const failures: unknown[] = [];
      const session = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        clock,
        reconnectDelayMs: () => 11,
        onStateChange: (state) => states.push(state),
        onTransportFailure: (error) => {
          failures.push(error);
          if (action === "stop") void session.stop();
          else void session.start(newScope);
        },
      });

      await session.start(oldScope);
      await vi.waitFor(() => expect(session.state).toBe(action === "stop" ? "stopped" : "live"));

      expect(failures).toHaveLength(1);
      expect(states.filter((state) => state === "degraded")).toHaveLength(1);
      expect(connect).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
      if (action === "stop") {
        expect(session.scope).toBeUndefined();
        expect(connections).toHaveLength(0);
      } else {
        expect(session.scope).toEqual(newScope);
        expect(connections).toHaveLength(1);
        expect(connections[0]!.input.scope).toEqual(newScope);
      }

      clock.advance(30_000);
      await flush();
      expect(connect).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
      expect(failures).toHaveLength(1);
    }
  });

  it("contains reentrant state observers across connecting, degraded, and live transitions", async () => {
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    const cases = [
      { trigger: "connecting", action: "stop", outcomes: ["success"] as Array<"success" | Error> },
      { trigger: "degraded", action: "handoff", outcomes: [new Error("initial connection failure"), "success"] as Array<"success" | Error> },
      { trigger: "live", action: "stop", outcomes: ["success"] as Array<"success" | Error> },
      { trigger: "live", action: "handoff", outcomes: ["success", "success"] as Array<"success" | Error> },
    ] as const;
    for (const { trigger, action, outcomes } of cases) {
      const clock = new FakeClock();
      const { transport, connect, connections } = createTransport([...outcomes]);
      const states: string[] = [];
      const failures: unknown[] = [];
      let acted = false;
      const session = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        clock,
        reconnectDelayMs: () => 11,
        onTransportFailure: (error) => failures.push(error),
        onStateChange: (state) => {
          states.push(state);
          if (!acted && state === trigger) {
            acted = true;
            if (action === "stop") void session.stop();
            else void session.start(newScope);
          }
        },
      });

      await session.start(oldScope);
      await vi.waitFor(() => expect(session.state).toBe(action === "stop" ? "stopped" : "live"));

      expect(acted).toBe(true);
      const expectedTriggerTransitions = trigger === "live" && action === "handoff" ? 2 : 1;
      expect(states.filter((state) => state === trigger)).toHaveLength(expectedTriggerTransitions);
      expect(failures).toEqual([]);
      if (action === "stop") {
        expect(session.scope).toBeUndefined();
        expect(connect).toHaveBeenCalledTimes(trigger === "connecting" ? 0 : 1);
        if (trigger === "live") expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      } else {
        expect(session.scope).toEqual(newScope);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(connections.at(-1)!.input.scope).toEqual(newScope);
        if (trigger === "live") expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      }

      const callsBeforeAdvance = connect.mock.calls.length;
      clock.advance(30_000);
      await flush();
      expect(connect).toHaveBeenCalledTimes(callsBeforeAdvance);
      expect(states.filter((state) => state === trigger)).toHaveLength(expectedTriggerTransitions);
    }
  });

  it("contains a reentrant transient-clear observer during reconnect and scope clear", async () => {
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    for (const trigger of ["refresh", "handoff"] as const) {
      const clock = new FakeClock();
      const { transport, connect, connections } = createTransport();
      const clearReasons: string[] = [];
      const expired: RealtimeEnvelope[] = [];
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", observeUnhandled);
      try {
        let clearObserverActive = false;
        let recursiveClearCallbacks = 0;
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          onTransientMessageExpired: (value) => expired.push(value),
          onTransientStateCleared: (reason) => {
            clearReasons.push(reason);
            if (clearObserverActive) {
              recursiveClearCallbacks += 1;
              return;
            }
            clearObserverActive = true;
            void session.stop();
            clearObserverActive = false;
          },
        });
        await session.start(oldScope);
        const expiringMessage = message(clock, { messageId: `clear-${trigger}`, expiresAtMs: clock.now() + 6 });
        connections[0]!.input.onMessage(expiringMessage);

        if (trigger === "refresh") await session.refresh();
        else await session.start(newScope);
        await vi.waitFor(() => expect(session.state).toBe("stopped"));

        expect(clearReasons).toEqual([trigger === "refresh" ? "reconnect" : "scope-changed"]);
        expect(recursiveClearCallbacks).toBe(0);
        expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledTimes(1);

        clock.advance(30_000);
        await flush();
        expect(session.state).toBe("stopped");
        expect(session.scope).toBeUndefined();
        expect(connect).toHaveBeenCalledTimes(1);
        expect(expired).toEqual([]);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", observeUnhandled);
      }
    }
  });

  it("snapshots the synchronous unauthorized classifier once and contains hostile option surfaces", async () => {
    const providerSecret = "unauthorized-classifier-secret";
    const modes = ["receiver", "throwing-getter", "nonfunction", "throwing-classifier"] as const;
    for (const mode of modes) {
      const clock = new FakeClock();
      const { transport, connect } = createTransport([new Error("connection failed")]);
      const failures: unknown[] = [];
      const receivers: unknown[] = [];
      let reads = 0;
      const options: RoomSessionOptions = {
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        clock,
        maxReconnectAttempts: 0,
        onTransportFailure: (error) => failures.push(error),
      };
      Object.defineProperty(options, "isUnauthorizedError", {
        get: () => {
          reads += 1;
          if (mode === "throwing-getter") throw new Error(providerSecret);
          if (mode === "nonfunction") return providerSecret;
          return function (this: unknown) {
            receivers.push(this);
            if (mode === "throwing-classifier") throw new Error(providerSecret);
            return false;
          };
        },
      });

      const session = new RealtimeRoomSession(options);
      await session.start({ missionId: "mission-a", roomId: "room-a" });

      expect(session.state).toBe("degraded");
      expect(connect).toHaveBeenCalledTimes(1);
      expect(reads).toBe(1);
      expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
      expect(String(failures[0])).not.toContain(providerSecret);
      if (mode === "receiver" || mode === "throwing-classifier") expect(receivers).toEqual([options]);
      else expect(receivers).toEqual([]);

      clock.advance(30_000);
      await flush();
      expect(connect).toHaveBeenCalledTimes(1);
    }
  });

  it("lets reentrant unauthorized classification stop or hand off without stale failure recovery", async () => {
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    for (const action of ["stop", "handoff"] as const) {
      const clock = new FakeClock();
      const { transport, connect, connections } = createTransport(["success", "success"]);
      const failures: unknown[] = [];
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", observeUnhandled);
      try {
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          reconnectDelayMs: () => 11,
          onTransportFailure: (error) => failures.push(error),
          isUnauthorizedError: () => {
            if (action === "stop") void session.stop();
            else void session.start(newScope);
            return false;
          },
        });
        await session.start(oldScope);
        connections[0]!.input.onFailure(new Error("network failure"));
        await vi.waitFor(() => expect(session.state).toBe(action === "stop" ? "stopped" : "live"));

        expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(failures).toEqual([]);
        if (action === "stop") {
          expect(session.scope).toBeUndefined();
          expect(connect).toHaveBeenCalledTimes(1);
        } else {
          expect(session.scope).toEqual(newScope);
          expect(connect).toHaveBeenCalledTimes(2);
          expect(connections[1]!.input.scope).toEqual(newScope);
        }

        const callsBeforeAdvance = connect.mock.calls.length;
        clock.advance(30_000);
        await flush();
        expect(session.state).toBe(action === "stop" ? "stopped" : "live");
        expect(connect).toHaveBeenCalledTimes(callsBeforeAdvance);
        expect(failures).toEqual([]);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", observeUnhandled);
      }
    }
  });

  it("keeps literal true unauthorized decisions immediate and preserves default matching only when the classifier is absent", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      reconnectDelayMs: () => 11,
      isUnauthorizedError: () => true,
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    connections[0]!.input.onFailure(new Error("ordinary provider failure"));

    expect(session.state).toBe("unauthorized");
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    clock.advance(30_000);
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);

    const defaultClock = new FakeClock();
    const { transport: defaultTransport, connect: defaultConnect, connections: defaultConnections } = createTransport();
    const defaultSession = new RealtimeRoomSession({
      tokenProvider: async () => token(defaultClock.now() + 300_000),
      transport: defaultTransport,
      clock: defaultClock,
    });
    await defaultSession.start({ missionId: "mission-a", roomId: "room-a" });
    defaultConnections[0]!.input.onFailure(new Error("Unauthorized"));
    expect(defaultSession.state).toBe("unauthorized");
    defaultClock.advance(30_000);
    await flush();
    expect(defaultConnect).toHaveBeenCalledTimes(1);

    for (const mode of ["throwing-getter", "nonfunction", "throwing-classifier"] as const) {
      const fallbackClock = new FakeClock();
      const { transport: fallbackTransport, connect: fallbackConnect, connections: fallbackConnections } = createTransport();
      const options: RoomSessionOptions = {
        tokenProvider: async () => token(fallbackClock.now() + 300_000),
        transport: fallbackTransport,
        clock: fallbackClock,
        maxReconnectAttempts: 0,
      };
      Object.defineProperty(options, "isUnauthorizedError", {
        get: () => {
          if (mode === "throwing-getter") throw new Error("classifier getter failure");
          if (mode === "nonfunction") return "not-a-classifier";
          return () => { throw new Error("classifier invocation failure"); };
        },
      });
      const fallbackSession = new RealtimeRoomSession(options);
      await fallbackSession.start({ missionId: "mission-a", roomId: "room-a" });
      fallbackConnections[0]!.input.onFailure(new Error("Unauthorized"));

      expect(fallbackSession.state).toBe("degraded");
      expect(fallbackConnections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
      fallbackClock.advance(30_000);
      await flush();
      expect(fallbackConnect).toHaveBeenCalledTimes(1);
    }
  });

  it("treats runtime promise and thenable classifier results as false without awaiting or leaking their rejection", async () => {
    const providerSecret = "classifier-thenable-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const lateDecision = deferred<boolean>();
      const decisions = [
        () => Promise.reject(new Error(providerSecret)),
        () => Object.defineProperty({}, "then", { get: () => { throw new Error(providerSecret); } }),
        () => lateDecision.promise,
      ];
      for (const classifier of decisions) {
        const clock = new FakeClock();
        const { transport, connect } = createTransport([new Error("connection failed"), "success"]);
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          reconnectDelayMs: () => 11,
          onTransportFailure: (error) => failures.push(error),
          isUnauthorizedError: classifier as unknown as (error: unknown) => boolean,
        });

        await session.start({ missionId: "mission-a", roomId: "room-a" });
        expect(session.state).toBe("degraded");
        expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
        expect(String(failures[0])).not.toContain(providerSecret);

        if (classifier === decisions[2]) lateDecision.reject(new Error(providerSecret));
        await new Promise((resolve) => setTimeout(resolve, 0));
        clock.advance(11);
        await vi.waitFor(() => expect(session.state).toBe("live"));
        expect(connect).toHaveBeenCalledTimes(2);
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("contains hostile Error-prototype values under the absent-classifier default without interrupting ordinary failure recovery", async () => {
    const providerSecret = "hostile-default-classifier-secret";
    const hostileErrors = [
      Object.defineProperties(Object.create(Error.prototype), {
        name: { get: () => { throw new Error(providerSecret); } },
        message: { value: "ordinary failure" },
      }),
      Object.defineProperties(Object.create(Error.prototype), {
        name: { value: "OrdinaryError" },
        message: { get: () => { throw new Error(providerSecret); } },
      }),
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const hostileError of hostileErrors) {
        const clock = new FakeClock();
        const { transport, connect, connections } = createTransport();
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          maxReconnectAttempts: 0,
          onTransportFailure: (error) => failures.push(error),
        });
        await session.start({ missionId: "mission-a", roomId: "room-a" });

        expect(() => connections[0]!.input.onFailure(hostileError)).not.toThrow();
        expect(session.state).toBe("degraded");
        expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBe(hostileError);

        clock.advance(30_000);
        await flush();
        expect(session.state).toBe("degraded");
        expect(connect).toHaveBeenCalledTimes(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("captures mandatory token and transport dependencies once with their original receivers despite later replacement", async () => {
    const clock = new FakeClock();
    const tokenReceivers: unknown[] = [];
    const connectReceivers: unknown[] = [];
    const originalTokenProvider = vi.fn(function (this: unknown) {
      tokenReceivers.push(this);
      return Promise.resolve(token(clock.now() + 300_000));
    });
    const originalConnect = vi.fn(function (this: unknown) {
      connectReceivers.push(this);
      return Promise.resolve({ unsubscribe: () => undefined });
    });
    const capturedTransport = {};
    let tokenProvider: unknown = originalTokenProvider;
    let transport: unknown = capturedTransport;
    let tokenProviderReads = 0;
    let transportReads = 0;
    let connectReads = 0;
    const options = { clock } as unknown as RoomSessionOptions;
    Object.defineProperty(options, "tokenProvider", {
      get: () => {
        tokenProviderReads += 1;
        return tokenProvider;
      },
    });
    Object.defineProperty(options, "transport", {
      get: () => {
        transportReads += 1;
        return transport;
      },
    });
    Object.defineProperty(capturedTransport, "connect", {
      get: () => {
        connectReads += 1;
        return originalConnect;
      },
    });

    const session = new RealtimeRoomSession(options);
    const replacementTokenProvider = vi.fn(async () => { throw new Error("replacement token provider must stay unused"); });
    const replacementConnect = vi.fn(async () => { throw new Error("replacement transport must stay unused"); });
    tokenProvider = replacementTokenProvider;
    transport = { connect: replacementConnect };
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    await session.refresh();

    expect(session.state).toBe("live");
    expect(tokenProviderReads).toBe(1);
    expect(transportReads).toBe(1);
    expect(connectReads).toBe(1);
    expect(originalTokenProvider).toHaveBeenCalledTimes(2);
    expect(originalConnect).toHaveBeenCalledTimes(2);
    expect(tokenReceivers).toEqual([options, options]);
    expect(connectReceivers).toEqual([capturedTransport, capturedTransport]);
    expect(replacementTokenProvider).not.toHaveBeenCalled();
    expect(replacementConnect).not.toHaveBeenCalled();
  });

  it("contains missing, nonfunction, and hostile mandatory dependency getters without activation or leaked provider detail", async () => {
    const providerSecret = "mandatory-dependency-secret";
    const modes = [
      "token-missing",
      "token-nonfunction",
      "token-throwing-getter",
      "transport-missing",
      "transport-nonfunction",
      "transport-throwing-getter",
      "connect-missing",
      "connect-nonfunction",
      "connect-throwing-getter",
    ] as const;
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const mode of modes) {
        const clock = new FakeClock();
        const failures: unknown[] = [];
        const connect = vi.fn(async () => ({ unsubscribe: () => undefined }));
        const validTransport = { connect };
        const options = {
          clock,
          maxReconnectAttempts: 0,
          onTransportFailure: (error: unknown) => failures.push(error),
        } as unknown as RoomSessionOptions;

        if (!mode.startsWith("token-missing")) {
          Object.defineProperty(options, "tokenProvider", {
            get: () => {
              if (mode === "token-nonfunction") return providerSecret;
              if (mode === "token-throwing-getter") throw new Error(providerSecret);
              return async () => token(clock.now() + 300_000);
            },
          });
        }
        if (!mode.startsWith("transport-missing")) {
          Object.defineProperty(options, "transport", {
            get: () => {
              if (mode === "transport-nonfunction") return providerSecret;
              if (mode === "transport-throwing-getter") throw new Error(providerSecret);
              if (mode.startsWith("connect-")) {
                const hostileTransport = {};
                if (mode !== "connect-missing") {
                  Object.defineProperty(hostileTransport, "connect", {
                    get: () => {
                      if (mode === "connect-nonfunction") return providerSecret;
                      throw new Error(providerSecret);
                    },
                  });
                }
                return hostileTransport;
              }
              return validTransport;
            },
          });
        }

        let session: RealtimeRoomSession | undefined;
        expect(() => { session = new RealtimeRoomSession(options); }).not.toThrow();
        await session!.start({ missionId: "mission-a", roomId: "room-a" });

        expect(session!.state).toBe("degraded");
        expect(connect).not.toHaveBeenCalled();
        expect(failures).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Realtime /) })]);
        expect(String(failures[0])).not.toContain(providerSecret);
        clock.advance(30_000);
        await flush();
        expect(session!.state).toBe("degraded");
        expect(connect).not.toHaveBeenCalled();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("lets a captured token provider stop the session without opening a transport connection or leaving a stale retry", async () => {
    const clock = new FakeClock();
    const connect = vi.fn(async () => ({ unsubscribe: () => undefined }));
    const options = {
      clock,
      tokenProvider: () => {
        void session.stop();
        return Promise.resolve(token(clock.now() + 300_000));
      },
      transport: { connect },
    } as RoomSessionOptions;
    const session = new RealtimeRoomSession(options);

    await session.start({ missionId: "mission-a", roomId: "room-a" });

    expect(session.state).toBe("stopped");
    expect(session.scope).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    clock.advance(30_000);
    await flush();
    expect(session.state).toBe("stopped");
    expect(connect).not.toHaveBeenCalled();
  });

  it("lets a captured connect function hand off exactly once, disposing its old candidate before only the new room goes live", async () => {
    const clock = new FakeClock();
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    const oldSubscription = { unsubscribe: vi.fn(() => undefined) };
    const newSubscription = { unsubscribe: vi.fn(() => undefined) };
    const connectReceivers: unknown[] = [];
    const capturedTransport = {};
    let connectReads = 0;
    const originalConnect = vi.fn(function (this: unknown, input: Parameters<RealtimeTransportAdapter["connect"]>[0]) {
      connectReceivers.push(this);
      if (input.scope.roomId === oldScope.roomId) {
        void session.start(newScope);
        return Promise.resolve(oldSubscription);
      }
      return Promise.resolve(newSubscription);
    });
    Object.defineProperty(capturedTransport, "connect", {
      get: () => {
        connectReads += 1;
        return originalConnect;
      },
    });
    const options = {
      clock,
      tokenProvider: async () => token(clock.now() + 300_000),
      transport: capturedTransport,
    } as unknown as RoomSessionOptions;
    const session = new RealtimeRoomSession(options);

    await session.start(oldScope);
    await vi.waitFor(() => expect(session.state).toBe("live"));

    expect(session.scope).toEqual(newScope);
    expect(originalConnect).toHaveBeenCalledTimes(2);
    expect(connectReads).toBe(1);
    expect(connectReceivers).toEqual([capturedTransport, capturedTransport]);
    expect(oldSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(newSubscription.unsubscribe).not.toHaveBeenCalled();
    clock.advance(30_000);
    await flush();
    expect(session.state).toBe("live");
    expect(session.scope).toEqual(newScope);
    expect(originalConnect).toHaveBeenCalledTimes(2);
    expect(oldSubscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("contains hostile and late-rejecting captured token providers after stop or exact handoff", async () => {
    const providerSecret = "captured-token-provider-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const hostileClock = new FakeClock();
      const hostileConnect = vi.fn(async () => ({ unsubscribe: () => undefined }));
      const hostileOptions = {
        clock: hostileClock,
        maxReconnectAttempts: 0,
        tokenProvider: () => Object.defineProperty({}, "then", {
          get: () => { throw new Error(providerSecret); },
        }),
        transport: { connect: hostileConnect },
      } as unknown as RoomSessionOptions;
      const hostileSession = new RealtimeRoomSession(hostileOptions);
      await hostileSession.start({ missionId: "mission-a", roomId: "room-a" });
      expect(hostileSession.state).toBe("degraded");
      expect(hostileConnect).not.toHaveBeenCalled();

      for (const action of ["stop", "handoff"] as const) {
        const clock = new FakeClock();
        const oldToken = deferred<RealtimeToken>();
        const oldScope = { missionId: "mission-a", roomId: "room-a" };
        const newScope = { missionId: "mission-a", roomId: "room-b" };
        const connect = vi.fn(async () => ({ unsubscribe: () => undefined }));
        const session = new RealtimeRoomSession({
          clock,
          tokenProvider: (scope) => scope.roomId === oldScope.roomId
            ? oldToken.promise
            : Promise.resolve(token(clock.now() + 300_000)),
          transport: { connect },
        });
        void session.start(oldScope);
        await flush();
        expect(connect).not.toHaveBeenCalled();

        if (action === "stop") await session.stop();
        else await session.start(newScope);
        await vi.waitFor(() => expect(session.state).toBe(action === "stop" ? "stopped" : "live"));
        oldToken.reject(new Error(providerSecret));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(session.state).toBe(action === "stop" ? "stopped" : "live");
        expect(connect).toHaveBeenCalledTimes(action === "stop" ? 0 : 1);
        if (action === "handoff") expect(session.scope).toEqual(newScope);
        clock.advance(30_000);
        await flush();
        expect(connect).toHaveBeenCalledTimes(action === "stop" ? 0 : 1);
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("contains hostile and late-rejecting captured connect results after stop or exact handoff", async () => {
    const providerSecret = "captured-connect-provider-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const hostileClock = new FakeClock();
      const hostileOptions = {
        clock: hostileClock,
        maxReconnectAttempts: 0,
        tokenProvider: async () => token(hostileClock.now() + 300_000),
        transport: {
          connect: () => Object.defineProperty({}, "then", {
            get: () => { throw new Error(providerSecret); },
          }),
        },
      } as unknown as RoomSessionOptions;
      const hostileSession = new RealtimeRoomSession(hostileOptions);
      await hostileSession.start({ missionId: "mission-a", roomId: "room-a" });
      expect(hostileSession.state).toBe("degraded");

      for (const action of ["stop", "handoff"] as const) {
        const clock = new FakeClock();
        const oldConnection = deferred<RealtimeTransportSubscription>();
        const oldScope = { missionId: "mission-a", roomId: "room-a" };
        const newScope = { missionId: "mission-a", roomId: "room-b" };
        const newSubscription = { unsubscribe: vi.fn(() => undefined) };
        const connect = vi.fn((input: Parameters<RealtimeTransportAdapter["connect"]>[0]) => input.scope.roomId === oldScope.roomId
          ? oldConnection.promise
          : Promise.resolve(newSubscription));
        const session = new RealtimeRoomSession({
          clock,
          tokenProvider: async () => token(clock.now() + 300_000),
          transport: { connect },
        });
        void session.start(oldScope);
        await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

        if (action === "stop") await session.stop();
        else await session.start(newScope);
        await vi.waitFor(() => expect(session.state).toBe(action === "stop" ? "stopped" : "live"));
        oldConnection.reject(new Error(providerSecret));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(session.state).toBe(action === "stop" ? "stopped" : "live");
        expect(connect).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
        if (action === "handoff") expect(session.scope).toEqual(newScope);
        clock.advance(30_000);
        await flush();
        expect(connect).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("reuses captured dependencies for a scheduled recovery after mutation rather than reading replacements", async () => {
    const clock = new FakeClock();
    const tokenReceivers: unknown[] = [];
    const connectReceivers: unknown[] = [];
    const inputs: Array<Parameters<RealtimeTransportAdapter["connect"]>[0]> = [];
    const originalTokenProvider = vi.fn(function (this: unknown) {
      tokenReceivers.push(this);
      return Promise.resolve(token(clock.now() + 300_000));
    });
    const originalConnect = vi.fn(function (this: unknown, input: Parameters<RealtimeTransportAdapter["connect"]>[0]) {
      connectReceivers.push(this);
      inputs.push(input);
      return Promise.resolve({ unsubscribe: vi.fn(() => undefined) });
    });
    const capturedTransport = {};
    let tokenProvider: unknown = originalTokenProvider;
    let transport: unknown = capturedTransport;
    let tokenProviderReads = 0;
    let transportReads = 0;
    let connectReads = 0;
    const options = { clock, reconnectDelayMs: () => 11 } as unknown as RoomSessionOptions;
    Object.defineProperty(options, "tokenProvider", {
      get: () => {
        tokenProviderReads += 1;
        return tokenProvider;
      },
    });
    Object.defineProperty(options, "transport", {
      get: () => {
        transportReads += 1;
        return transport;
      },
    });
    Object.defineProperty(capturedTransport, "connect", {
      get: () => {
        connectReads += 1;
        return originalConnect;
      },
    });
    const session = new RealtimeRoomSession(options);
    const replacementTokenProvider = vi.fn(async () => { throw new Error("replacement token provider must stay unused"); });
    const replacementConnect = vi.fn(async () => { throw new Error("replacement transport must stay unused"); });
    tokenProvider = replacementTokenProvider;
    transport = { connect: replacementConnect };

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    inputs[0]!.onFailure(new Error("ordinary failure"));
    expect(session.state).toBe("degraded");
    clock.advance(11);
    await vi.waitFor(() => expect(session.state).toBe("live"));

    expect(tokenProviderReads).toBe(1);
    expect(transportReads).toBe(1);
    expect(connectReads).toBe(1);
    expect(originalTokenProvider).toHaveBeenCalledTimes(2);
    expect(originalConnect).toHaveBeenCalledTimes(2);
    expect(tokenReceivers).toEqual([options, options]);
    expect(connectReceivers).toEqual([capturedTransport, capturedTransport]);
    expect(replacementTokenProvider).not.toHaveBeenCalled();
    expect(replacementConnect).not.toHaveBeenCalled();
  });

  it("expires accepted transient messages on their visibility deadline", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const expired: RealtimeEnvelope[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      onTransientMessageExpired: (value) => expired.push(value),
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const shortLived = message(clock, { messageId: "short-lived", expiresAtMs: clock.now() + 500 });
    connections[0]!.input.onMessage(shortLived);

    clock.advance(500);

    expect(expired).toEqual([shortLived]);
  });

  it("is idempotent to start and stop, clears offline timers, and never reconnects after stop", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const cleared: string[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 60_000),
      transport,
      clock,
      onTransientStateCleared: (reason) => cleared.push(reason),
    });
    const scope = { missionId: "mission-a", roomId: "room-a" };

    await session.start(scope);
    await session.start(scope);
    expect(connect).toHaveBeenCalledTimes(1);
    connections[0]!.input.onFailure(new Error("offline"));
    expect(session.state).toBe("degraded");

    await session.stop();
    await session.stop();
    clock.advance(60_000);
    await flush();

    expect(session.state).toBe("stopped");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(cleared).toContain("stopped");
  });
});
