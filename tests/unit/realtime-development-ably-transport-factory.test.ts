import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createDevelopmentAblyTransportFactory } from "../../app/realtime/development-ably-transport-factory";
import type { DurableRoomReadiness } from "../../app/realtime/durable-room-session-factory";
import type { AblyRealtimeClient, AblyRoomChannel } from "../../lib/realtime/ably-room-transport";
import type { RealtimeToken, RealtimeTransportAdapter } from "../../lib/realtime/room-session";

type TransportConnectInput = Parameters<RealtimeTransportAdapter["connect"]>[0];

const readiness = (overrides: Partial<DurableRoomReadiness> = {}): DurableRoomReadiness => ({
  missionId: "mission_a",
  roomId: "room_a",
  grantVersion: 3,
  missionLifecycle: "active",
  roomState: "active",
  ...overrides,
});

function tokenFor(environment: "development" | "test" | "preview", room: DurableRoomReadiness): RealtimeToken {
  const prefix = `rw:${environment}:mission:${room.missionId}`;
  return {
    tokenRequest: {
      keyName: "signed.test.key",
      nonce: "nonce-1234567890123456",
      mac: "signed-mac",
      timestamp: 1_000_000,
      ttl: 300_000,
      clientId: "rw_test",
      capability: JSON.stringify({
        [`${prefix}:world`]: ["subscribe"],
        [`${prefix}:room:${room.roomId}:presence`]: ["subscribe"],
      }),
    },
    expiresAt: 1_300_000,
    authorizationVersion: room.grantVersion,
  };
}

function connectedFakeClient(): AblyRealtimeClient {
  const connectionListeners: Array<{
    events: string | string[];
    listener: (state: { current?: string; reason?: unknown }) => void;
  }> = [];
  const channels = new Map<string, AblyRoomChannel>();
  const get = (name: string): AblyRoomChannel => {
    const existing = channels.get(name);
    if (existing) return existing;
    const channel: AblyRoomChannel = {
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(),
      publish: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      presence: {
        subscribe: vi.fn(async () => undefined),
        unsubscribe: vi.fn(),
        enter: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
        leave: vi.fn(async () => undefined),
      },
    };
    channels.set(name, channel);
    return channel;
  };

  return {
    channels: { get },
    connection: {
      on: vi.fn((events, listener) => connectionListeners.push({ events, listener })),
      off: vi.fn((_events, listener) => {
        const index = connectionListeners.findIndex((candidate) => candidate.listener === listener);
        if (index >= 0) connectionListeners.splice(index, 1);
      }),
    },
    connect: vi.fn(() => {
      for (const { events, listener } of [...connectionListeners]) {
        if ((Array.isArray(events) ? events : [events]).includes("connected")) listener({ current: "connected" });
      }
    }),
    close: vi.fn(),
  };
}

function connectInput(
  room: DurableRoomReadiness,
  token: RealtimeToken,
  scope: TransportConnectInput["scope"] = { missionId: room.missionId, roomId: room.roomId },
): TransportConnectInput {
  return {
    scope,
    token,
    connectionEpoch: 1,
    onMessage: vi.fn(),
    onFailure: vi.fn(),
  };
}

describe("development Ably transport factory", () => {
  it("constructs no client eagerly; allows only development, test, and preview; and denies production", () => {
    const clientFactory = vi.fn(async () => connectedFakeClient());

    for (const environment of ["development", "test", "preview"] as const) {
      expect(createDevelopmentAblyTransportFactory({ environment, clientFactory })).toEqual(expect.any(Function));
    }
    expect(createDevelopmentAblyTransportFactory({ environment: "production", clientFactory })).toBeUndefined();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("fails closed for missing, malformed, throwing, or hostile options and readiness", () => {
    const clientFactory = vi.fn(async () => connectedFakeClient());
    const throwingOptions = Object.defineProperty({}, "environment", {
      get: () => { throw new Error("untrusted options getter"); },
    });
    const hostileOptions = new Proxy({ environment: "preview", clientFactory }, {
      get: () => { throw new Error("hostile options proxy"); },
    });

    expect(createDevelopmentAblyTransportFactory(undefined)).toBeUndefined();
    expect(createDevelopmentAblyTransportFactory({ environment: "preview" })).toBeUndefined();
    expect(createDevelopmentAblyTransportFactory({ environment: "staging", clientFactory })).toBeUndefined();
    expect(createDevelopmentAblyTransportFactory(throwingOptions)).toBeUndefined();
    expect(createDevelopmentAblyTransportFactory(hostileOptions)).toBeUndefined();

    const factory = createDevelopmentAblyTransportFactory({ environment: "preview", clientFactory });
    expect(factory).toBeDefined();
    expect(factory?.(undefined as never)).toBeUndefined();
    expect(factory?.({ ...readiness(), grantVersion: 0 })).toBeUndefined();
    expect(factory?.({ ...readiness(), missionLifecycle: "archived" } as never)).toBeUndefined();
    const throwingReadiness = Object.defineProperty({}, "missionId", {
      get: () => { throw new Error("untrusted readiness getter"); },
    });
    const hostileReadiness = new Proxy({}, {
      get: () => { throw new Error("hostile readiness proxy"); },
    });
    expect(factory?.(throwingReadiness as never)).toBeUndefined();
    expect(factory?.(hostileReadiness as never)).toBeUndefined();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("passes only the already-signed token request to the injected client factory at connect time", async () => {
    const room = readiness();
    const signedToken = tokenFor("preview", room);
    const clientFactory = vi.fn(async (...received: unknown[]) => {
      expect(received).toEqual([signedToken.tokenRequest]);
      return connectedFakeClient();
    });
    const factory = createDevelopmentAblyTransportFactory({ environment: "preview", clientFactory });
    const adapter = factory?.(room) as RealtimeTransportAdapter | undefined;

    expect(adapter).toBeDefined();
    expect(clientFactory).not.toHaveBeenCalled();
    const subscription = await adapter?.connect({
      scope: { missionId: room.missionId, roomId: room.roomId },
      token: signedToken,
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    });

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledWith(signedToken.tokenRequest);
    await subscription?.unsubscribe();
  });

  it("binds a factory-issued adapter to its authorized scope and grant before any client construction", async () => {
    const room = readiness();
    const signedToken = tokenFor("preview", room);
    const clientFactory = vi.fn(async () => connectedFakeClient());
    const factory = createDevelopmentAblyTransportFactory({ environment: "preview", clientFactory });
    const adapter = factory?.(room) as RealtimeTransportAdapter | undefined;
    const wrongMission = readiness({ missionId: "mission_b" });
    const wrongRoom = readiness({ roomId: "room_b" });
    const malformedScope = { missionId: "", roomId: room.roomId };
    const hostileScope = Object.defineProperty({}, "missionId", {
      get: () => { throw new Error("hostile scope getter"); },
    });
    const malformedToken = {
      ...signedToken,
      tokenRequest: { ...(signedToken.tokenRequest as Record<string, unknown>), mac: "" },
    };
    const hostileToken = new Proxy({}, {
      get: () => { throw new Error("hostile token getter"); },
    });

    expect(adapter).toBeDefined();
    const rejectedInputs: TransportConnectInput[] = [
      connectInput(wrongMission, tokenFor("preview", wrongMission)),
      connectInput(wrongRoom, tokenFor("preview", wrongRoom)),
      connectInput(room, { ...signedToken, authorizationVersion: room.grantVersion + 1 }),
      connectInput(room, signedToken, malformedScope),
      connectInput(room, signedToken, hostileScope as TransportConnectInput["scope"]),
      connectInput(room, malformedToken),
      connectInput(room, hostileToken as RealtimeToken),
    ];

    for (const input of rejectedInputs) {
      await expect(adapter?.connect(input)).rejects.toThrow();
      expect(clientFactory).not.toHaveBeenCalled();
    }

    await expect(adapter?.connect(connectInput(room, signedToken))).resolves.toEqual(expect.objectContaining({
      unsubscribe: expect.any(Function),
      publish: expect.any(Function),
    }));
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenLastCalledWith(signedToken.tokenRequest);
  });

  it("creates isolated adapters for distinct authorized room scopes", async () => {
    const first = readiness();
    const second = readiness({ missionId: "mission_b", roomId: "room_b", grantVersion: 8 });
    const firstToken = tokenFor("test", first);
    const secondToken = tokenFor("test", second);
    const clientFactory = vi.fn(async () => connectedFakeClient());
    const factory = createDevelopmentAblyTransportFactory({ environment: "test", clientFactory });
    const firstAdapter = factory?.(first) as RealtimeTransportAdapter | undefined;
    const secondAdapter = factory?.(second) as RealtimeTransportAdapter | undefined;

    expect(firstAdapter).toBeDefined();
    expect(secondAdapter).toBeDefined();
    expect(firstAdapter).not.toBe(secondAdapter);
    await firstAdapter?.connect({
      scope: { missionId: first.missionId, roomId: first.roomId }, token: firstToken, connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn(),
    });
    await secondAdapter?.connect({
      scope: { missionId: second.missionId, roomId: second.roomId }, token: secondToken, connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn(),
    });

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory.mock.calls).toEqual([[firstToken.tokenRequest], [secondToken.tokenRequest]]);
  });

  it("has no ambient provider, credential, or network path while Mission World composes only injected development realtime seams", async () => {
    const [factorySource, missionWorldSource, pageSource] = await Promise.all([
      readFile(new URL("../../app/realtime/development-ably-transport-factory.ts", import.meta.url), "utf8"),
      readFile(new URL("../../app/mission-world.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../app/page.tsx", import.meta.url), "utf8"),
    ]);

    expect(factorySource).not.toMatch(/process\.env|import\(["']ably["']\)|\bfetch\s*\(/);
    expect(factorySource).toContain("clientFactory?: unknown");
    expect(missionWorldSource).toContain('useAction(api.realtime.issueTokenRequest)');
    expect(missionWorldSource).toMatch(/<AuthenticatedMissionRealtimeLifecycle[^>]*authenticatedTokenRequester=\{requestAuthenticatedRealtimeToken\}/s);
    expect(missionWorldSource).toMatch(/export\s+type\s+MissionWorldProps\s*=\s*Readonly<\{[\s\S]*developmentAblyClientFactory\?:\s*AblyClientFactory[\s\S]*\}>/);
    expect(missionWorldSource).toMatch(/export\s+function\s+MissionWorld\s*\(\s*\{\s*developmentAblyClientFactory\s*\}\s*:\s*MissionWorldProps\s*=\s*\{\}\s*\)/);
    expect(missionWorldSource).toMatch(/createDevelopmentAblyTransportFactory\s*\([\s\S]*environment:\s*["']development["'][\s\S]*clientFactory:\s*developmentAblyClientFactory/);
    expect(missionWorldSource.match(/<AuthenticatedMissionRealtimeLifecycle[^>]*transportFactory=\{[^}]+\}/gs)).toHaveLength(2);
    expect(pageSource).toMatch(/<MissionWorld\s*\/>/);
    expect(missionWorldSource).not.toMatch(/from\s+["']ably["']|import\(["']ably["']\)|ABLY_API_KEY|process\.env|sessionFactory=/);
  });
});
