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
});
