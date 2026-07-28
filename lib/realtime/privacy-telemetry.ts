/**
 * Privacy-safe telemetry for disposable realtime signals.
 *
 * This boundary intentionally retains only allowlisted classifications and
 * bounded measurements. It never forwards raw payloads, identifiers, scopes,
 * credentials, capabilities, or provider error text.
 */

import { channelFamilyForKind, isSupportedRealtimeKind, type RealtimeChannelFamily, type SupportedRealtimeKind } from "./message-schema";

export type RealtimeTelemetryEvent =
  | "connect_requested"
  | "connect_ready"
  | "connect_failed"
  | "subscription_changed"
  | "signal_received"
  | "signal_published"
  | "signal_dropped"
  | "governor_limited"
  | "cleanup";

export type RealtimeTelemetryReason =
  | "authorization_denied"
  | "capability_denied"
  | "connection_timeout"
  | "connection_unavailable"
  | "closed"
  | "expired"
  | "malformed"
  | "out_of_scope"
  | "oversized"
  | "schema_invalid"
  | "unsupported_kind"
  | "rate_limited";

export type RealtimeTelemetryState =
  | "idle"
  | "connecting"
  | "live"
  | "degraded"
  | "reconnecting"
  | "unauthorized"
  | "stopped";

export type PrivacySafeRealtimeTelemetryEvent = Readonly<{
  event: RealtimeTelemetryEvent;
  reason?: RealtimeTelemetryReason;
  kind?: SupportedRealtimeKind;
  family?: RealtimeChannelFamily;
  state?: RealtimeTelemetryState;
  count?: number;
  durationMs?: number;
  attempt?: number;
  subscriptions?: number;
}>;

export type PrivacySafeRealtimeTelemetrySink = (event: PrivacySafeRealtimeTelemetryEvent) => void;

export type PrivacySafeRealtimeTelemetryOptions = Readonly<{
  enabled?: boolean;
  sink?: PrivacySafeRealtimeTelemetrySink;
}>;

export type PrivacySafeRealtimeTelemetry = Readonly<{
  readonly enabled: boolean;
  scrub: (candidate: unknown) => PrivacySafeRealtimeTelemetryEvent | undefined;
  emit: (candidate: unknown) => void;
}>;

const knownEvents = new Set<RealtimeTelemetryEvent>([
  "connect_requested", "connect_ready", "connect_failed", "subscription_changed", "signal_received", "signal_published", "signal_dropped", "governor_limited", "cleanup",
]);
const knownReasons = new Set<RealtimeTelemetryReason>([
  "authorization_denied", "capability_denied", "connection_timeout", "connection_unavailable", "closed", "expired", "malformed", "out_of_scope", "oversized", "schema_invalid", "unsupported_kind", "rate_limited",
]);
const knownStates = new Set<RealtimeTelemetryState>([
  "idle", "connecting", "live", "degraded", "reconnecting", "unauthorized", "stopped",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function allowedInteger(value: unknown, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

/**
 * Produces a fresh, allowlisted record. Unknown fields are never copied, so
 * callers may safely pass broad runtime objects without leaking sensitive data.
 */
function scrubRealtimeTelemetryUnchecked(candidate: unknown): PrivacySafeRealtimeTelemetryEvent | undefined {
  if (!isRecord(candidate) || typeof candidate.event !== "string" || !knownEvents.has(candidate.event as RealtimeTelemetryEvent)) {
    return undefined;
  }
  const event: {
    event: RealtimeTelemetryEvent;
    reason?: RealtimeTelemetryReason;
    kind?: SupportedRealtimeKind;
    family?: RealtimeChannelFamily;
    state?: RealtimeTelemetryState;
    count?: number;
    durationMs?: number;
    attempt?: number;
    subscriptions?: number;
  } = { event: candidate.event as RealtimeTelemetryEvent };
  if (typeof candidate.reason === "string" && knownReasons.has(candidate.reason as RealtimeTelemetryReason)) {
    event.reason = candidate.reason as RealtimeTelemetryReason;
  }
  if (typeof candidate.state === "string" && knownStates.has(candidate.state as RealtimeTelemetryState)) {
    event.state = candidate.state as RealtimeTelemetryState;
  }
  if (typeof candidate.kind === "string" && isSupportedRealtimeKind(candidate.kind)) {
    event.kind = candidate.kind;
  }
  if (typeof candidate.family === "string" && ["world", "presence", "interaction", "surge", "agent-status"].includes(candidate.family)) {
    event.family = candidate.family as RealtimeChannelFamily;
  }
  if (event.kind && event.family && channelFamilyForKind(event.kind) !== event.family) return undefined;

  const count = allowedInteger(candidate.count, 100_000);
  const durationMs = allowedInteger(candidate.durationMs, 120_000);
  const attempt = allowedInteger(candidate.attempt, 100);
  const subscriptions = allowedInteger(candidate.subscriptions, 5);
  if (count !== undefined) event.count = count;
  if (durationMs !== undefined) event.durationMs = durationMs;
  if (attempt !== undefined) event.attempt = attempt;
  if (subscriptions !== undefined) event.subscriptions = subscriptions;
  return event;
}

export function scrubRealtimeTelemetry(candidate: unknown): PrivacySafeRealtimeTelemetryEvent | undefined {
  try {
    return scrubRealtimeTelemetryUnchecked(candidate);
  } catch {
    return undefined;
  }
}

/** A sink failure is intentionally invisible to realtime product flow. */
export class PrivacySafeRealtimeTelemetryBoundary implements PrivacySafeRealtimeTelemetry {
  readonly enabled: boolean;

  constructor(private readonly options: PrivacySafeRealtimeTelemetryOptions = {}) {
    this.enabled = options.enabled === true && typeof options.sink === "function";
  }

  scrub(candidate: unknown) {
    return scrubRealtimeTelemetry(candidate);
  }

  emit(candidate: unknown) {
    if (!this.enabled) return;
    const event = this.scrub(candidate);
    if (!event) return;
    try {
      this.options.sink?.(event);
    } catch {
      // Telemetry must never alter product control flow.
    }
  }
}

export function createPrivacySafeRealtimeTelemetry(options: PrivacySafeRealtimeTelemetryOptions = {}): PrivacySafeRealtimeTelemetry {
  return new PrivacySafeRealtimeTelemetryBoundary(options);
}

/** Explicit default for adapters and governors that have no approved sink. */
export const disabledRealtimeTelemetry: PrivacySafeRealtimeTelemetry = createPrivacySafeRealtimeTelemetry();
