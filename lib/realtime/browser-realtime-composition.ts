/**
 * Explicit, provider-free composition seam for browser realtime lifecycle.
 *
 * Configuration and dependency creation deliberately happen here rather than
 * in the lifecycle controller. This module never reads ambient configuration,
 * browser APIs, credentials, or durable room state.
 */

import {
  createBrowserRealtimeLifecycle,
  disabledBrowserRealtimeLifecycle,
  type BrowserLifecycleEnvironment,
  type BrowserLifecycleSource,
  type BrowserRealtimeLifecycle,
  type BrowserRoomSession,
} from "./browser-lifecycle";
import type { BrowserSignalPublicationPolicy } from "./browser-signal-policy";

/**
 * `rawEnabledFlag` intentionally accepts untrusted public configuration. Only
 * the documented string literal `"enabled"` enables the non-production seam.
 */
export type BrowserRealtimeCompositionOptions = Readonly<{
  environment: unknown;
  rawEnabledFlag?: unknown;
  sourceFactory?: unknown;
  sessionFactory?: unknown;
  publicationPolicy?: unknown;
}>;

type BrowserRealtimeSourceFactory = () => BrowserLifecycleSource;
type BrowserRealtimeSessionFactory = () => BrowserRoomSession;

function isNonProductionEnvironment(value: unknown): value is Exclude<BrowserLifecycleEnvironment, "production"> {
  return value === "development" || value === "test" || value === "preview";
}

function isPublicationPolicy(value: unknown): value is BrowserSignalPublicationPolicy {
  return typeof value === "object"
    && value !== null
    && typeof (value as BrowserSignalPublicationPolicy).decide === "function";
}

function isBrowserLifecycleSource(value: unknown): value is BrowserLifecycleSource {
  return typeof value === "object"
    && value !== null
    && typeof (value as BrowserLifecycleSource).getContext === "function"
    && typeof (value as BrowserLifecycleSource).addEventListener === "function"
    && typeof (value as BrowserLifecycleSource).removeEventListener === "function";
}

function isBrowserRoomSession(value: unknown): value is BrowserRoomSession {
  return typeof value === "object"
    && value !== null
    && typeof (value as BrowserRoomSession).start === "function"
    && typeof (value as BrowserRoomSession).stop === "function";
}

/** A raw setting has exactly one enabling value; booleans and truthy values fail closed. */
export function isBrowserRealtimeExplicitlyEnabled(rawEnabledFlag: unknown): rawEnabledFlag is "enabled" {
  return rawEnabledFlag === "enabled";
}

/**
 * Creates an enabled lifecycle only after an explicit non-production opt-in.
 * Factories are not inspected or invoked on every disabled path, including
 * malformed configuration, so this boundary cannot accidentally construct a
 * provider-backed dependency in production.
 */
export function createBrowserRealtimeComposition(
  options: BrowserRealtimeCompositionOptions | undefined,
): BrowserRealtimeLifecycle {
  try {
    if (!options
      || !isNonProductionEnvironment(options.environment)
      || !isBrowserRealtimeExplicitlyEnabled(options.rawEnabledFlag)
      || typeof options.sourceFactory !== "function"
      || typeof options.sessionFactory !== "function"
      || !isPublicationPolicy(options.publicationPolicy)) {
      return disabledBrowserRealtimeLifecycle;
    }

    const source = (options.sourceFactory as BrowserRealtimeSourceFactory)();
    // Do not construct a session/provider when the browser source is malformed.
    if (!isBrowserLifecycleSource(source)) return disabledBrowserRealtimeLifecycle;

    const session = (options.sessionFactory as BrowserRealtimeSessionFactory)();
    if (!isBrowserRoomSession(session)) return disabledBrowserRealtimeLifecycle;

    return createBrowserRealtimeLifecycle({
      environment: options.environment,
      enabled: true,
      source,
      session,
      publicationPolicy: options.publicationPolicy,
    });
  } catch {
    // Factory failures are configuration failures; no fallback transport exists.
    return disabledBrowserRealtimeLifecycle;
  }
}
