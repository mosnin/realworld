import { describe, expect, it, vi } from "vitest";

import {
  createDurableRoomSessionFactory,
  type DurableRoomReadiness,
} from "../../app/realtime/durable-room-session-factory";
import type { RealtimeEnvelope, RealtimeToken, RealtimeTransportAdapter } from "../../lib/realtime/room-session";

const readiness = (overrides: Partial<DurableRoomReadiness> = {}): DurableRoomReadiness => ({
  missionId: "mission_a",
  roomId: "room_a",
  grantVersion: 3,
  missionLifecycle: "active",
  roomState: "active",
  ...overrides,
});

function token(authorizationVersion: number): RealtimeToken {
  return { tokenRequest: { capability: "test" }, expiresAt: Date.now() + 300_000, authorizationVersion };
}

function envelope(scope: DurableRoomReadiness): RealtimeEnvelope {
  const now = Date.now();
  return {
    v: 1,
    kind: "interaction.cursor",
    messageId: "cursor_1",
    sender: { clientId: "client_a", clientInstanceId: "tab_a", connectionEpoch: 1 },
    missionId: scope.missionId,
    roomId: scope.roomId,
    issuedAtMs: now,
    expiresAtMs: now + 5_000,
    clientSeq: 1,
    payload: { targetId: "canvas_a", x: 0.2, y: 0.8, mode: "map" },
  };
}

function transport() {
  const publish = vi.fn(async () => undefined);
  const unsubscribe = vi.fn();
  const connect = vi.fn(async () => ({ publish, unsubscribe }));
  return { adapter: { connect } satisfies RealtimeTransportAdapter, connect, publish, unsubscribe };
}

describe("durable room session factory", () => {
  it("is lazy, binds the exact readiness tuple to both injected factories, and delegates start/publish/stop", async () => {
    const boundReadiness = readiness();
    const fakeTransport = transport();
    const tokenProvider = vi.fn(async () => token(boundReadiness.grantVersion));
    const tokenProviderFactory = vi.fn(() => tokenProvider);
    const transportFactory = vi.fn(() => fakeTransport.adapter);
    const factory = createDurableRoomSessionFactory({ tokenProviderFactory, transportFactory });

    expect(factory).toBeTypeOf("function");
    expect(tokenProviderFactory).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();
    const session = factory?.(boundReadiness);
    expect(session).toBeDefined();
    expect(tokenProviderFactory).toHaveBeenCalledWith(boundReadiness);
    expect(transportFactory).toHaveBeenCalledWith(boundReadiness);
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fakeTransport.connect).not.toHaveBeenCalled();

    await session?.start();
    expect(tokenProvider).toHaveBeenCalledWith({ missionId: "mission_a", roomId: "room_a" });
    expect(fakeTransport.connect).toHaveBeenCalledWith(expect.objectContaining({
      scope: { missionId: "mission_a", roomId: "room_a" },
      token: expect.objectContaining({ authorizationVersion: 3 }),
    }));
    await expect(session?.publish?.(envelope(boundReadiness))).resolves.toBe(true);
    expect(fakeTransport.publish).toHaveBeenCalledWith(expect.objectContaining({ missionId: "mission_a", roomId: "room_a", kind: "interaction.cursor" }));

    await session?.stop();
    await session?.stop();
    expect(fakeTransport.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("forwards only the exact bound scope through optional realtime callbacks", async () => {
    const boundReadiness = readiness();
    const fakeTransport = transport();
    const onStateChange = vi.fn();
    const onMessage = vi.fn();
    const factory = createDurableRoomSessionFactory({
      tokenProviderFactory: () => async () => token(3),
      transportFactory: () => fakeTransport.adapter,
      onStateChange,
      onMessage,
    });
    const session = factory?.(boundReadiness);
    await session?.start();
    expect(onStateChange).toHaveBeenCalledWith(boundReadiness, expect.any(String));
    const input = (fakeTransport.connect.mock.calls as unknown as Array<Array<{ onMessage: (message: RealtimeEnvelope) => void }>>)[0]?.[0];
    const message = envelope(boundReadiness);
    input?.onMessage(message);
    expect(onMessage).toHaveBeenCalledWith(boundReadiness, message);

    const invalid = factory?.({ ...boundReadiness, grantVersion: 0 });
    expect(invalid).toBeUndefined();
    expect(onMessage).toHaveBeenCalledTimes(1);
    await session?.stop();
  });

  it("contains synchronous and asynchronous presentation callback failures", async () => {
    const boundReadiness = readiness();
    const fakeTransport = transport();
    const onStateChange = vi.fn(() => { throw new Error("state observer failed"); });
    const onMessage = vi.fn(() => Promise.reject(new Error("message observer failed"))) as unknown as (
      readiness: DurableRoomReadiness,
      message: RealtimeEnvelope,
    ) => void;
    const factory = createDurableRoomSessionFactory({
      tokenProviderFactory: () => async () => token(3),
      transportFactory: () => fakeTransport.adapter,
      onStateChange,
      onMessage,
    });
    const session = factory?.(boundReadiness);

    await expect(session?.start()).resolves.toBeUndefined();
    const input = (fakeTransport.connect.mock.calls as unknown as Array<Array<{ onMessage: (message: RealtimeEnvelope) => void }>>)[0]?.[0];
    const message = envelope(boundReadiness);
    expect(() => input?.onMessage(message)).not.toThrow();
    await Promise.resolve();
    await expect(session?.stop()).resolves.toBeUndefined();
    expect(onStateChange).toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(boundReadiness, message);
  });

  it("fails closed before construction for invalid readiness, invalid factories, malformed outputs, and thrown factories", () => {
    const boundReadiness = readiness();
    const tokenProviderFactory = vi.fn(() => async () => token(3));
    const transportFactory = vi.fn(() => transport().adapter);
    expect(createDurableRoomSessionFactory(undefined)).toBeUndefined();
    expect(createDurableRoomSessionFactory({ tokenProviderFactory: "not-a-function", transportFactory })).toBeUndefined();
    expect(createDurableRoomSessionFactory({ tokenProviderFactory, transportFactory: "not-a-function" })).toBeUndefined();

    const validFactory = createDurableRoomSessionFactory({ tokenProviderFactory, transportFactory });
    expect(validFactory?.({ ...boundReadiness, grantVersion: 0 })).toBeUndefined();
    expect(tokenProviderFactory).not.toHaveBeenCalled();
    expect(transportFactory).not.toHaveBeenCalled();

    expect(createDurableRoomSessionFactory({ tokenProviderFactory: () => ({}), transportFactory })?.(boundReadiness)).toBeUndefined();
    expect(createDurableRoomSessionFactory({ tokenProviderFactory, transportFactory: () => ({ connect: "bad" }) })?.(boundReadiness)).toBeUndefined();
    expect(createDurableRoomSessionFactory({
      tokenProviderFactory: () => { throw new Error("token factory failed"); },
      transportFactory,
    })?.(boundReadiness)).toBeUndefined();
    expect(createDurableRoomSessionFactory({
      tokenProviderFactory,
      transportFactory: () => { throw new Error("transport factory failed"); },
    })?.(boundReadiness)).toBeUndefined();
  });

  it("contains rejected token providers and never connects a stopped stale scope", async () => {
    const first = readiness();
    const second = readiness({ missionId: "mission_b", roomId: "room_b", grantVersion: 4 });
    let resolveFirstToken: ((value: RealtimeToken) => void) | undefined;
    const firstTokenProvider = vi.fn(() => new Promise<RealtimeToken>((resolve) => { resolveFirstToken = resolve; }));
    const secondTokenProvider = vi.fn(async () => token(4));
    const rejectedTokenProvider = vi.fn(async () => { throw new Error("token rejected"); });
    const fakeTransport = transport();
    const tokenProviderFactory = vi.fn((value: DurableRoomReadiness) => value.missionId === "mission_a" ? firstTokenProvider : secondTokenProvider);
    const factory = createDurableRoomSessionFactory({ tokenProviderFactory, transportFactory: () => fakeTransport.adapter });
    const stale = factory?.(first);
    const replacement = factory?.(second);

    const staleStart = stale?.start();
    await stale?.stop();
    await replacement?.start();
    resolveFirstToken?.(token(3));
    await staleStart;

    expect(fakeTransport.connect).toHaveBeenCalledTimes(1);
    expect(fakeTransport.connect).toHaveBeenCalledWith(expect.objectContaining({ scope: { missionId: "mission_b", roomId: "room_b" } }));
    await replacement?.stop();

    const rejectedFactory = createDurableRoomSessionFactory({ tokenProviderFactory: () => rejectedTokenProvider, transportFactory: () => fakeTransport.adapter });
    const rejectedSession = rejectedFactory?.(readiness({ missionId: "mission_c", roomId: "room_c" }));
    await expect(rejectedSession?.start()).resolves.toBeUndefined();
    expect(rejectedTokenProvider).toHaveBeenCalledWith({ missionId: "mission_c", roomId: "room_c" });
  });

  it("fails closed for hostile option or transport getters and rejects malformed, expired, hostile, or wrong-grant tokens before connect", async () => {
    const boundReadiness = readiness();
    const fakeTransport = transport();
    const hostileOptions = {
      get tokenProviderFactory(): unknown { throw new Error("hostile token option"); },
      transportFactory: () => fakeTransport.adapter,
    };
    expect(createDurableRoomSessionFactory(hostileOptions)).toBeUndefined();
    const hostileTransportFactory = createDurableRoomSessionFactory({
      tokenProviderFactory: () => async () => token(3),
      transportFactory: () => ({ get connect(): unknown { throw new Error("hostile transport getter"); } }),
    });
    expect(hostileTransportFactory?.(boundReadiness)).toBeUndefined();

    const candidates: unknown[] = [
      { tokenRequest: null, expiresAt: Date.now() + 60_000, authorizationVersion: 3 },
      { tokenRequest: {}, expiresAt: Date.now() - 1, authorizationVersion: 3 },
      { tokenRequest: {}, expiresAt: Date.now() + 60_000, authorizationVersion: 4 },
      {
        get tokenRequest(): unknown { throw new Error("hostile token getter"); },
        expiresAt: Date.now() + 60_000,
        authorizationVersion: 3,
      },
    ];
    for (const candidate of candidates) {
      const factory = createDurableRoomSessionFactory({
        tokenProviderFactory: () => async () => candidate as RealtimeToken,
        transportFactory: () => fakeTransport.adapter,
      });
      const session = factory?.(boundReadiness);
      await expect(session?.start()).resolves.toBeUndefined();
    }
    expect(fakeTransport.connect).not.toHaveBeenCalled();
  });
});
