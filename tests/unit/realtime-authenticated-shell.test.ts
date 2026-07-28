import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  cleanup: undefined as undefined | (() => void),
  dependencies: undefined as undefined | readonly unknown[],
  useEffect: vi.fn(),
  composition: vi.fn(),
  sourceFactory: vi.fn(),
  publicationPolicy: vi.fn(),
}));

vi.mock("react", () => ({ useEffect: seams.useEffect }));
vi.mock("@/lib/realtime/browser-realtime-composition", () => ({
  createBrowserRealtimeComposition: seams.composition,
}));
vi.mock("@/lib/realtime/dom-browser-lifecycle", () => ({
  createDomBrowserLifecycleSourceFromGlobals: seams.sourceFactory,
}));
vi.mock("@/lib/realtime/browser-signal-policy", () => ({
  createBrowserSignalPublicationPolicy: seams.publicationPolicy,
}));

import { AuthenticatedMissionRealtimeLifecycle } from "../../app/realtime/authenticated-mission-lifecycle";
import type { BrowserRoomSession } from "../../lib/realtime/browser-lifecycle";
import type { RealtimeTransportAdapter } from "../../lib/realtime/room-session";

const originalAppEnvironment = process.env.NEXT_PUBLIC_APP_ENV;
const originalLifecycleFlag = process.env.NEXT_PUBLIC_REALTIME_LIFECYCLE;

function setEnvironment(appEnvironment: string | undefined, lifecycleFlag: string | undefined) {
  if (appEnvironment === undefined) delete process.env.NEXT_PUBLIC_APP_ENV;
  else process.env.NEXT_PUBLIC_APP_ENV = appEnvironment;
  if (lifecycleFlag === undefined) delete process.env.NEXT_PUBLIC_REALTIME_LIFECYCLE;
  else process.env.NEXT_PUBLIC_REALTIME_LIFECYCLE = lifecycleFlag;
}

function readiness(overrides: Partial<{
  missionId: string;
  roomId: string;
  grantVersion: number;
  missionLifecycle: "active" | "archived";
  roomState: "active" | "archived";
}> = {}) {
  return {
    missionId: "mission_a",
    roomId: "room_a",
    grantVersion: 3,
    missionLifecycle: "active" as const,
    roomState: "active" as const,
    ...overrides,
  };
}

function sameDependencies(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) {
  return left !== undefined
    && right !== undefined
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

function issuedToken(value: ReturnType<typeof readiness>) {
  const timestamp = Date.now();
  const ttl = 60_000;
  return {
    missionId: value.missionId,
    roomId: value.roomId,
    authorizationVersion: value.grantVersion,
    expiresAt: timestamp + ttl,
    tokenRequest: {
      keyName: "test.key",
      ttl,
      timestamp,
      nonce: "nonce-1234567890123456",
      capability: "{}",
      clientId: "rw_test",
      mac: "signed-mac",
    },
  };
}

function fakeTransport() {
  const unsubscribe = vi.fn();
  const connect = vi.fn(async () => ({ unsubscribe }));
  return { adapter: { connect } satisfies RealtimeTransportAdapter, connect, unsubscribe };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("authenticated Mission realtime shell", () => {
  beforeEach(() => {
    seams.cleanup = undefined;
    seams.dependencies = undefined;
    seams.useEffect.mockImplementation((effect: () => void | (() => void), dependencies: readonly unknown[]) => {
      if (sameDependencies(seams.dependencies, dependencies)) return;
      seams.cleanup?.();
      const cleanup = effect();
      seams.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      seams.dependencies = dependencies;
    });
    seams.composition.mockReset();
    seams.sourceFactory.mockReset();
    seams.publicationPolicy.mockReset();
    setEnvironment(undefined, undefined);
  });

  afterEach(() => {
    setEnvironment(originalAppEnvironment, originalLifecycleFlag);
  });

  it("keeps default, production, and malformed flags inert with zero source or session factory calls", () => {
    const sessionFactory = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
    for (const [appEnvironment, lifecycleFlag] of [
      [undefined, undefined],
      ["production", "enabled"],
      ["development", "true"],
      ["development ", "enabled"],
    ] as const) {
      setEnvironment(appEnvironment, lifecycleFlag);
      expect(AuthenticatedMissionRealtimeLifecycle({ sessionFactory, readiness: readiness(), membershipGrantVersion: 3, expectedMissionId: "mission_a", expectedRoomId: "room_a" })).toBeNull();
    }

    expect(seams.composition).not.toHaveBeenCalled();
    expect(seams.sourceFactory).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("fails closed when the session dependency is missing even under the exact opt-in", () => {
    setEnvironment("development", "enabled");
    expect(AuthenticatedMissionRealtimeLifecycle({ readiness: readiness(), membershipGrantVersion: 3, expectedMissionId: "mission_a", expectedRoomId: "room_a" })).toBeNull();

    expect(seams.composition).not.toHaveBeenCalled();
    expect(seams.sourceFactory).not.toHaveBeenCalled();
  });

  it("denies missing, malformed, archived, and mismatched durable readiness before composition", () => {
    setEnvironment("development", "enabled");
    const sessionFactory = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
    for (const candidate of [
      undefined,
      { missionId: "mission_a", roomId: "room_a", grantVersion: 3, missionLifecycle: "active" },
      readiness({ missionLifecycle: "archived" }),
      readiness({ roomState: "archived" }),
      readiness({ grantVersion: 0 }),
      readiness({ grantVersion: 4 }),
    ]) {
      expect(AuthenticatedMissionRealtimeLifecycle({ readiness: candidate, membershipGrantVersion: 3, expectedMissionId: "mission_a", expectedRoomId: "room_a", sessionFactory })).toBeNull();
    }

    expect(seams.composition).not.toHaveBeenCalled();
    expect(seams.sourceFactory).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("passes exact active durable scope to the injected session factory only through strict composition", () => {
    setEnvironment("development", "enabled");
    const currentReadiness = readiness();
    const session = { start: vi.fn(), stop: vi.fn() };
    const sessionFactory = vi.fn(() => session);
    const lifecycle = { start: vi.fn(), stop: vi.fn() };
    const policy = { decide: vi.fn() };
    seams.publicationPolicy.mockReturnValue(policy);
    seams.composition.mockImplementation((options: { sessionFactory: () => unknown }) => {
      expect(sessionFactory).not.toHaveBeenCalled();
      expect(options.sessionFactory()).toBe(session);
      return lifecycle;
    });

    expect(AuthenticatedMissionRealtimeLifecycle({ readiness: currentReadiness, membershipGrantVersion: 3, expectedMissionId: "mission_a", expectedRoomId: "room_a", sessionFactory })).toBeNull();

    expect(seams.publicationPolicy).toHaveBeenCalledTimes(1);
    expect(seams.composition).toHaveBeenCalledTimes(1);
    expect(seams.composition).toHaveBeenCalledWith({
      environment: "development",
      rawEnabledFlag: "enabled",
      sourceFactory: seams.sourceFactory,
      sessionFactory: expect.any(Function),
      publicationPolicy: policy,
    });
    expect(sessionFactory).toHaveBeenCalledWith(currentReadiness);
    expect(seams.sourceFactory).not.toHaveBeenCalled();
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(seams.cleanup).toBeTypeOf("function");

    seams.cleanup?.();
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the old lifecycle before each Mission, room, or grant-version rebind and disposes a stale async start", () => {
    setEnvironment("development", "enabled");
    let resolveOldStart: (() => void) | undefined;
    const oldLifecycle = {
      start: vi.fn(() => new Promise<void>((resolve) => { resolveOldStart = resolve; })),
      stop: vi.fn(async () => undefined),
    };
    const secondLifecycle = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const thirdLifecycle = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const lifecycles = [oldLifecycle, secondLifecycle, thirdLifecycle];
    const sessionFactory = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
    seams.publicationPolicy.mockReturnValue({ decide: vi.fn() });
    seams.composition.mockImplementation((options: { sessionFactory: () => unknown }) => {
      options.sessionFactory();
      return lifecycles[seams.composition.mock.calls.length - 1]!;
    });

    expect(AuthenticatedMissionRealtimeLifecycle({ readiness: readiness(), membershipGrantVersion: 3, expectedMissionId: "mission_a", expectedRoomId: "room_a", sessionFactory })).toBeNull();
    expect(oldLifecycle.start).toHaveBeenCalledTimes(1);
    expect(AuthenticatedMissionRealtimeLifecycle({ readiness: readiness({ missionId: "mission_b" }), membershipGrantVersion: 3, expectedMissionId: "mission_b", expectedRoomId: "room_a", sessionFactory })).toBeNull();
    expect(oldLifecycle.stop).toHaveBeenCalledTimes(1);
    expect(secondLifecycle.start).toHaveBeenCalledTimes(1);
    expect(AuthenticatedMissionRealtimeLifecycle({ readiness: readiness({ missionId: "mission_b", roomId: "room_b", grantVersion: 4 }), membershipGrantVersion: 4, expectedMissionId: "mission_b", expectedRoomId: "room_b", sessionFactory })).toBeNull();
    expect(secondLifecycle.stop).toHaveBeenCalledTimes(1);
    expect(thirdLifecycle.start).toHaveBeenCalledTimes(1);
    resolveOldStart?.();

    expect(sessionFactory).toHaveBeenNthCalledWith(1, readiness());
    expect(sessionFactory).toHaveBeenNthCalledWith(2, readiness({ missionId: "mission_b" }));
    expect(sessionFactory).toHaveBeenNthCalledWith(3, readiness({ missionId: "mission_b", roomId: "room_b", grantVersion: 4 }));
    expect(seams.sourceFactory).not.toHaveBeenCalled();
  });

  it("composes injected requester and transport only after exact readiness, preserving the bound Mission, room, and grant", async () => {
    setEnvironment("development", "enabled");
    const currentReadiness = readiness();
    const requester = vi.fn(async () => issuedToken(currentReadiness));
    const fake = fakeTransport();
    const transportFactory = vi.fn(() => fake.adapter);
    const lifecycles: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    seams.publicationPolicy.mockReturnValue({ decide: vi.fn() });
    seams.composition.mockImplementation((options: { sessionFactory: () => BrowserRoomSession | undefined }) => {
      const session = options.sessionFactory();
      const lifecycle = {
        start: vi.fn(() => session?.start()),
        stop: vi.fn(() => session?.stop()),
      };
      lifecycles.push(lifecycle);
      return lifecycle;
    });

    expect(AuthenticatedMissionRealtimeLifecycle({
      readiness: currentReadiness,
      membershipGrantVersion: 3,
      expectedMissionId: "mission_a",
      expectedRoomId: "room_a",
      authenticatedTokenRequester: requester,
      transportFactory,
    })).toBeNull();
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(1));

    expect(seams.composition).toHaveBeenCalledTimes(1);
    expect(transportFactory).toHaveBeenCalledWith(currentReadiness);
    expect(requester).toHaveBeenCalledWith({ missionId: "mission_a", roomId: "room_a" });
    expect(fake.connect).toHaveBeenCalledWith(expect.objectContaining({
      scope: { missionId: "mission_a", roomId: "room_a" },
      token: expect.objectContaining({ authorizationVersion: 3 }),
    }));
    expect(lifecycles[0]?.start).toHaveBeenCalledTimes(1);

    seams.cleanup?.();
    expect(lifecycles[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("fails closed for absent or malformed injected dependencies and keeps current no-factory wiring inert", () => {
    setEnvironment("development", "enabled");
    const requester = vi.fn(async () => issuedToken(readiness()));
    const malformedTransportFactory = vi.fn(() => ({ connect: "not-a-function" }));
    const props = { readiness: readiness(), membershipGrantVersion: 3, expectedMissionId: "mission_a", expectedRoomId: "room_a" };

    expect(AuthenticatedMissionRealtimeLifecycle(props)).toBeNull();
    expect(AuthenticatedMissionRealtimeLifecycle({ ...props, authenticatedTokenRequester: requester })).toBeNull();
    expect(seams.composition).not.toHaveBeenCalled();
    expect(requester).not.toHaveBeenCalled();
    expect(malformedTransportFactory).not.toHaveBeenCalled();

    const lifecycle = { start: vi.fn(), stop: vi.fn() };
    seams.composition.mockImplementation((options: { sessionFactory: () => BrowserRoomSession | undefined }) => {
      expect(options.sessionFactory()).toBeUndefined();
      return lifecycle;
    });
    expect(AuthenticatedMissionRealtimeLifecycle({ ...props, authenticatedTokenRequester: requester, transportFactory: malformedTransportFactory })).toBeNull();
    expect(seams.composition).toHaveBeenCalledTimes(1);
    expect(malformedTransportFactory).toHaveBeenCalledWith(readiness());
    expect(requester).not.toHaveBeenCalled();
  });

  it("prefers an explicit session factory and tears down the old real scope before requester/transport rebind", async () => {
    setEnvironment("development", "enabled");
    const first = readiness();
    const second = readiness({ missionId: "mission_b", roomId: "room_b", grantVersion: 4 });
    const requester = vi.fn(async (request: { missionId: string; roomId: string }) => issuedToken(request.missionId === "mission_a" ? first : second));
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    const transportFactory = vi.fn((value: ReturnType<typeof readiness>) => value.missionId === "mission_a" ? firstTransport.adapter : secondTransport.adapter);
    const lifecycles: Array<{ start: () => Promise<void> | void; stop: () => Promise<void> | void }> = [];
    seams.publicationPolicy.mockReturnValue({ decide: vi.fn() });
    seams.composition.mockImplementation((options: { sessionFactory: () => BrowserRoomSession | undefined }) => {
      const session = options.sessionFactory();
      const lifecycle = { start: () => session?.start(), stop: () => session?.stop() };
      lifecycles.push(lifecycle);
      return lifecycle;
    });

    AuthenticatedMissionRealtimeLifecycle({ readiness: first, membershipGrantVersion: 3, expectedMissionId: "mission_a", expectedRoomId: "room_a", authenticatedTokenRequester: requester, transportFactory });
    await flush();
    AuthenticatedMissionRealtimeLifecycle({ readiness: second, membershipGrantVersion: 4, expectedMissionId: "mission_b", expectedRoomId: "room_b", authenticatedTokenRequester: requester, transportFactory });
    await flush();
    expect(firstTransport.unsubscribe).toHaveBeenCalledTimes(1);
    expect(secondTransport.connect).toHaveBeenCalledWith(expect.objectContaining({ scope: { missionId: "mission_b", roomId: "room_b" }, token: expect.objectContaining({ authorizationVersion: 4 }) }));
    expect(requester).toHaveBeenNthCalledWith(1, { missionId: "mission_a", roomId: "room_a" });
    expect(requester).toHaveBeenNthCalledWith(2, { missionId: "mission_b", roomId: "room_b" });

    const directSession = { start: vi.fn(), stop: vi.fn() };
    const explicitSessionFactory = vi.fn(() => directSession);
    const hostileRequester = vi.fn(() => { throw new Error("must be bypassed"); });
    AuthenticatedMissionRealtimeLifecycle({ readiness: first, membershipGrantVersion: 3, expectedMissionId: "mission_a", expectedRoomId: "room_a", sessionFactory: explicitSessionFactory, authenticatedTokenRequester: hostileRequester, transportFactory });
    expect(explicitSessionFactory).toHaveBeenCalledWith(first);
    expect(hostileRequester).not.toHaveBeenCalled();
  });
});
