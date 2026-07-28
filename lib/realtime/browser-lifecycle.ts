/**
 * Browser lifecycle composition for disposable realtime signals.
 *
 * This module never reads the DOM itself and never creates a transport. A
 * browser integration must explicitly inject both an event source and a
 * room-session-shaped dependency after durable authorization is ready.
 */

import type {
  BrowserSignalPublicationContext,
  BrowserSignalPublicationIntent,
  BrowserSignalPublicationPolicy,
} from "./browser-signal-policy";
import type { RealtimeEnvelope } from "./room-session";

export type BrowserLifecycleEvent = "online" | "offline" | "visibilitychange" | "blur" | "focus";

export type BrowserLifecycleSource = Readonly<{
  getContext: () => BrowserSignalPublicationContext;
  addEventListener: (event: BrowserLifecycleEvent, listener: () => void) => void;
  removeEventListener: (event: BrowserLifecycleEvent, listener: () => void) => void;
}>;

/** Bind any Mission/room scope into start before supplying this dependency. */
export type BrowserRoomSession = Readonly<{
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
  publish?: (message: RealtimeEnvelope) => boolean | void | Promise<boolean | void>;
}>;

export type BrowserLifecycleEnvironment = "development" | "test" | "preview" | "production";

export type BrowserRealtimeLifecycleOptions = Readonly<{
  environment: BrowserLifecycleEnvironment;
  enabled?: boolean;
  source?: BrowserLifecycleSource;
  session?: BrowserRoomSession;
  publicationPolicy?: BrowserSignalPublicationPolicy;
}>;

export type BrowserRealtimeLifecycle = Readonly<{
  readonly enabled: boolean;
  readonly active: boolean;
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  publish: (message: RealtimeEnvelope, intent?: BrowserSignalPublicationIntent) => Promise<boolean>;
}>;

/**
 * Disabled by default. Production is always disabled even when a caller passes
 * enabled=true, so constructing this class cannot attach listeners or start a
 * provider-backed dependency.
 */
export class BrowserRealtimeLifecycleController implements BrowserRealtimeLifecycle {
  readonly enabled: boolean;
  private listenersAttached = false;
  private readonly attachedListeners: Array<readonly [BrowserLifecycleEvent, () => void]> = [];
  private wantsSession = false;
  private sessionActive = false;
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrowserRealtimeLifecycleOptions) {
    this.enabled = options.enabled === true && options.environment !== "production";
  }

  get active() {
    return this.sessionActive;
  }

  async start() {
    if (!this.enabled || !this.options.source || !this.options.session) return false;
    if (!this.attachListeners()) return false;
    this.wantsSession = this.currentContext()?.online === true;
    await this.enqueueTransition(this.wantsSession);
    return this.sessionActive;
  }

  async stop() {
    this.wantsSession = false;
    this.detachListeners();
    await this.enqueueTransition(false);
  }

  async publish(message: RealtimeEnvelope, intent?: BrowserSignalPublicationIntent) {
    const context = this.currentContext();
    if (!this.enabled || !context || !this.sessionActive || !this.options.session?.publish || !this.options.publicationPolicy) return false;
    try {
      const decision = this.options.publicationPolicy.decide({ kind: message.kind, payload: message.payload, context, intent });
      if (!decision.allowed) return false;
      const result = await this.options.session.publish(message);
      return result !== false;
    } catch {
      // Policy/session errors are transient flow-control failures, never durable failures.
      return false;
    }
  }

  private currentContext(): BrowserSignalPublicationContext | undefined {
    try {
      const context = this.options.source?.getContext();
      if (context
        && typeof context.online === "boolean"
        && typeof context.visible === "boolean"
        && typeof context.focused === "boolean") return context;
      return undefined;
    } catch {
      return undefined;
    }
  }

  private attachListeners() {
    if (this.listenersAttached) return true;
    const source = this.options.source;
    if (!source) return false;
    try {
      for (const entry of this.listenerEntries()) {
        source.addEventListener(...entry);
        this.attachedListeners.push(entry);
      }
      this.listenersAttached = true;
      return true;
    } catch {
      this.detachListeners();
      return false;
    }
  }

  private detachListeners() {
    if (!this.listenersAttached && this.attachedListeners.length === 0) return;
    const source = this.options.source;
    this.listenersAttached = false;
    if (!source) return;
    for (const [event, listener] of this.attachedListeners.splice(0)) {
      try {
        source.removeEventListener(event, listener);
      } catch {
        // Listener cleanup must not prevent session shutdown.
      }
    }
  }

  private readonly handleOnline = () => {
    this.wantsSession = this.enabled && this.currentContext()?.online === true;
    void this.enqueueTransition(this.wantsSession);
  };

  private readonly handleOffline = () => {
    this.wantsSession = false;
    void this.enqueueTransition(false);
  };

  private readonly handleVisibilityOrBlur = () => {
    // Intentionally no disconnect. The next publish reads injected context and
    // delegates visibility/focus enforcement to the publication policy.
  };

  private listenerEntries(): ReadonlyArray<readonly [BrowserLifecycleEvent, () => void]> {
    return [
      ["online", this.handleOnline],
      ["offline", this.handleOffline],
      ["visibilitychange", this.handleVisibilityOrBlur],
      ["blur", this.handleVisibilityOrBlur],
      ["focus", this.handleVisibilityOrBlur],
    ];
  }

  private enqueueTransition(wantsSession: boolean) {
    const work = this.transition.then(() => this.applyDesiredState(wantsSession));
    this.transition = work.catch(() => undefined);
    return work;
  }

  private async applyDesiredState(wantsSession: boolean) {
    const session = this.options.session;
    if (!session) return;
    if (!wantsSession) {
      if (!this.sessionActive) return;
      // Mark inactive before awaiting stop so concurrent publish calls fail closed.
      this.sessionActive = false;
      try {
        await session.stop();
      } catch {
        // The lifecycle boundary remains offline even if transport cleanup fails.
      }
      return;
    }
    if (this.sessionActive) return;
    try {
      await session.start();
      // An offline event may have arrived while start was in flight.
      if (!this.wantsSession) {
        await session.stop();
        return;
      }
      this.sessionActive = true;
    } catch {
      this.sessionActive = false;
    }
  }
}

export function createBrowserRealtimeLifecycle(options: BrowserRealtimeLifecycleOptions): BrowserRealtimeLifecycle {
  return new BrowserRealtimeLifecycleController(options);
}

/** Safe default for callers that have not passed an explicit non-production seam. */
export const disabledBrowserRealtimeLifecycle: BrowserRealtimeLifecycle = createBrowserRealtimeLifecycle({
  environment: "production",
});
