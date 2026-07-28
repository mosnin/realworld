import { describe, expect, it, vi } from "vitest";

import {
  createBrowserRealtimeComposition,
  isBrowserRealtimeExplicitlyEnabled,
} from "../../lib/realtime/browser-realtime-composition";
import { createBrowserSignalPublicationPolicy } from "../../lib/realtime/browser-signal-policy";
import {
  createDomBrowserLifecycleSource,
  createDomBrowserLifecycleSourceFromGlobals,
  type BrowserLifecycleDocumentLike,
  type BrowserLifecycleNavigatorLike,
  type BrowserLifecycleWindowLike,
} from "../../lib/realtime/dom-browser-lifecycle";

function browserDependencies() {
  let visibilityState = "visible";
  let focused = true;
  let online = true;
  const window: BrowserLifecycleWindowLike = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const document: BrowserLifecycleDocumentLike = {
    get visibilityState() { return visibilityState; },
    hasFocus: vi.fn(() => focused),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const navigator: BrowserLifecycleNavigatorLike = {
    get onLine() { return online; },
  };
  return {
    window,
    document,
    navigator,
    setContext: (next: Readonly<{ visibilityState?: string; focused?: boolean; online?: boolean }>) => {
      visibilityState = next.visibilityState ?? visibilityState;
      focused = next.focused ?? focused;
      online = next.online ?? online;
    },
  };
}

function compositionSource() {
  return {
    getContext: () => ({ online: true, visible: true, focused: true }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

describe("DOM browser lifecycle source", () => {
  it("maps injected context and routes each event to its exact owner with identical listener identity", () => {
    const dependencies = browserDependencies();
    const source = createDomBrowserLifecycleSource(dependencies);
    const listener = vi.fn();

    expect(source.getContext()).toEqual({ online: true, visible: true, focused: true });
    dependencies.setContext({ online: false, visibilityState: "hidden", focused: false });
    expect(source.getContext()).toEqual({ online: false, visible: false, focused: false });

    source.addEventListener("online", listener);
    source.addEventListener("offline", listener);
    source.addEventListener("blur", listener);
    source.addEventListener("focus", listener);
    source.addEventListener("visibilitychange", listener);
    source.removeEventListener("online", listener);
    source.removeEventListener("visibilitychange", listener);

    expect(dependencies.window.addEventListener).toHaveBeenNthCalledWith(1, "online", listener);
    expect(dependencies.window.addEventListener).toHaveBeenNthCalledWith(2, "offline", listener);
    expect(dependencies.window.addEventListener).toHaveBeenNthCalledWith(3, "blur", listener);
    expect(dependencies.window.addEventListener).toHaveBeenNthCalledWith(4, "focus", listener);
    expect(dependencies.document.addEventListener).toHaveBeenCalledWith("visibilitychange", listener);
    expect(dependencies.window.removeEventListener).toHaveBeenCalledWith("online", listener);
    expect(dependencies.document.removeEventListener).toHaveBeenCalledWith("visibilitychange", listener);
  });

  it("fails closed when injected context getters throw", () => {
    const source = createDomBrowserLifecycleSource({
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      document: {
        get visibilityState(): string { throw new Error("document getter failed"); },
        hasFocus: vi.fn(() => true), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      },
      navigator: { get onLine(): boolean { throw new Error("navigator getter failed"); } },
    });

    expect(source.getContext()).toEqual({ online: false, visible: false, focused: false });
  });

  it("returns no global source outside a browser and does not mutate global descriptors", () => {
    const before = ["window", "document", "navigator"].map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    expect(createDomBrowserLifecycleSourceFromGlobals()).toBeUndefined();
    const after = ["window", "document", "navigator"].map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    expect(after).toEqual(before);
  });
});

describe("browser realtime composition", () => {
  it("recognizes only the documented literal enable flag", () => {
    expect(isBrowserRealtimeExplicitlyEnabled("enabled")).toBe(true);
    expect(isBrowserRealtimeExplicitlyEnabled(true)).toBe(false);
    expect(isBrowserRealtimeExplicitlyEnabled(false)).toBe(false);
    expect(isBrowserRealtimeExplicitlyEnabled("true")).toBe(false);
    expect(isBrowserRealtimeExplicitlyEnabled(1)).toBe(false);
    expect(isBrowserRealtimeExplicitlyEnabled(undefined)).toBe(false);
  });

  it("keeps default, production, and malformed configurations disabled without invoking factories", async () => {
    const sourceFactory = vi.fn(compositionSource);
    const sessionFactory = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
    const publicationPolicy = createBrowserSignalPublicationPolicy();
    const candidates = [
      undefined,
      { environment: "production", rawEnabledFlag: "enabled", sourceFactory, sessionFactory, publicationPolicy },
      { environment: "preview", rawEnabledFlag: "true", sourceFactory, sessionFactory, publicationPolicy },
      { environment: {}, rawEnabledFlag: "enabled", sourceFactory, sessionFactory, publicationPolicy },
      { environment: "preview", rawEnabledFlag: "enabled", sourceFactory, sessionFactory, publicationPolicy: {} },
    ];

    for (const candidate of candidates) {
      const lifecycle = createBrowserRealtimeComposition(candidate);
      expect(lifecycle.enabled).toBe(false);
      expect(await lifecycle.start()).toBe(false);
    }
    expect(sourceFactory).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("constructs each dependency exactly once for explicit non-production configuration and creates a real lifecycle", async () => {
    const source = compositionSource();
    const session = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const sourceFactory = vi.fn(() => source);
    const sessionFactory = vi.fn(() => session);
    const lifecycle = createBrowserRealtimeComposition({
      environment: "preview", rawEnabledFlag: "enabled", sourceFactory, sessionFactory,
      publicationPolicy: createBrowserSignalPublicationPolicy(),
    });

    expect(sourceFactory).toHaveBeenCalledTimes(1);
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(lifecycle.enabled).toBe(true);
    expect(await lifecycle.start()).toBe(true);
    expect(lifecycle.active).toBe(true);
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(source.addEventListener).toHaveBeenCalledTimes(5);
    await lifecycle.stop();
    expect(session.stop).toHaveBeenCalledTimes(1);
  });

  it("fails closed when either composition factory throws", async () => {
    const publicationPolicy = createBrowserSignalPublicationPolicy();
    const sourceFailure = createBrowserRealtimeComposition({
      environment: "test", rawEnabledFlag: "enabled",
      sourceFactory: vi.fn(() => { throw new Error("source failed"); }),
      sessionFactory: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      publicationPolicy,
    });
    const sessionFactory = vi.fn(() => { throw new Error("session failed"); });
    const sessionFailure = createBrowserRealtimeComposition({
      environment: "test", rawEnabledFlag: "enabled",
      sourceFactory: vi.fn(compositionSource), sessionFactory, publicationPolicy,
    });

    expect(sourceFailure.enabled).toBe(false);
    expect(await sourceFailure.start()).toBe(false);
    expect(sessionFailure.enabled).toBe(false);
    expect(await sessionFailure.start()).toBe(false);
    expect(sessionFactory).toHaveBeenCalledTimes(1);
  });

  it("does not construct a session after a malformed source and fails closed on hostile option getters", async () => {
    const publicationPolicy = createBrowserSignalPublicationPolicy();
    const malformedSessionFactory = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
    const malformedSource = createBrowserRealtimeComposition({
      environment: "preview", rawEnabledFlag: "enabled",
      sourceFactory: vi.fn(() => ({})), sessionFactory: malformedSessionFactory, publicationPolicy,
    });
    const hostileSourceFactory = vi.fn(compositionSource);
    const hostileSessionFactory = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
    const hostileOptions = {
      environment: "preview",
      rawEnabledFlag: "enabled",
      sourceFactory: hostileSourceFactory,
      sessionFactory: hostileSessionFactory,
      get publicationPolicy(): unknown { throw new Error("untrusted getter"); },
    };
    const hostile = createBrowserRealtimeComposition(hostileOptions);

    expect(malformedSource.enabled).toBe(false);
    expect(await malformedSource.start()).toBe(false);
    expect(malformedSessionFactory).not.toHaveBeenCalled();
    expect(hostile.enabled).toBe(false);
    expect(await hostile.start()).toBe(false);
    expect(hostileSourceFactory).not.toHaveBeenCalled();
    expect(hostileSessionFactory).not.toHaveBeenCalled();
  });
});
