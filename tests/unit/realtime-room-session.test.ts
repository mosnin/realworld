import { describe, expect, it, vi } from "vitest";

import { RealtimePublishRateLimitError } from "../../lib/realtime/signal-governor";
import {
  RealtimeRoomSession,
  type RealtimeEnvelope,
  type RealtimeToken,
  type RealtimeTransportAdapter,
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
    await flush();

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
    expect(failures).toEqual([networkError]);
    expect(clock.delays).toContain(30_000);

    clock.advance(30_000);
    await flush();

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
