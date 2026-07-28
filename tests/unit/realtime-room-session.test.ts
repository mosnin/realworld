import { describe, expect, it, vi } from "vitest";

import { RealtimePublishRateLimitError } from "../../lib/realtime/signal-governor";
import {
  RealtimeRoomSession,
  validateRealtimeEnvelope,
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

  it("captures one receiver-bound clock across start, refresh, recovery, expiry, and cleanup despite later mutation", async () => {
    const backingClock = new FakeClock();
    const nowReceivers: unknown[] = [];
    const setReceivers: unknown[] = [];
    const clearReceivers: unknown[] = [];
    const originalNow = function (this: unknown) {
      nowReceivers.push(this);
      return backingClock.now();
    };
    const originalSetTimeout = function (this: unknown, callback: () => void, delayMs: number) {
      setReceivers.push(this);
      return backingClock.setTimeout(callback, delayMs);
    };
    const originalClearTimeout = function (this: unknown, timer: ReturnType<typeof setTimeout>) {
      clearReceivers.push(this);
      return backingClock.clearTimeout(timer);
    };
    const capturedClock = {};
    let nowMethod: unknown = originalNow;
    let setTimeoutMethod: unknown = originalSetTimeout;
    let clearTimeoutMethod: unknown = originalClearTimeout;
    let nowReads = 0;
    let setTimeoutReads = 0;
    let clearTimeoutReads = 0;
    Object.defineProperty(capturedClock, "now", {
      get: () => {
        nowReads += 1;
        return nowMethod;
      },
    });
    Object.defineProperty(capturedClock, "setTimeout", {
      get: () => {
        setTimeoutReads += 1;
        return setTimeoutMethod;
      },
    });
    Object.defineProperty(capturedClock, "clearTimeout", {
      get: () => {
        clearTimeoutReads += 1;
        return clearTimeoutMethod;
      },
    });
    let clock: unknown = capturedClock;
    let clockReads = 0;
    const options = {
      reconnectDelayMs: () => 11,
      tokenProvider: async () => token(backingClock.now() + 300_000),
    } as unknown as RoomSessionOptions;
    Object.defineProperty(options, "clock", {
      get: () => {
        clockReads += 1;
        return clock;
      },
    });
    const { transport, connect, connections } = createTransport();
    Object.defineProperty(options, "transport", { value: transport });
    const expired: RealtimeEnvelope[] = [];
    Object.defineProperty(options, "onTransientMessageExpired", { value: (value: RealtimeEnvelope) => expired.push(value) });

    const session = new RealtimeRoomSession(options);
    const replacementClock = {
      now: vi.fn(() => { throw new Error("replacement clock must stay unused"); }),
      setTimeout: vi.fn(() => { throw new Error("replacement clock must stay unused"); }),
      clearTimeout: vi.fn(() => { throw new Error("replacement clock must stay unused"); }),
    };
    clock = replacementClock;
    nowMethod = replacementClock.now;
    setTimeoutMethod = replacementClock.setTimeout;
    clearTimeoutMethod = replacementClock.clearTimeout;

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    await session.refresh();
    connections[1]!.input.onFailure(new Error("ordinary failure"));
    expect(session.state).toBe("degraded");
    backingClock.advance(11);
    await vi.waitFor(() => expect(session.state).toBe("live"));
    const expiring = message(backingClock, { messageId: "captured-clock-expiry", expiresAtMs: backingClock.now() + 6 });
    connections[2]!.input.onMessage(expiring);
    backingClock.advance(6);
    await flush();
    await session.stop();

    expect(clockReads).toBe(1);
    expect(nowReads).toBe(1);
    expect(setTimeoutReads).toBe(1);
    expect(clearTimeoutReads).toBe(1);
    expect(nowReceivers.every((receiver) => receiver === capturedClock)).toBe(true);
    expect(setReceivers.every((receiver) => receiver === capturedClock)).toBe(true);
    expect(clearReceivers.every((receiver) => receiver === capturedClock)).toBe(true);
    expect(nowReceivers.length).toBeGreaterThan(0);
    expect(setReceivers.length).toBeGreaterThan(0);
    expect(clearReceivers.length).toBeGreaterThan(0);
    expect(replacementClock.now).not.toHaveBeenCalled();
    expect(replacementClock.setTimeout).not.toHaveBeenCalled();
    expect(replacementClock.clearTimeout).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(expired).toEqual([expiring]);
  });

  it("falls back safely from absent, malformed, and hostile clock surfaces without leaking or retaining session work", async () => {
    const providerSecret = "hostile-clock-secret";
    const modes = [
      "absent",
      "nonrecord",
      "throwing-clock-getter",
      "missing-methods",
      "throwing-now-getter",
      "throwing-set-timeout-getter",
      "throwing-clear-timeout-getter",
    ] as const;
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const mode of modes) {
        const { transport, connect } = createTransport();
        const failures: unknown[] = [];
        const options = {
          tokenProvider: async () => token(Date.now() + 300_000),
          transport,
          onTransportFailure: (error: unknown) => failures.push(error),
        } as RoomSessionOptions;
        if (mode !== "absent") {
          Object.defineProperty(options, "clock", {
            get: () => {
              if (mode === "nonrecord") return providerSecret;
              if (mode === "throwing-clock-getter") throw new Error(providerSecret);
              if (mode === "missing-methods") return {};
              const hostileClock = {};
              Object.defineProperty(hostileClock, "now", mode === "throwing-now-getter"
                ? { get: () => { throw new Error(providerSecret); } }
                : { value: () => Date.now() });
              Object.defineProperty(hostileClock, "setTimeout", mode === "throwing-set-timeout-getter"
                ? { get: () => { throw new Error(providerSecret); } }
                : { value: setTimeout });
              Object.defineProperty(hostileClock, "clearTimeout", mode === "throwing-clear-timeout-getter"
                ? { get: () => { throw new Error(providerSecret); } }
                : { value: clearTimeout });
              return hostileClock;
            },
          });
        }

        let session: RealtimeRoomSession | undefined;
        expect(() => { session = new RealtimeRoomSession(options); }).not.toThrow();
        await session!.start({ missionId: "mission-a", roomId: "room-a" });
        expect(session!.state).toBe("live");
        await session!.stop();
        expect(session!.state).toBe("stopped");
        expect(connect).toHaveBeenCalledTimes(1);
        expect(failures).toEqual([]);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("captures each operation-timeout option once and ignores post-construction mutation", async () => {
    const providerSecret = "timeout-option-mutation-secret";
    const timeoutOptions = [
      "tokenAcquisitionTimeoutMs",
      "transportConnectionTimeoutMs",
      "transportDisposalTimeoutMs",
      "transportPublishTimeoutMs",
    ] as const;
    type TimeoutOption = typeof timeoutOptions[number];
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const reads: Record<TimeoutOption, number> = {
      tokenAcquisitionTimeoutMs: 0,
      transportConnectionTimeoutMs: 0,
      transportDisposalTimeoutMs: 0,
      transportPublishTimeoutMs: 0,
    };
    const values: Record<TimeoutOption, unknown> = {
      tokenAcquisitionTimeoutMs: 3,
      transportConnectionTimeoutMs: 4,
      transportDisposalTimeoutMs: 5,
      transportPublishTimeoutMs: 6,
    };
    const options = {
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
    } as unknown as RoomSessionOptions;
    for (const property of timeoutOptions) {
      Object.defineProperty(options, property, {
        get: () => {
          reads[property] += 1;
          return values[property];
        },
      });
    }
    const session = new RealtimeRoomSession(options);
    for (const property of timeoutOptions) values[property] = providerSecret;

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    await expect(session.publish(message(clock))).resolves.toBe(true);
    await session.stop();

    expect(reads).toEqual({
      tokenAcquisitionTimeoutMs: 1,
      transportConnectionTimeoutMs: 1,
      transportDisposalTimeoutMs: 1,
      transportPublishTimeoutMs: 1,
    });
    expect(clock.delays).toEqual(expect.arrayContaining([3, 4, 5, 6]));
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("contains malformed, hostile, nonfinite, default, and bounded operation-timeout captures", async () => {
    const providerSecret = "hostile-timeout-option-secret";
    const timeoutOptions = [
      "tokenAcquisitionTimeoutMs",
      "transportConnectionTimeoutMs",
      "transportDisposalTimeoutMs",
      "transportPublishTimeoutMs",
    ] as const;
    type TimeoutOption = typeof timeoutOptions[number];
    const hostileValue = {};
    Object.defineProperty(hostileValue, "valueOf", {
      get: () => { throw new Error(providerSecret); },
    });
    const cases: Array<{ label: string; value: unknown; expected: number }> = [
      { label: "default", value: undefined, expected: 10_000 },
      { label: "malformed", value: providerSecret, expected: 10_000 },
      { label: "hostile-value", value: hostileValue, expected: 10_000 },
      { label: "nan", value: Number.NaN, expected: 10_000 },
      { label: "infinite", value: Number.POSITIVE_INFINITY, expected: 10_000 },
      { label: "negative", value: -1, expected: 1 },
      { label: "zero", value: 0, expected: 1 },
      { label: "fractional", value: 2.9, expected: 2 },
      { label: "oversized", value: 99_999, expected: 30_000 },
      { label: "throwing-getter", value: undefined, expected: 10_000 },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const { label, value, expected } of cases) {
        const clock = new FakeClock();
        const { transport, connections } = createTransport();
        const reads: Record<TimeoutOption, number> = {
          tokenAcquisitionTimeoutMs: 0,
          transportConnectionTimeoutMs: 0,
          transportDisposalTimeoutMs: 0,
          transportPublishTimeoutMs: 0,
        };
        const failures: unknown[] = [];
        const options = {
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          onTransportFailure: (error: unknown) => failures.push(error),
        } as unknown as RoomSessionOptions;
        for (const property of timeoutOptions) {
          Object.defineProperty(options, property, {
            get: () => {
              reads[property] += 1;
              if (label === "throwing-getter") throw new Error(providerSecret);
              return value;
            },
          });
        }
        let session: RealtimeRoomSession | undefined;
        expect(() => { session = new RealtimeRoomSession(options); }).not.toThrow();

        await session!.start({ missionId: "mission-a", roomId: "room-a" });
        await expect(session!.publish(message(clock))).resolves.toBe(true);
        await session!.stop();
        expect(reads).toEqual({
          tokenAcquisitionTimeoutMs: 1,
          transportConnectionTimeoutMs: 1,
          transportDisposalTimeoutMs: 1,
          transportPublishTimeoutMs: 1,
        });
        expect(clock.delays.filter((delay) => delay === expected)).toHaveLength(4);
        expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(failures).toEqual([]);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("contains rejected Promise and hostile-then timeout getter results with one-shot default capture", async () => {
    const providerSecret = "async-timeout-option-secret";
    const timeoutOptions = [
      "tokenAcquisitionTimeoutMs",
      "transportConnectionTimeoutMs",
      "transportDisposalTimeoutMs",
      "transportPublishTimeoutMs",
    ] as const;
    type TimeoutOption = typeof timeoutOptions[number];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const mode of ["rejected-promise", "hostile-then"] as const) {
        const clock = new FakeClock();
        const { transport, connections } = createTransport();
        const reads: Record<TimeoutOption, number> = {
          tokenAcquisitionTimeoutMs: 0,
          transportConnectionTimeoutMs: 0,
          transportDisposalTimeoutMs: 0,
          transportPublishTimeoutMs: 0,
        };
        let thenReads = 0;
        const failures: unknown[] = [];
        const options = {
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          onTransportFailure: (error: unknown) => failures.push(error),
        } as unknown as RoomSessionOptions;
        for (const property of timeoutOptions) {
          Object.defineProperty(options, property, {
            get: () => {
              reads[property] += 1;
              if (mode === "rejected-promise") return Promise.reject(new Error(providerSecret));
              const hostileThenable = {};
              Object.defineProperty(hostileThenable, "then", {
                get: () => {
                  thenReads += 1;
                  throw new Error(providerSecret);
                },
              });
              return hostileThenable;
            },
          });
        }
        const session = new RealtimeRoomSession(options);

        await session.start({ missionId: "mission-a", roomId: "room-a" });
        await expect(session.publish(message(clock))).resolves.toBe(true);
        await session.stop();
        expect(reads).toEqual({
          tokenAcquisitionTimeoutMs: 1,
          transportConnectionTimeoutMs: 1,
          transportDisposalTimeoutMs: 1,
          transportPublishTimeoutMs: 1,
        });
        expect(clock.delays.filter((delay) => delay === 10_000)).toHaveLength(4);
        expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(failures).toEqual([]);
        if (mode === "hostile-then") expect(thenReads).toBe(4);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("captures refresh timing controls once, ignores mutation, and refreshes on the captured fake-clock deadline", async () => {
    const providerSecret = "refresh-timing-mutation-secret";
    const clock = new FakeClock();
    const { transport, connect } = createTransport();
    const tokenProvider = vi.fn(async () => token(clock.now() + 10_000));
    const reads = { refreshSkewMs: 0, minimumRefreshDelayMs: 0 };
    let refreshSkewMs: unknown = 3_000;
    let minimumRefreshDelayMs: unknown = 400;
    const options = { tokenProvider, transport, clock } as unknown as RoomSessionOptions;
    Object.defineProperties(options, {
      refreshSkewMs: {
        get: () => {
          reads.refreshSkewMs += 1;
          return refreshSkewMs;
        },
      },
      minimumRefreshDelayMs: {
        get: () => {
          reads.minimumRefreshDelayMs += 1;
          return minimumRefreshDelayMs;
        },
      },
    });
    const session = new RealtimeRoomSession(options);
    refreshSkewMs = providerSecret;
    minimumRefreshDelayMs = providerSecret;

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    expect(clock.delays.at(-1)).toBe(7_000);
    clock.advance(7_000);
    await vi.waitFor(() => expect(tokenProvider).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));

    expect(reads).toEqual({ refreshSkewMs: 1, minimumRefreshDelayMs: 1 });
    await session.stop();
  });

  it("contains malformed, hostile, async, and bounded refresh timing options while preserving actual scheduling semantics", async () => {
    const providerSecret = "hostile-refresh-timing-secret";
    const cases: Array<{
      label: string;
      refreshSkewMs?: unknown;
      minimumRefreshDelayMs?: unknown;
      expected: number;
    }> = [
      { label: "default", expected: 1_000 },
      { label: "malformed", refreshSkewMs: providerSecret, minimumRefreshDelayMs: providerSecret, expected: 1_000 },
      { label: "nan", refreshSkewMs: Number.NaN, minimumRefreshDelayMs: Number.NaN, expected: 1_000 },
      { label: "infinite", refreshSkewMs: Number.POSITIVE_INFINITY, minimumRefreshDelayMs: Number.POSITIVE_INFINITY, expected: 1_000 },
      { label: "negative-skew", refreshSkewMs: -1, minimumRefreshDelayMs: 400, expected: 10_000 },
      { label: "zero-minimum", refreshSkewMs: 9_999, minimumRefreshDelayMs: 0, expected: 1 },
      { label: "fractional", refreshSkewMs: 2_500.5, minimumRefreshDelayMs: 10.5, expected: 7_499.5 },
      { label: "throwing-getter", expected: 1_000 },
      { label: "rejected-promise", expected: 1_000 },
      { label: "hostile-then", expected: 1_000 },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const { label, refreshSkewMs, minimumRefreshDelayMs, expected } of cases) {
        const clock = new FakeClock();
        const { transport } = createTransport();
        const reads = { refreshSkewMs: 0, minimumRefreshDelayMs: 0 };
        const failures: unknown[] = [];
        let thenReads = 0;
        const options = {
          tokenProvider: async () => token(clock.now() + 10_000),
          transport,
          clock,
          onTransportFailure: (error: unknown) => failures.push(error),
        } as unknown as RoomSessionOptions;
        for (const property of ["refreshSkewMs", "minimumRefreshDelayMs"] as const) {
          Object.defineProperty(options, property, {
            get: () => {
              reads[property] += 1;
              if (label === "throwing-getter") throw new Error(providerSecret);
              if (label === "rejected-promise") return Promise.reject(new Error(providerSecret));
              if (label === "hostile-then") {
                const hostileThenable = {};
                Object.defineProperty(hostileThenable, "then", {
                  get: () => {
                    thenReads += 1;
                    throw new Error(providerSecret);
                  },
                });
                return hostileThenable;
              }
              return property === "refreshSkewMs" ? refreshSkewMs : minimumRefreshDelayMs;
            },
          });
        }
        let session: RealtimeRoomSession | undefined;
        expect(() => { session = new RealtimeRoomSession(options); }).not.toThrow();

        await session!.start({ missionId: "mission-a", roomId: "room-a" });
        expect(clock.delays.at(-1)).toBe(expected);
        expect(reads).toEqual({ refreshSkewMs: 1, minimumRefreshDelayMs: 1 });
        if (label === "hostile-then") expect(thenReads).toBe(2);
        expect(failures).toEqual([]);
        await session!.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("captures maxReconnectAttempts once, ignores mutation, and exhausts the captured retry budget", async () => {
    const providerSecret = "retry-budget-mutation-secret";
    const clock = new FakeClock();
    const failure = new Error("ordinary failure");
    const { transport, connect } = createTransport([failure, failure, "success"]);
    let reads = 0;
    let maxReconnectAttempts: unknown = 1;
    const options = {
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      reconnectDelayMs: () => 11,
    } as unknown as RoomSessionOptions;
    Object.defineProperty(options, "maxReconnectAttempts", {
      get: () => {
        reads += 1;
        return maxReconnectAttempts;
      },
    });
    const session = new RealtimeRoomSession(options);
    maxReconnectAttempts = providerSecret;

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    expect(session.state).toBe("degraded");
    expect(clock.delays).toContain(11);
    clock.advance(11);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    clock.advance(30_000);
    await flush();

    expect(reads).toBe(1);
    expect(session.state).toBe("degraded");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(clock.delays.filter((delay) => delay === 11)).toHaveLength(1);
    await session.stop();
  });

  it("contains hostile, async, and nonfinite retry-budget getters while preserving exact retry exhaustion", async () => {
    const providerSecret = "hostile-retry-budget-secret";
    const cases: Array<{ label: string; value?: unknown; expectedRetries: number }> = [
      { label: "default", expectedRetries: 5 },
      { label: "nan", value: Number.NaN, expectedRetries: 5 },
      { label: "infinite", value: Number.POSITIVE_INFINITY, expectedRetries: 5 },
      { label: "negative", value: -1, expectedRetries: 0 },
      { label: "zero", value: 0, expectedRetries: 0 },
      { label: "fractional", value: 2.9, expectedRetries: 2 },
      { label: "throwing-getter", expectedRetries: 5 },
      { label: "rejected-promise", expectedRetries: 5 },
      { label: "hostile-then", expectedRetries: 5 },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const { label, value, expectedRetries } of cases) {
        const clock = new FakeClock();
        const failures = Array.from({ length: expectedRetries + 2 }, () => new Error("ordinary failure"));
        const { transport, connect } = createTransport(failures);
        const reported: unknown[] = [];
        let reads = 0;
        let thenReads = 0;
        const options = {
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          reconnectDelayMs: () => 11,
          onTransportFailure: (error: unknown) => reported.push(error),
        } as unknown as RoomSessionOptions;
        Object.defineProperty(options, "maxReconnectAttempts", {
          get: () => {
            reads += 1;
            if (label === "throwing-getter") throw new Error(providerSecret);
            if (label === "rejected-promise") return Promise.reject(new Error(providerSecret));
            if (label === "hostile-then") {
              const hostileThenable = {};
              Object.defineProperty(hostileThenable, "then", {
                get: () => {
                  thenReads += 1;
                  throw new Error(providerSecret);
                },
              });
              return hostileThenable;
            }
            return value;
          },
        });
        let session: RealtimeRoomSession | undefined;
        expect(() => { session = new RealtimeRoomSession(options); }).not.toThrow();

        await session!.start({ missionId: "mission-a", roomId: "room-a" });
        for (let attempt = 1; attempt <= expectedRetries; attempt += 1) {
          clock.advance(11);
          await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(attempt + 1));
        }
        clock.advance(30_000);
        await flush();

        expect(reads).toBe(1);
        if (label === "hostile-then") expect(thenReads).toBe(1);
        expect(session!.state).toBe("degraded");
        expect(connect).toHaveBeenCalledTimes(expectedRetries + 1);
        expect(clock.delays.filter((delay) => delay === 11)).toHaveLength(expectedRetries);
        expect(reported).toHaveLength(expectedRetries + 1);
        expect(reported.map(String).join("\n")).not.toContain(providerSecret);
        await session!.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("captures message TTL and future-issued limits once and preserves their exact acceptance boundaries after mutation", async () => {
    const providerSecret = "message-limit-mutation-secret";
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const reads = { maxMessageTtlMs: 0, maxFutureIssuedAtMs: 0 };
    let maxMessageTtlMs: unknown = 10;
    let maxFutureIssuedAtMs: unknown = 5;
    const options = {
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      onMessage: (value: RealtimeEnvelope) => received.push(value),
    } as unknown as RoomSessionOptions;
    Object.defineProperties(options, {
      maxMessageTtlMs: {
        get: () => {
          reads.maxMessageTtlMs += 1;
          return maxMessageTtlMs;
        },
      },
      maxFutureIssuedAtMs: {
        get: () => {
          reads.maxFutureIssuedAtMs += 1;
          return maxFutureIssuedAtMs;
        },
      },
    });
    const session = new RealtimeRoomSession(options);
    maxMessageTtlMs = providerSecret;
    maxFutureIssuedAtMs = providerSecret;

    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const current = clock.now();
    connections[0]!.input.onMessage(message(clock, {
      messageId: "ttl-boundary",
      issuedAtMs: current,
      expiresAtMs: current + 10,
      clientSeq: 1,
    }));
    connections[0]!.input.onMessage(message(clock, {
      messageId: "ttl-over-limit",
      issuedAtMs: current,
      expiresAtMs: current + 11,
      clientSeq: 2,
    }));
    connections[0]!.input.onMessage(message(clock, {
      messageId: "future-boundary",
      issuedAtMs: current + 5,
      expiresAtMs: current + 15,
      clientSeq: 2,
    }));
    connections[0]!.input.onMessage(message(clock, {
      messageId: "future-over-limit",
      issuedAtMs: current + 6,
      expiresAtMs: current + 16,
      clientSeq: 3,
    }));

    expect(reads).toEqual({ maxMessageTtlMs: 1, maxFutureIssuedAtMs: 1 });
    expect(received.map((value) => value.messageId)).toEqual(["ttl-boundary", "future-boundary"]);
    await session.stop();
  });

  it("contains malformed, hostile, async, and bounded message-limit getters with exact accept and reject boundaries", async () => {
    const providerSecret = "hostile-message-limit-secret";
    const cases: Array<{
      label: string;
      maxMessageTtlMs?: unknown;
      maxFutureIssuedAtMs?: unknown;
      acceptedTtl: number;
      rejectedTtl: number;
      acceptedFuture: number;
      rejectedFuture: number;
    }> = [
      { label: "missing", acceptedTtl: 45_000, rejectedTtl: 45_001, acceptedFuture: 5_000, rejectedFuture: 5_001 },
      { label: "malformed", maxMessageTtlMs: providerSecret, maxFutureIssuedAtMs: providerSecret, acceptedTtl: 45_000, rejectedTtl: 45_001, acceptedFuture: 5_000, rejectedFuture: 5_001 },
      { label: "nan", maxMessageTtlMs: Number.NaN, maxFutureIssuedAtMs: Number.NaN, acceptedTtl: 45_000, rejectedTtl: 45_001, acceptedFuture: 5_000, rejectedFuture: 5_001 },
      { label: "infinite", maxMessageTtlMs: Number.POSITIVE_INFINITY, maxFutureIssuedAtMs: Number.POSITIVE_INFINITY, acceptedTtl: 45_000, rejectedTtl: 45_001, acceptedFuture: 5_000, rejectedFuture: 5_001 },
      { label: "negative", maxMessageTtlMs: -1, maxFutureIssuedAtMs: -1, acceptedTtl: 1, rejectedTtl: 2, acceptedFuture: 0, rejectedFuture: 1 },
      { label: "zero", maxMessageTtlMs: 0, maxFutureIssuedAtMs: 0, acceptedTtl: 1, rejectedTtl: 2, acceptedFuture: 0, rejectedFuture: 1 },
      { label: "fractional", maxMessageTtlMs: 2.9, maxFutureIssuedAtMs: 2.9, acceptedTtl: 2, rejectedTtl: 3, acceptedFuture: 2, rejectedFuture: 3 },
      { label: "throwing-getter", acceptedTtl: 45_000, rejectedTtl: 45_001, acceptedFuture: 5_000, rejectedFuture: 5_001 },
      { label: "rejected-promise", acceptedTtl: 45_000, rejectedTtl: 45_001, acceptedFuture: 5_000, rejectedFuture: 5_001 },
      { label: "hostile-then", acceptedTtl: 45_000, rejectedTtl: 45_001, acceptedFuture: 5_000, rejectedFuture: 5_001 },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const { label, maxMessageTtlMs, maxFutureIssuedAtMs, acceptedTtl, rejectedTtl, acceptedFuture, rejectedFuture } of cases) {
        const clock = new FakeClock();
        const { transport, connections } = createTransport();
        const received: RealtimeEnvelope[] = [];
        const failures: unknown[] = [];
        const reads = { maxMessageTtlMs: 0, maxFutureIssuedAtMs: 0 };
        let thenReads = 0;
        const options = {
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          onMessage: (value: RealtimeEnvelope) => received.push(value),
          onTransportFailure: (error: unknown) => failures.push(error),
        } as unknown as RoomSessionOptions;
        for (const property of ["maxMessageTtlMs", "maxFutureIssuedAtMs"] as const) {
          Object.defineProperty(options, property, {
            get: () => {
              reads[property] += 1;
              if (label === "throwing-getter") throw new Error(providerSecret);
              if (label === "rejected-promise") return Promise.reject(new Error(providerSecret));
              if (label === "hostile-then") {
                const hostileThenable = {};
                Object.defineProperty(hostileThenable, "then", {
                  get: () => {
                    thenReads += 1;
                    throw new Error(providerSecret);
                  },
                });
                return hostileThenable;
              }
              return property === "maxMessageTtlMs" ? maxMessageTtlMs : maxFutureIssuedAtMs;
            },
          });
        }
        let session: RealtimeRoomSession | undefined;
        expect(() => { session = new RealtimeRoomSession(options); }).not.toThrow();
        await session!.start({ missionId: "mission-a", roomId: "room-a" });
        const current = clock.now();
        const boundaryTtl = message(clock, {
          messageId: `${label}-ttl-boundary`,
          issuedAtMs: current,
          expiresAtMs: current + acceptedTtl,
          clientSeq: 1,
        });
        const overTtl = message(clock, {
          messageId: `${label}-ttl-over`,
          issuedAtMs: current,
          expiresAtMs: current + rejectedTtl,
          clientSeq: 2,
        });
        const boundaryFuture = message(clock, {
          messageId: `${label}-future-boundary`,
          issuedAtMs: current + acceptedFuture,
          expiresAtMs: current + acceptedFuture + acceptedTtl,
          clientSeq: 2,
        });
        const overFuture = message(clock, {
          messageId: `${label}-future-over`,
          issuedAtMs: current + rejectedFuture,
          expiresAtMs: current + rejectedFuture + acceptedTtl,
          clientSeq: 3,
        });
        connections[0]!.input.onMessage(boundaryTtl);
        connections[0]!.input.onMessage(overTtl);
        connections[0]!.input.onMessage(boundaryFuture);
        connections[0]!.input.onMessage(overFuture);

        expect(reads).toEqual({ maxMessageTtlMs: 1, maxFutureIssuedAtMs: 1 });
        if (label === "hostile-then") expect(thenReads).toBe(2);
        expect(received.map((value) => value.messageId)).toEqual([boundaryTtl.messageId, boundaryFuture.messageId]);
        expect(failures).toEqual([]);
        await session!.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("captures maxSerializedPayloadBytes once and enforces UTF-8 inbound and outbound boundaries after mutation", async () => {
    const providerSecret = "payload-byte-mutation-secret";
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const acceptedPayload = {
      runId: "run-1",
      state: "queued",
      safeSummary: "é",
      durableVersion: 1,
    };
    const overPayload = { ...acceptedPayload, safeSummary: "éé" };
    const acceptedBytes = new TextEncoder().encode(JSON.stringify(acceptedPayload)).byteLength;
    expect(acceptedBytes).toBeGreaterThan(JSON.stringify(acceptedPayload).length);
    let reads = 0;
    let maxSerializedPayloadBytes: unknown = acceptedBytes;
    const options = {
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      onMessage: (value: RealtimeEnvelope) => received.push(value),
    } as unknown as RoomSessionOptions;
    Object.defineProperty(options, "maxSerializedPayloadBytes", {
      get: () => {
        reads += 1;
        return maxSerializedPayloadBytes;
      },
    });
    const session = new RealtimeRoomSession(options);
    maxSerializedPayloadBytes = providerSecret;
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const accepted = message(clock, {
      kind: "agent.public-status",
      messageId: "utf8-accepted",
      clientSeq: 1,
      payload: acceptedPayload,
    });
    const over = message(clock, {
      kind: "agent.public-status",
      messageId: "utf8-over",
      clientSeq: 2,
      payload: overPayload,
    });
    connections[0]!.input.onMessage(accepted);
    connections[0]!.input.onMessage(over);
    await expect(session.publish(accepted)).resolves.toBe(true);
    await expect(session.publish(over)).resolves.toBe(false);

    expect(reads).toBe(1);
    expect(received.map((value) => value.messageId)).toEqual([accepted.messageId]);
    expect(connections[0]!.publish).toHaveBeenCalledTimes(1);
    await session.stop();
  });

  it("contains malformed, hostile, async, and bounded payload-byte getters without leaking provider detail", async () => {
    const providerSecret = "hostile-payload-byte-secret";
    const acceptedPayload = {
      runId: "run-1",
      state: "queued",
      safeSummary: "é",
      durableVersion: 1,
    };
    const acceptedBytes = new TextEncoder().encode(JSON.stringify(acceptedPayload)).byteLength;
    const cases: Array<{ label: string; value?: unknown; acceptsProtocolPayload: boolean }> = [
      { label: "missing", acceptsProtocolPayload: true },
      { label: "malformed", value: providerSecret, acceptsProtocolPayload: true },
      { label: "nan", value: Number.NaN, acceptsProtocolPayload: true },
      { label: "infinite", value: Number.POSITIVE_INFINITY, acceptsProtocolPayload: true },
      { label: "negative", value: -1, acceptsProtocolPayload: false },
      { label: "zero", value: 0, acceptsProtocolPayload: false },
      { label: "fractional", value: 2.5, acceptsProtocolPayload: false },
      { label: "throwing-getter", acceptsProtocolPayload: true },
      { label: "rejected-promise", acceptsProtocolPayload: true },
      { label: "hostile-then", acceptsProtocolPayload: true },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const { label, value, acceptsProtocolPayload } of cases) {
        const clock = new FakeClock();
        const { transport, connections } = createTransport();
        const received: RealtimeEnvelope[] = [];
        const failures: unknown[] = [];
        let reads = 0;
        let thenReads = 0;
        const options = {
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          onMessage: (envelope: RealtimeEnvelope) => received.push(envelope),
          onTransportFailure: (error: unknown) => failures.push(error),
        } as unknown as RoomSessionOptions;
        Object.defineProperty(options, "maxSerializedPayloadBytes", {
          get: () => {
            reads += 1;
            if (label === "throwing-getter") throw new Error(providerSecret);
            if (label === "rejected-promise") return Promise.reject(new Error(providerSecret));
            if (label === "hostile-then") {
              const hostileThenable = {};
              Object.defineProperty(hostileThenable, "then", {
                get: () => {
                  thenReads += 1;
                  throw new Error(providerSecret);
                },
              });
              return hostileThenable;
            }
            return value;
          },
        });
        let session: RealtimeRoomSession | undefined;
        expect(() => { session = new RealtimeRoomSession(options); }).not.toThrow();
        await session!.start({ missionId: "mission-a", roomId: "room-a" });
        const envelope = message(clock, {
          kind: "agent.public-status",
          messageId: `${label}-payload`,
          payload: acceptedPayload,
        });
        connections[0]!.input.onMessage(envelope);
        await expect(session!.publish(envelope)).resolves.toBe(acceptsProtocolPayload);

        expect(reads).toBe(1);
        if (label === "hostile-then") expect(thenReads).toBe(1);
        expect(received).toHaveLength(acceptsProtocolPayload ? 1 : 0);
        expect(connections[0]!.publish).toHaveBeenCalledTimes(acceptsProtocolPayload ? 1 : 0);
        expect(failures).toEqual([]);
        await session!.stop();
      }
      expect(acceptedBytes).toBeGreaterThan(2.5);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("captures message-id capacity once and recovers capacity when captured TTL entries expire", async () => {
    const providerSecret = "tracked-message-mutation-secret";
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const reads = { maxTrackedMessageIds: 0, maxTrackedSenderStreams: 0 };
    let maxTrackedMessageIds: unknown = 2;
    let maxTrackedSenderStreams: unknown = 10;
    const options = {
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      onMessage: (value: RealtimeEnvelope) => received.push(value),
    } as unknown as RoomSessionOptions;
    Object.defineProperties(options, {
      maxTrackedMessageIds: {
        get: () => {
          reads.maxTrackedMessageIds += 1;
          return maxTrackedMessageIds;
        },
      },
      maxTrackedSenderStreams: {
        get: () => {
          reads.maxTrackedSenderStreams += 1;
          return maxTrackedSenderStreams;
        },
      },
    });
    const session = new RealtimeRoomSession(options);
    maxTrackedMessageIds = providerSecret;
    maxTrackedSenderStreams = providerSecret;
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const current = clock.now();
    const first = message(clock, { messageId: "capacity-1", clientSeq: 1, expiresAtMs: current + 5 });
    const second = message(clock, { messageId: "capacity-2", clientSeq: 2, expiresAtMs: current + 5 });
    const third = message(clock, { messageId: "capacity-3", clientSeq: 3, expiresAtMs: current + 5 });
    connections[0]!.input.onMessage(first);
    connections[0]!.input.onMessage(second);
    connections[0]!.input.onMessage(third);
    expect(received.map((value) => value.messageId)).toEqual([first.messageId, second.messageId]);
    clock.advance(5);
    const recovered = message(clock, { ...third, expiresAtMs: clock.now() + 5 });
    connections[0]!.input.onMessage(recovered);

    expect(reads).toEqual({ maxTrackedMessageIds: 1, maxTrackedSenderStreams: 1 });
    expect(received.map((value) => value.messageId)).toEqual([first.messageId, second.messageId, recovered.messageId]);
    await session.stop();
  });

  it("captures sender-stream capacity once and evicts the LRU stream with sequence cleanup", async () => {
    const providerSecret = "tracked-sender-mutation-secret";
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const reads = { maxTrackedMessageIds: 0, maxTrackedSenderStreams: 0 };
    let maxTrackedMessageIds: unknown = 10;
    let maxTrackedSenderStreams: unknown = 2;
    const options = {
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      onMessage: (value: RealtimeEnvelope) => received.push(value),
    } as unknown as RoomSessionOptions;
    Object.defineProperties(options, {
      maxTrackedMessageIds: {
        get: () => {
          reads.maxTrackedMessageIds += 1;
          return maxTrackedMessageIds;
        },
      },
      maxTrackedSenderStreams: {
        get: () => {
          reads.maxTrackedSenderStreams += 1;
          return maxTrackedSenderStreams;
        },
      },
    });
    const session = new RealtimeRoomSession(options);
    maxTrackedMessageIds = providerSecret;
    maxTrackedSenderStreams = providerSecret;
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const sender = (clientId: string) => ({ clientId, clientInstanceId: `${clientId}-tab`, connectionEpoch: 1 });
    const inbound = (messageId: string, clientId: string, clientSeq: number) => message(clock, {
      messageId,
      sender: sender(clientId),
      clientSeq,
    });
    const a1 = inbound("sender-a-1", "sender-a", 10);
    const b1 = inbound("sender-b-1", "sender-b", 10);
    const a2 = inbound("sender-a-2", "sender-a", 11);
    const c1 = inbound("sender-c-1", "sender-c", 1);
    const bAfterEviction = inbound("sender-b-after-eviction", "sender-b", 1);
    for (const envelope of [a1, b1, a2, c1, bAfterEviction]) connections[0]!.input.onMessage(envelope);

    expect(reads).toEqual({ maxTrackedMessageIds: 1, maxTrackedSenderStreams: 1 });
    expect(received.map((value) => value.messageId)).toEqual([a1.messageId, b1.messageId, a2.messageId, c1.messageId, bAfterEviction.messageId]);
    await session.stop();
  });

  it("contains malformed, hostile, async, and bounded receiver-capacity getters without provider leakage", async () => {
    const providerSecret = "hostile-receiver-capacity-secret";
    const cases: Array<{ label: string; value?: unknown; acceptedMessages: number }> = [
      { label: "missing", acceptedMessages: 3 },
      { label: "malformed", value: providerSecret, acceptedMessages: 3 },
      { label: "nan", value: Number.NaN, acceptedMessages: 3 },
      { label: "infinite", value: Number.POSITIVE_INFINITY, acceptedMessages: 3 },
      { label: "negative", value: -1, acceptedMessages: 1 },
      { label: "zero", value: 0, acceptedMessages: 1 },
      { label: "fractional", value: 2.9, acceptedMessages: 2 },
      { label: "oversized", value: 99_999, acceptedMessages: 3 },
      { label: "throwing-getter", acceptedMessages: 3 },
      { label: "rejected-promise", acceptedMessages: 3 },
      { label: "hostile-then", acceptedMessages: 3 },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const { label, value, acceptedMessages } of cases) {
        const clock = new FakeClock();
        const { transport, connections } = createTransport();
        const received: RealtimeEnvelope[] = [];
        const failures: unknown[] = [];
        const reads = { maxTrackedMessageIds: 0, maxTrackedSenderStreams: 0 };
        let thenReads = 0;
        const options = {
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          onMessage: (envelope: RealtimeEnvelope) => received.push(envelope),
          onTransportFailure: (error: unknown) => failures.push(error),
        } as unknown as RoomSessionOptions;
        for (const property of ["maxTrackedMessageIds", "maxTrackedSenderStreams"] as const) {
          Object.defineProperty(options, property, {
            get: () => {
              reads[property] += 1;
              if (label === "throwing-getter") throw new Error(providerSecret);
              if (label === "rejected-promise") return Promise.reject(new Error(providerSecret));
              if (label === "hostile-then") {
                const hostileThenable = {};
                Object.defineProperty(hostileThenable, "then", {
                  get: () => {
                    thenReads += 1;
                    throw new Error(providerSecret);
                  },
                });
                return hostileThenable;
              }
              return value;
            },
          });
        }
        let session: RealtimeRoomSession | undefined;
        expect(() => { session = new RealtimeRoomSession(options); }).not.toThrow();
        await session!.start({ missionId: "mission-a", roomId: "room-a" });
        for (let index = 1; index <= 3; index += 1) {
          connections[0]!.input.onMessage(message(clock, {
            messageId: `${label}-capacity-${index}`,
            clientSeq: index,
          }));
        }

        expect(reads).toEqual({ maxTrackedMessageIds: 1, maxTrackedSenderStreams: 1 });
        if (label === "hostile-then") expect(thenReads).toBe(2);
        expect(received).toHaveLength(acceptedMessages);
        expect(failures).toEqual([]);
        await session!.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("snapshots a valid start scope once and preserves it through provider, transport, publish, refresh, and same-scope dedupe", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const tokenScopes: unknown[] = [];
    const tokenProvider = vi.fn(async (scope: unknown) => {
      tokenScopes.push(scope);
      return token(clock.now() + 300_000);
    });
    let missionId: unknown = "mission-a";
    let roomId: unknown = "room-a";
    const reads = { missionId: 0, roomId: 0 };
    const mutableScope = {} as { missionId: string; roomId: string };
    Object.defineProperties(mutableScope, {
      missionId: {
        get: () => {
          reads.missionId += 1;
          return missionId;
        },
      },
      roomId: {
        get: () => {
          reads.roomId += 1;
          return roomId;
        },
      },
    });
    const session = new RealtimeRoomSession({ tokenProvider, transport, clock });
    await session.start(mutableScope);
    missionId = "provider-secret-mission";
    roomId = "provider-secret-room";
    await expect(session.publish(message(clock))).resolves.toBe(true);
    await session.refresh();
    await session.start({ missionId: "mission-a", roomId: "room-a" });

    expect(reads).toEqual({ missionId: 1, roomId: 1 });
    expect(session.scope).toEqual({ missionId: "mission-a", roomId: "room-a" });
    expect(tokenScopes).toEqual([{ missionId: "mission-a", roomId: "room-a" }, { missionId: "mission-a", roomId: "room-a" }]);
    expect(connect.mock.calls.map(([input]) => input.scope)).toEqual([
      { missionId: "mission-a", roomId: "room-a" },
      { missionId: "mission-a", roomId: "room-a" },
    ]);
    expect(connections).toHaveLength(2);
    expect(connections[1]!.publish).toHaveBeenCalledTimes(0);
    await session.stop();
  });

  it("contains invalid start scopes without invoking providers or tearing down an existing valid live scope", async () => {
    const providerSecret = "hostile-start-scope-secret";
    const cases: Array<{ label: string; value: unknown }> = [
      { label: "missing", value: undefined },
      { label: "malformed", value: 1 },
      { label: "empty", value: "" },
      { label: "symbol", value: Symbol("scope") },
      { label: "throwing", value: undefined },
      { label: "rejected-promise", value: undefined },
      { label: "hostile-then", value: undefined },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const { label, value } of cases) {
        const clock = new FakeClock();
        const { transport, connect, connections } = createTransport();
        const tokenProvider = vi.fn(async () => token(clock.now() + 300_000));
        const session = new RealtimeRoomSession({ tokenProvider, transport, clock });
        await session.start({ missionId: "mission-a", roomId: "room-a" });
        const invalid = {} as { missionId: string; roomId: string };
        Object.defineProperties(invalid, {
          missionId: {
            get: () => {
              if (label === "throwing") throw new Error(providerSecret);
              if (label === "rejected-promise") return Promise.reject(new Error(providerSecret));
              if (label === "hostile-then") {
                const thenable = {};
                Object.defineProperty(thenable, "then", { get: () => { throw new Error(providerSecret); } });
                return thenable;
              }
              return value;
            },
          },
          roomId: { get: () => "room-b" },
        });

        await session.start(invalid);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(session.state).toBe("live");
        expect(session.scope).toEqual({ missionId: "mission-a", roomId: "room-a" });
        expect(tokenProvider).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(connections[0]!.unsubscribe).not.toHaveBeenCalled();
        await session.stop();
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("deduplicates exact valid scopes and hands off one time to a distinct validated scope", async () => {
    const clock = new FakeClock();
    const { transport, connect, connections } = createTransport();
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport, clock });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    await session.start({ missionId: "mission-a", roomId: "room-b" });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(session.scope).toEqual({ missionId: "mission-a", roomId: "room-b" });
    expect(connections[1]!.input.scope).toEqual({ missionId: "mission-a", roomId: "room-b" });
    await session.stop();
  });

  it("canonicalizes hostile envelope getters once into immutable validation and session snapshots", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const received: RealtimeEnvelope[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(clock.now() + 300_000),
      transport,
      clock,
      onMessage: (value) => received.push(value),
    });
    const base = message(clock, { messageId: "canonical-message", clientSeq: 1 });
    const reads: Record<string, number> = {};
    const count = (key: string, value: unknown) => {
      Object.defineProperty(raw, key, { get: () => { reads[key] = (reads[key] ?? 0) + 1; return value; } });
    };
    const raw: Record<string, unknown> = {};
    const sender: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base.sender)) {
      Object.defineProperty(sender, key, { get: () => { const name = `sender.${key}`; reads[name] = (reads[name] ?? 0) + 1; return value; } });
    }
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base.payload as Record<string, unknown>)) {
      Object.defineProperty(payload, key, { enumerable: true, get: () => { const name = `payload.${key}`; reads[name] = (reads[name] ?? 0) + 1; return value; } });
    }
    for (const key of ["v", "kind", "messageId", "missionId", "roomId", "issuedAtMs", "expiresAtMs", "clientSeq"] as const) count(key, base[key]);
    count("sender", sender);
    count("payload", payload);

    const validated = validateRealtimeEnvelope(raw, clock.now());
    expect(validated).toEqual(base);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated!.sender)).toBe(true);
    expect(Object.isFrozen(validated!.payload)).toBe(true);
    expect(Object.values(reads).every((value) => value === 1)).toBe(true);
    const mutable = message(clock, { messageId: "mutable-message", clientSeq: 2 });
    const detached = validateRealtimeEnvelope(mutable, clock.now())!;
    const mutableRecord = mutable as unknown as {
      messageId: string;
      missionId: string;
      sender: { clientId: string };
      payload: { x: number };
    };
    mutableRecord.messageId = "redirected-message";
    mutableRecord.missionId = "redirected-mission";
    mutableRecord.sender.clientId = "redirected-client";
    mutableRecord.payload.x = 0.99;
    expect(detached).toMatchObject({
      messageId: "mutable-message",
      missionId: "mission-a",
      sender: { clientId: "remote-client" },
      payload: { x: 0.5 },
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    connections[0]!.input.onMessage(raw);
    await expect(session.publish(raw as RealtimeEnvelope)).resolves.toBe(true);
    expect(received).toHaveLength(1);
    expect(connections[0]!.publish).toHaveBeenCalledWith(expect.objectContaining({ messageId: base.messageId, missionId: "mission-a" }));
    await session.stop();
  });

  it("fails closed for throwing and asynchronous hostile envelope getters without leaking provider detail", async () => {
    const providerSecret = "hostile-envelope-secret";
    const modes = ["throw", "rejected", "hostile-then"] as const;
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const mode of modes) {
        const clock = new FakeClock();
        const { transport, connections } = createTransport();
        const received: RealtimeEnvelope[] = [];
        const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport, clock, onMessage: (value) => received.push(value) });
        const raw = { ...message(clock, { messageId: `hostile-${mode}` }) } as Record<string, unknown>;
        Object.defineProperty(raw, "messageId", {
          get: () => {
            if (mode === "throw") throw new Error(providerSecret);
            if (mode === "rejected") return Promise.reject(new Error(providerSecret));
            const thenable = {};
            Object.defineProperty(thenable, "then", { get: () => { throw new Error(providerSecret); } });
            return thenable;
          },
        });
        expect(validateRealtimeEnvelope(raw, clock.now())).toBeUndefined();
        await session.start({ missionId: "mission-a", roomId: "room-a" });
        connections[0]!.input.onMessage(raw);
        await expect(session.publish(raw as RealtimeEnvelope)).resolves.toBe(false);
        expect(received).toEqual([]);
        expect(connections[0]!.publish).not.toHaveBeenCalled();
        await session.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("snapshots acquired tokens and nested token requests once into detached immutable transport credentials", async () => {
    const clock = new FakeClock();
    const { transport, connections } = createTransport();
    const reads = { tokenRequest: 0, expiresAt: 0, authorizationVersion: 0, capability: 0 };
    let capability: unknown = "room:read";
    let expiresAt: unknown = clock.now() + 90_000;
    let authorizationVersion: unknown = 1;
    const request = {} as Record<string, unknown>;
    Object.defineProperty(request, "capability", { enumerable: true, get: () => { reads.capability += 1; return capability; } });
    const rawToken = {} as Record<string, unknown>;
    Object.defineProperties(rawToken, {
      tokenRequest: { get: () => { reads.tokenRequest += 1; return request; } },
      expiresAt: { get: () => { reads.expiresAt += 1; return expiresAt; } },
      authorizationVersion: { get: () => { reads.authorizationVersion += 1; return authorizationVersion; } },
    });
    const tokenProvider = vi.fn().mockResolvedValue(rawToken as RealtimeToken);
    const session = new RealtimeRoomSession({ tokenProvider, transport, clock });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const captured = connections[0]!.input.token;
    expect(reads).toEqual({ tokenRequest: 1, expiresAt: 1, authorizationVersion: 1, capability: 1 });
    expect(captured).toEqual({ tokenRequest: { capability: "room:read" }, expiresAt: clock.now() + 90_000, authorizationVersion: 1 });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.tokenRequest)).toBe(true);
    capability = "room:write";
    expiresAt = clock.now() + 180_000;
    authorizationVersion = 2;
    await session.refresh();
    expect(connections[0]!.input.token).toEqual(captured);
    expect(connections[1]!.input.token).toEqual({
      tokenRequest: { capability: "room:write" },
      expiresAt: clock.now() + 180_000,
      authorizationVersion: 2,
    });
    expect(reads).toEqual({ tokenRequest: 2, expiresAt: 2, authorizationVersion: 2, capability: 2 });
    expect(Object.isFrozen(connections[1]!.input.token)).toBe(true);
    expect(Object.isFrozen(connections[1]!.input.token.tokenRequest)).toBe(true);
    await session.stop();
  });

  it("fails closed for hostile token fields and token requests without unhandled provider leakage", async () => {
    const providerSecret = "hostile-token-secret";
    const modes = ["throw", "rejected", "hostile-then", "cyclic"] as const;
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const mode of modes) {
        const clock = new FakeClock();
        const { transport, connect } = createTransport();
        const raw = { tokenRequest: { capability: "read" }, expiresAt: clock.now() + 300_000, authorizationVersion: 1 } as Record<string, unknown>;
        if (mode === "cyclic") { const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; raw.tokenRequest = cyclic; }
        else Object.defineProperty(raw, "tokenRequest", {
          get: () => {
            if (mode === "throw") throw new Error(providerSecret);
            if (mode === "rejected") return Promise.reject(new Error(providerSecret));
            const thenable = {};
            Object.defineProperty(thenable, "then", { get: () => { throw new Error(providerSecret); } });
            return thenable;
          },
        });
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({ tokenProvider: async () => raw as RealtimeToken, transport, clock, maxReconnectAttempts: 0, onTransportFailure: (error) => failures.push(error) });
        await session.start({ missionId: "mission-a", roomId: "room-a" });
        expect(session.state).toBe("degraded");
        expect(connect).not.toHaveBeenCalled();
        expect(failures).toHaveLength(1);
        expect(String(failures[0])).not.toContain(providerSecret);
        await session.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("recaptures each acquired subscription once with original receivers despite raw mutation and refresh cleanup", async () => {
    const clock = new FakeClock();
    const publishReceivers: unknown[] = [];
    const unsubscribeReceivers: unknown[] = [];
    const refreshedPublishReceivers: unknown[] = [];
    const refreshedUnsubscribeReceivers: unknown[] = [];
    const originalPublish = function (this: unknown) { publishReceivers.push(this); };
    const originalUnsubscribe = function (this: unknown) { unsubscribeReceivers.push(this); };
    const refreshedPublish = function (this: unknown) { refreshedPublishReceivers.push(this); };
    const refreshedUnsubscribe = function (this: unknown) { refreshedUnsubscribeReceivers.push(this); };
    let publish: unknown = originalPublish;
    let unsubscribe: unknown = originalUnsubscribe;
    const raw = {} as Record<string, unknown>;
    const reads = { publish: 0, unsubscribe: 0 };
    Object.defineProperties(raw, {
      publish: { get: () => { reads.publish += 1; return publish; } },
      unsubscribe: { get: () => { reads.unsubscribe += 1; return unsubscribe; } },
    });
    const connect = vi.fn(async () => raw as RealtimeTransportSubscription);
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport: { connect }, clock });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    await expect(session.publish(message(clock))).resolves.toBe(true);
    publish = refreshedPublish;
    unsubscribe = refreshedUnsubscribe;
    await session.refresh();

    expect(reads).toEqual({ publish: 2, unsubscribe: 2 });
    expect(publishReceivers).toEqual([raw]);
    expect(unsubscribeReceivers).toEqual([raw]);
    await expect(session.publish(message(clock, { messageId: "refreshed-subscription", clientSeq: 2 }))).resolves.toBe(true);
    expect(refreshedPublishReceivers).toEqual([raw]);
    await session.stop();
    expect(unsubscribeReceivers).toEqual([raw]);
    expect(refreshedUnsubscribeReceivers).toEqual([raw]);
  });

  it("fails closed for hostile subscription fields while disposing captured cleanup once without unhandled leakage", async () => {
    const providerSecret = "hostile-subscription-secret";
    const modes = ["throw", "rejected", "hostile-then"] as const;
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const mode of modes) {
        const clock = new FakeClock();
        const dispose = vi.fn(() => undefined);
        const raw = { unsubscribe: dispose } as Record<string, unknown>;
        Object.defineProperty(raw, "publish", { get: () => {
          if (mode === "throw") throw new Error(providerSecret);
          if (mode === "rejected") return Promise.reject(new Error(providerSecret));
          const thenable = {}; Object.defineProperty(thenable, "then", { get: () => { throw new Error(providerSecret); } }); return thenable;
        } });
        const connect = vi.fn(async () => raw as RealtimeTransportSubscription);
        const failures: unknown[] = [];
        const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport: { connect }, clock, maxReconnectAttempts: 0, onTransportFailure: (error) => failures.push(error) });
        await session.start({ missionId: "mission-a", roomId: "room-a" });
        expect(session.state).toBe("degraded");
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(String(failures[0])).not.toContain(providerSecret);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", observeUnhandled); }
  });

  it("passes frozen transport connection requests whose stale callbacks cannot revive a handed-off or stopped scope", async () => {
    const clock = new FakeClock();
    const inputs: Array<Parameters<RealtimeTransportAdapter["connect"]>[0]> = [];
    const received: RealtimeEnvelope[] = [];
    const failures: unknown[] = [];
    const connect = vi.fn(async (input: Parameters<RealtimeTransportAdapter["connect"]>[0]) => {
      inputs.push(input);
      return { unsubscribe: vi.fn(() => undefined), publish: vi.fn(() => undefined) };
    });
    const session = new RealtimeRoomSession({ tokenProvider: async () => token(clock.now() + 300_000), transport: { connect }, clock, onMessage: (value) => received.push(value), onTransportFailure: (error) => failures.push(error) });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    const first = inputs[0]!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.scope)).toBe(true);
    expect(Object.isFrozen(first.token)).toBe(true);
    expect(Object.isFrozen(first.token.tokenRequest)).toBe(true);
    expect(() => { (first.scope as { roomId: string }).roomId = "room-b"; }).toThrow();
    expect(() => { (first as { connectionEpoch: number }).connectionEpoch = 99; }).toThrow();

    await session.start({ missionId: "mission-a", roomId: "room-b" });
    first.onMessage(message(clock, { messageId: "stale-request", roomId: "room-a" }));
    first.onFailure(new Error("ordinary stale failure"));
    await flush();
    expect(session.scope).toEqual({ missionId: "mission-a", roomId: "room-b" });
    expect(session.state).toBe("live");
    expect(received).toEqual([]);
    expect(failures).toEqual([]);
    await session.stop();
    first.onFailure(new Error("post-stop failure"));
    first.onMessage(message(clock, { messageId: "post-stop", roomId: "room-a" }));
    await flush();
    expect(session.state).toBe("stopped");
  });

  it("settles a synchronous publication deadline before invoking the provider publish callback", async () => {
    const baseClock = new FakeClock();
    let synchronouslyExpirePublications = false;
    const retainedCallbacks = new Map<number, () => void>();
    const clearedHandles: number[] = [];
    const clock = {
      now: () => baseClock.now(),
      setTimeout: (callback: () => void, delayMs: number) => {
        if (synchronouslyExpirePublications && delayMs === 7) {
          callback();
          retainedCallbacks.set(9_999, callback);
          return 9_999 as unknown as ReturnType<typeof setTimeout>;
        }
        return baseClock.setTimeout(callback, delayMs);
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        if (timer === (9_999 as unknown as ReturnType<typeof setTimeout>)) {
          clearedHandles.push(9_999);
          retainedCallbacks.delete(9_999);
          return;
        }
        baseClock.clearTimeout(timer);
      },
    };
    const { transport, connections } = createTransport();
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const session = new RealtimeRoomSession({ tokenProvider: async () => token(baseClock.now() + 300_000), transport, clock, transportPublishTimeoutMs: 7 });
      await session.start({ missionId: "mission-a", roomId: "room-a" });
      synchronouslyExpirePublications = true;
      await expect(session.publish(message(baseClock))).resolves.toBe(false);
      expect(connections[0]!.publish).not.toHaveBeenCalled();
      expect(session.state).toBe("degraded");
      expect(clearedHandles).toEqual([9_999]);
      expect(retainedCallbacks).toEqual(new Map());
      for (const callback of retainedCallbacks.values()) callback();
      await flush();
      expect(connections[0]!.publish).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      await session.stop();
    } finally { process.off("unhandledRejection", observeUnhandled); }
  });

  it("settles a synchronous token-acquisition deadline before invoking the token provider", async () => {
    const baseClock = new FakeClock();
    const retainedCallbacks = new Map<number, () => void>();
    const clearedHandles: number[] = [];
    const clock = {
      now: () => baseClock.now(),
      setTimeout: (callback: () => void, delayMs: number) => {
        if (delayMs === 7) {
          callback();
          retainedCallbacks.set(8_888, callback);
          return 8_888 as unknown as ReturnType<typeof setTimeout>;
        }
        return baseClock.setTimeout(callback, delayMs);
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        if (timer === (8_888 as unknown as ReturnType<typeof setTimeout>)) {
          clearedHandles.push(8_888);
          retainedCallbacks.delete(8_888);
          return;
        }
        baseClock.clearTimeout(timer);
      },
    };
    const { transport, connect } = createTransport();
    const tokenProvider = vi.fn(async () => token(baseClock.now() + 300_000));
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const session = new RealtimeRoomSession({ tokenProvider, transport, clock, tokenAcquisitionTimeoutMs: 7, maxReconnectAttempts: 0 });
      await session.start({ missionId: "mission-a", roomId: "room-a" });
      expect(session.state).toBe("degraded");
      expect(tokenProvider).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(clearedHandles).toEqual([8_888]);
      expect(retainedCallbacks).toEqual(new Map());
      for (const callback of retainedCallbacks.values()) callback();
      await flush();
      expect(tokenProvider).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      await session.stop();
    } finally { process.off("unhandledRejection", observeUnhandled); }
  });

  it("snapshots recovery policy getters and receivers once, ignoring later replacements", async () => {
    const providerSecret = "recovery-policy-replacement-secret";
    for (const policy of ["random", "reconnect"] as const) {
      const clock = new FakeClock();
      const { transport, connect, connections } = createTransport();
      const reads = { random: 0, reconnect: 0 };
      const randomReceivers: unknown[] = [];
      const reconnectReceivers: unknown[] = [];
      const originalRandom = function (this: unknown) {
        randomReceivers.push(this);
        return 0;
      };
      const originalReconnect = function (this: unknown) {
        reconnectReceivers.push(this);
        return 13;
      };
      let random: unknown = originalRandom;
      let reconnect: unknown = policy === "reconnect" ? originalReconnect : undefined;
      const options = {
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        clock,
      } as unknown as RoomSessionOptions;
      Object.defineProperties(options, {
        random: {
          get: () => {
            reads.random += 1;
            return random;
          },
        },
        reconnectDelayMs: {
          get: () => {
            reads.reconnect += 1;
            return reconnect;
          },
        },
      });
      const session = new RealtimeRoomSession(options);
      random = () => { throw new Error(providerSecret); };
      reconnect = () => { throw new Error(providerSecret); };

      await session.start({ missionId: "mission-a", roomId: "room-a" });
      connections[0]!.input.onFailure(new Error("ordinary failure"));
      expect(session.state).toBe("degraded");
      expect(reads).toEqual({ random: 1, reconnect: 1 });
      const delay = policy === "random" ? 375 : 13;
      expect(clock.delays).toContain(delay);
      clock.advance(delay);
      await vi.waitFor(() => expect(session.state).toBe("live"));

      expect(connect).toHaveBeenCalledTimes(2);
      if (policy === "random") {
        expect(randomReceivers).toEqual([options]);
        expect(reconnectReceivers).toEqual([]);
      } else {
        expect(randomReceivers).toEqual([]);
        expect(reconnectReceivers).toEqual([options]);
      }
    }
  });

  it("contains hostile recovery-policy surfaces and bounds every requested retry", async () => {
    const providerSecret = "hostile-recovery-policy-secret";
    const cases: Array<{
      policy: "random" | "reconnect";
      mode: "missing" | "nonfunction" | "throwing-getter" | "throwing-callback" | "nan" | "infinite" | "negative" | "oversized";
      expected?: number;
    }> = [
      { policy: "random", mode: "missing" },
      { policy: "random", mode: "nonfunction" },
      { policy: "random", mode: "throwing-getter" },
      { policy: "random", mode: "throwing-callback" },
      { policy: "random", mode: "nan", expected: 500 },
      { policy: "random", mode: "infinite", expected: 500 },
      { policy: "random", mode: "negative", expected: 375 },
      { policy: "random", mode: "oversized", expected: 625 },
      { policy: "reconnect", mode: "missing", expected: 500 },
      { policy: "reconnect", mode: "nonfunction" },
      { policy: "reconnect", mode: "throwing-getter" },
      { policy: "reconnect", mode: "throwing-callback" },
      { policy: "reconnect", mode: "nan", expected: 30_000 },
      { policy: "reconnect", mode: "infinite", expected: 30_000 },
      { policy: "reconnect", mode: "negative", expected: 0 },
      { policy: "reconnect", mode: "oversized", expected: 30_000 },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const { policy, mode, expected } of cases) {
        const clock = new FakeClock();
        const { transport, connect } = createTransport([new Error("ordinary failure"), "success"]);
        const failures: unknown[] = [];
        const options = {
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          onTransportFailure: (error: unknown) => failures.push(error),
        } as unknown as RoomSessionOptions;
        const callback = () => {
          if (mode === "throwing-callback") throw new Error(providerSecret);
          if (mode === "nan") return Number.NaN;
          if (mode === "infinite") return Number.POSITIVE_INFINITY;
          if (mode === "negative") return policy === "random" ? -1 : -10;
          if (mode === "oversized") return policy === "random" ? 2 : 99_999;
          return 0.5;
        };
        for (const property of ["random", "reconnectDelayMs"] as const) {
          Object.defineProperty(options, property, {
            get: () => {
              const targeted = property === (policy === "random" ? "random" : "reconnectDelayMs");
              if (!targeted) return property === "random" ? () => 0.5 : undefined;
              if (mode === "missing") return undefined;
              if (mode === "nonfunction") return providerSecret;
              if (mode === "throwing-getter") throw new Error(providerSecret);
              return callback;
            },
          });
        }

        const session = new RealtimeRoomSession(options);
        await session.start({ missionId: "mission-a", roomId: "room-a" });
        expect(session.state).toBe("degraded");
        expect(failures).toHaveLength(1);
        expect(String(failures[0])).not.toContain(providerSecret);
        const delay = clock.delays.at(-1)!;
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(30_000);
        if (expected !== undefined) expect(delay).toBe(expected);
        clock.advance(delay);
        await vi.waitFor(() => expect(session.state).toBe("live"));
        expect(connect).toHaveBeenCalledTimes(2);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("contains reentrant custom and default recovery policies before stale timers, connects, or notifications can escape", async () => {
    const providerSecret = "reentrant-recovery-policy-secret";
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const policy of ["reconnect", "random"] as const) {
        for (const action of ["stop", "handoff"] as const) {
        const clock = new FakeClock();
        const { transport, connect, connections } = createTransport([new Error("ordinary failure"), "success"]);
        const states: string[] = [];
        const failures: unknown[] = [];
        let policyCalls = 0;
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(clock.now() + 300_000),
          transport,
          clock,
          ...(policy === "reconnect" ? {
            reconnectDelayMs: () => {
              policyCalls += 1;
              if (action === "stop") void session.stop();
              else void session.start(newScope);
              throw new Error(providerSecret);
            },
          } : {
            random: () => {
              policyCalls += 1;
              if (action === "stop") void session.stop();
              else void session.start(newScope);
              throw new Error(providerSecret);
            },
          }),
          onStateChange: (state) => states.push(state),
          onTransportFailure: (error) => failures.push(error),
        });

        await session.start(oldScope);
        await vi.waitFor(() => expect(session.state).toBe(action === "stop" ? "stopped" : "live"));
        clock.advance(30_000);
        await flush();

        expect(session.state).toBe(action === "stop" ? "stopped" : "live");
        expect(states).not.toContain("degraded");
        expect(failures).toEqual([]);
        expect(policyCalls).toBe(1);
        expect(connect).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
        if (action === "stop") expect(session.scope).toBeUndefined();
        else {
          expect(session.scope).toEqual(newScope);
          expect(connections).toHaveLength(1);
          expect(connections[0]!.input.scope).toEqual(newScope);
        }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("contains immediately rejected recovery-policy results and hostile thenables with the bounded fallback", async () => {
    const providerSecret = "async-recovery-policy-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const policy of ["random", "reconnect"] as const) {
        for (const resultMode of ["rejected", "hostile-then"] as const) {
          const clock = new FakeClock();
          const { transport, connect, connections } = createTransport();
          const failures: unknown[] = [];
          const hostileThenable = {};
          Object.defineProperty(hostileThenable, "then", {
            get: () => { throw new Error(providerSecret); },
          });
          const result = resultMode === "rejected"
            ? Promise.reject(new Error(providerSecret))
            : hostileThenable;
          const session = new RealtimeRoomSession({
            tokenProvider: async () => token(clock.now() + 300_000),
            transport,
            clock,
            ...(policy === "random"
              ? { random: () => result as number }
              : { random: () => 0.5, reconnectDelayMs: () => result as number }),
            onTransportFailure: (error) => failures.push(error),
          });

          await session.start({ missionId: "mission-a", roomId: "room-a" });
          connections[0]!.input.onFailure(new Error("ordinary failure"));
          expect(session.state).toBe("degraded");
          expect(failures).toHaveLength(1);
          expect(String(failures[0])).not.toContain(providerSecret);
          expect(clock.delays.at(-1)).toBe(500);
          clock.advance(500);
          await vi.waitFor(() => expect(session.state).toBe("live"));
          expect(connect).toHaveBeenCalledTimes(2);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("contains deferred recovery-policy rejections after stop or exact handoff without mutating the scheduled fallback", async () => {
    const providerSecret = "late-async-recovery-policy-secret";
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const policy of ["random", "reconnect"] as const) {
        for (const action of ["stop", "handoff"] as const) {
          const clock = new FakeClock();
          const { transport, connect, connections } = createTransport();
          const failures: unknown[] = [];
          const lateResult = deferred<number>();
          const session = new RealtimeRoomSession({
            tokenProvider: async () => token(clock.now() + 300_000),
            transport,
            clock,
            ...(policy === "random"
              ? { random: () => lateResult.promise as unknown as number }
              : { random: () => 0.5, reconnectDelayMs: () => lateResult.promise as unknown as number }),
            onTransportFailure: (error) => failures.push(error),
          });

          await session.start(oldScope);
          connections[0]!.input.onFailure(new Error("ordinary failure"));
          expect(session.state).toBe("degraded");
          expect(clock.delays.at(-1)).toBe(500);
          if (action === "stop") await session.stop();
          else await session.start(newScope);
          await vi.waitFor(() => expect(session.state).toBe(action === "stop" ? "stopped" : "live"));
          const delaysAfterLifecycleChange = [...clock.delays];

          lateResult.reject(new Error(providerSecret));
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(clock.delays).toEqual(delaysAfterLifecycleChange);
          expect(session.state).toBe(action === "stop" ? "stopped" : "live");
          expect(failures).toHaveLength(1);
          expect(String(failures[0])).not.toContain(providerSecret);
          expect(connect).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
          if (action === "stop") expect(session.scope).toBeUndefined();
          else {
            expect(session.scope).toEqual(newScope);
            expect(connections).toHaveLength(2);
            expect(connections[1]!.input.scope).toEqual(newScope);
          }

          clock.advance(30_000);
          await flush();
          expect(session.state).toBe(action === "stop" ? "stopped" : "live");
          expect(connect).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
          expect(failures).toHaveLength(1);
        }
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("falls back when a captured now method returns invalid values or throws", async () => {
    const providerSecret = "clock-now-provider-secret";
    const modes: Array<() => unknown> = [
      () => Number.NaN,
      () => "not-a-number",
      () => { throw new Error(providerSecret); },
    ];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      for (const now of modes) {
        const retained: Array<() => void> = [];
        const { transport, connect } = createTransport();
        const session = new RealtimeRoomSession({
          tokenProvider: async () => token(Date.now() + 300_000),
          transport,
          clock: {
            now: now as () => number,
            setTimeout: (callback) => {
              retained.push(callback);
              return retained.length as unknown as ReturnType<typeof setTimeout>;
            },
            clearTimeout: () => undefined,
          },
        });
        await session.start({ missionId: "mission-a", roomId: "room-a" });
        expect(session.state).toBe("live");
        await session.stop();
        for (const callback of retained) callback();
        await flush();
        expect(session.state).toBe("stopped");
        expect(connect).toHaveBeenCalledTimes(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("deactivates callbacks retained by a throwing setTimeout before using its fallback schedule", async () => {
    const providerSecret = "clock-set-timeout-provider-secret";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
    const retained: Array<() => void> = [];
    const { transport, connect, connections } = createTransport();
    const failures: unknown[] = [];
    const session = new RealtimeRoomSession({
      tokenProvider: async () => token(Date.now() + 300_000),
      transport,
      reconnectDelayMs: () => 30_000,
      onTransportFailure: (error) => failures.push(error),
      clock: {
        now: () => Date.now(),
        setTimeout: (callback) => {
          retained.push(callback);
          throw new Error(providerSecret);
        },
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });
    await session.start({ missionId: "mission-a", roomId: "room-a" });
    connections[0]!.input.onFailure(new Error("ordinary failure"));
    expect(session.state).toBe("degraded");
    expect(failures).toHaveLength(1);
    const callbacksBeforeStop = [...retained];

    for (const callback of callbacksBeforeStop) callback();
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("degraded");
    await session.stop();
    expect(session.state).toBe("stopped");
    expect(String(failures[0])).not.toContain(providerSecret);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("deactivates opaque timer callbacks when clearTimeout throws during stop or exact handoff", async () => {
    const providerSecret = "clock-clear-timeout-provider-secret";
    const oldScope = { missionId: "mission-a", roomId: "room-a" };
    const newScope = { missionId: "mission-a", roomId: "room-b" };
    for (const action of ["stop", "handoff"] as const) {
      const clock = new FakeClock();
      const callbacks: Array<() => void> = [];
      const { transport, connect, connections } = createTransport();
      const expired: RealtimeEnvelope[] = [];
      const session = new RealtimeRoomSession({
        tokenProvider: async () => token(clock.now() + 300_000),
        transport,
        reconnectDelayMs: () => 11,
        onTransientMessageExpired: (value) => expired.push(value),
        clock: {
          now: () => clock.now(),
          setTimeout: (callback) => {
            callbacks.push(callback);
            return { timer: callbacks.length } as unknown as ReturnType<typeof setTimeout>;
          },
          clearTimeout: () => { throw new Error(providerSecret); },
        },
      });
      await session.start(oldScope);
      const expiring = message(clock, { messageId: `opaque-${action}`, expiresAtMs: clock.now() + 6 });
      connections[0]!.input.onMessage(expiring);
      connections[0]!.input.onFailure(new Error("ordinary failure"));
      expect(session.state).toBe("degraded");
      const staleCallbacks = [...callbacks];

      if (action === "stop") await session.stop();
      else await session.start(newScope);
      await vi.waitFor(() => expect(session.state).toBe(action === "stop" ? "stopped" : "live"));
      for (const callback of staleCallbacks) callback();
      await flush();

      expect(session.state).toBe(action === "stop" ? "stopped" : "live");
      expect(connect).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
      if (action === "handoff") expect(session.scope).toEqual(newScope);
      expect(expired).toEqual([]);
      expect(connections[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    }
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
