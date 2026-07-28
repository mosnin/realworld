import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  cleanup: undefined as undefined | (() => void),
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

describe("authenticated Mission realtime shell", () => {
  beforeEach(() => {
    seams.cleanup = undefined;
    seams.useEffect.mockImplementation((effect: () => void | (() => void)) => {
      const cleanup = effect();
      seams.cleanup = typeof cleanup === "function" ? cleanup : undefined;
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
      expect(AuthenticatedMissionRealtimeLifecycle({ sessionFactory })).toBeNull();
    }

    expect(seams.composition).not.toHaveBeenCalled();
    expect(seams.sourceFactory).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("fails closed when the session dependency is missing even under the exact opt-in", () => {
    setEnvironment("development", "enabled");
    expect(AuthenticatedMissionRealtimeLifecycle({})).toBeNull();

    expect(seams.composition).not.toHaveBeenCalled();
    expect(seams.sourceFactory).not.toHaveBeenCalled();
  });

  it("uses only the exact development opt-in and starts then cleans up the composed lifecycle", () => {
    setEnvironment("development", "enabled");
    const sessionFactory = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
    const lifecycle = { start: vi.fn(), stop: vi.fn() };
    const policy = { decide: vi.fn() };
    seams.publicationPolicy.mockReturnValue(policy);
    seams.composition.mockReturnValue(lifecycle);

    expect(AuthenticatedMissionRealtimeLifecycle({ sessionFactory })).toBeNull();

    expect(seams.publicationPolicy).toHaveBeenCalledTimes(1);
    expect(seams.composition).toHaveBeenCalledTimes(1);
    expect(seams.composition).toHaveBeenCalledWith({
      environment: "development",
      rawEnabledFlag: "enabled",
      sourceFactory: seams.sourceFactory,
      sessionFactory,
      publicationPolicy: policy,
    });
    expect(seams.sourceFactory).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(seams.cleanup).toBeTypeOf("function");

    seams.cleanup?.();
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a hostile session factory until the strict composition boundary explicitly owns it", () => {
    setEnvironment("development", "enabled");
    const hostileSessionFactory = vi.fn(() => { throw new Error("must not be called by shell"); });
    seams.publicationPolicy.mockReturnValue({ decide: vi.fn() });
    seams.composition.mockReturnValue({ start: vi.fn(), stop: vi.fn() });

    expect(() => AuthenticatedMissionRealtimeLifecycle({ sessionFactory: hostileSessionFactory })).not.toThrow();
    expect(hostileSessionFactory).not.toHaveBeenCalled();
    expect(seams.sourceFactory).not.toHaveBeenCalled();
  });
});
