import { describe, expect, it, vi } from "vitest";

import { RealtimePublishRateLimitError } from "../../lib/realtime/signal-governor";
import {
  RealtimeRoomSession,
  type RealtimeEnvelope,
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
        expect(failures).toHaveLength(1);
        expect(failures[0]).toEqual(expect.objectContaining({ message: expect.stringMatching(/^Realtime /) }));
        expect(String(failures[0])).not.toContain(providerSecret);
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
