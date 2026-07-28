/**
 * DOM adapter for BrowserLifecycleSource.
 *
 * Browser dependencies are deliberately injected. Importing this file has no
 * DOM, provider, storage, network, or global side effects.
 */

import type { BrowserLifecycleEvent, BrowserLifecycleSource } from "./browser-lifecycle";

type LifecycleListener = () => void;
type WindowLifecycleEvent = "online" | "offline" | "blur" | "focus";

export type BrowserLifecycleWindowLike = Readonly<{
  addEventListener: (event: WindowLifecycleEvent, listener: LifecycleListener) => void;
  removeEventListener: (event: WindowLifecycleEvent, listener: LifecycleListener) => void;
}>;

export type BrowserLifecycleDocumentLike = Readonly<{
  readonly visibilityState: string;
  hasFocus: () => boolean;
  addEventListener: (event: "visibilitychange", listener: LifecycleListener) => void;
  removeEventListener: (event: "visibilitychange", listener: LifecycleListener) => void;
}>;

export type BrowserLifecycleNavigatorLike = Readonly<{
  readonly onLine: boolean;
}>;

export type DomBrowserLifecycleDependencies = Readonly<{
  window: BrowserLifecycleWindowLike;
  document: BrowserLifecycleDocumentLike;
  navigator: BrowserLifecycleNavigatorLike;
}>;

function failClosedContext() {
  return { online: false, visible: false, focused: false } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Routes lifecycle events to their owning DOM target. The original listener is
 * passed through unchanged, so every remove call uses its exact add identity.
 */
export class DomBrowserLifecycleSource implements BrowserLifecycleSource {
  constructor(private readonly dependencies: DomBrowserLifecycleDependencies) {}

  getContext() {
    try {
      const online = this.dependencies.navigator.onLine === true;
      const visible = this.dependencies.document.visibilityState === "visible";
      const focused = this.dependencies.document.hasFocus() === true;
      return { online, visible, focused };
    } catch {
      return failClosedContext();
    }
  }

  addEventListener(event: BrowserLifecycleEvent, listener: LifecycleListener) {
    if (typeof listener !== "function") throw new TypeError("Browser lifecycle listener must be a function");
    switch (event) {
      case "online":
      case "offline":
      case "blur":
      case "focus":
        this.windowTarget().addEventListener(event, listener);
        return;
      case "visibilitychange":
        this.documentTarget().addEventListener(event, listener);
        return;
      default:
        throw new TypeError("Unsupported browser lifecycle event");
    }
  }

  removeEventListener(event: BrowserLifecycleEvent, listener: LifecycleListener) {
    if (typeof listener !== "function") throw new TypeError("Browser lifecycle listener must be a function");
    switch (event) {
      case "online":
      case "offline":
      case "blur":
      case "focus":
        this.windowTarget().removeEventListener(event, listener);
        return;
      case "visibilitychange":
        this.documentTarget().removeEventListener(event, listener);
        return;
      default:
        throw new TypeError("Unsupported browser lifecycle event");
    }
  }

  private windowTarget(): BrowserLifecycleWindowLike {
    const target = this.dependencies.window;
    if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
      throw new TypeError("Browser lifecycle window dependency is unavailable");
    }
    return target;
  }

  private documentTarget(): BrowserLifecycleDocumentLike {
    const target = this.dependencies.document;
    if (!target || typeof target.addEventListener !== "function" || typeof target.removeEventListener !== "function") {
      throw new TypeError("Browser lifecycle document dependency is unavailable");
    }
    return target;
  }
}

export function createDomBrowserLifecycleSource(dependencies: DomBrowserLifecycleDependencies): BrowserLifecycleSource {
  return new DomBrowserLifecycleSource(dependencies);
}

/**
 * Optional browser convenience seam. It touches globals only when called and
 * returns no source in SSR, workers, or malformed host environments.
 */
export function createDomBrowserLifecycleSourceFromGlobals(): BrowserLifecycleSource | undefined {
  try {
    if (typeof globalThis === "undefined" || !isRecord(globalThis)) return undefined;
    const windowLike = globalThis.window;
    const documentLike = globalThis.document;
    const navigatorLike = globalThis.navigator;
    if (!isRecord(windowLike) || !isRecord(documentLike) || !isRecord(navigatorLike)) return undefined;
    if (typeof windowLike.addEventListener !== "function" || typeof windowLike.removeEventListener !== "function") return undefined;
    if (typeof documentLike.addEventListener !== "function" || typeof documentLike.removeEventListener !== "function" || typeof documentLike.hasFocus !== "function") return undefined;
    if (typeof documentLike.visibilityState !== "string" || typeof navigatorLike.onLine !== "boolean") return undefined;
    return createDomBrowserLifecycleSource({
      window: windowLike as unknown as BrowserLifecycleWindowLike,
      document: documentLike as unknown as BrowserLifecycleDocumentLike,
      navigator: navigatorLike as unknown as BrowserLifecycleNavigatorLike,
    });
  } catch {
    return undefined;
  }
}
