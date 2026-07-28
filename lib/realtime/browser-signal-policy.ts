import {
  isSupportedRealtimeKind,
  parseRealtimePayload,
  type SupportedRealtimeKind,
} from "./message-schema";

/** Current browser state supplied by the UI adapter; this module reads no DOM state itself. */
export type BrowserSignalPublicationContext = Readonly<{
  online: boolean;
  visible: boolean;
  focused: boolean;
}>;

/** An exit is explicit so background cleanup cannot accidentally become normal presence traffic. */
export type BrowserSignalPublicationIntent = "normal" | "lifecycle-exit";

export type BrowserSignalPublicationRequest = Readonly<{
  kind: string;
  payload: unknown;
  context: BrowserSignalPublicationContext;
  intent?: BrowserSignalPublicationIntent;
}>;

/** Hidden heartbeats are off by default and, when enabled, may only say away/coarse. */
export type HiddenPresenceHeartbeatPolicy = "deny" | "allow-away-coarse";

export type BrowserSignalPublicationPolicyOptions = Readonly<{
  hiddenPresenceHeartbeatPolicy?: HiddenPresenceHeartbeatPolicy;
}>;

export type BrowserSignalPublicationDenialReason =
  | "offline"
  | "unsupported_kind"
  | "invalid_payload"
  | "invalid_context"
  | "browser_hidden"
  | "browser_unfocused"
  | "hidden_presence_not_allowed"
  | "hidden_presence_not_neutral"
  | "lifecycle_exit_required"
  | "browser_agent_status_forbidden";

export type BrowserSignalPublicationDecision =
  | Readonly<{ allowed: true; kind: SupportedRealtimeKind }>
  | Readonly<{ allowed: false; reason: BrowserSignalPublicationDenialReason }>;

const fineHumanSignals = new Set<SupportedRealtimeKind>([
  "interaction.cursor",
  "interaction.selection",
  "interaction.viewport",
  "interaction.typing",
  "interaction.drag",
  "interaction.attention",
]);

function isPublicationContext(value: unknown): value is BrowserSignalPublicationContext {
  return typeof value === "object"
    && value !== null
    && typeof (value as BrowserSignalPublicationContext).online === "boolean"
    && typeof (value as BrowserSignalPublicationContext).visible === "boolean"
    && typeof (value as BrowserSignalPublicationContext).focused === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hiddenHeartbeatIsNeutral(payload: unknown) {
  const parsed: unknown = parseRealtimePayload("presence.heartbeat", payload);
  return isRecord(parsed) && parsed.activity === "away" && parsed.privacy === "coarse";
}

/**
 * Pure browser-origin publication policy. Schema checks are deliberate: a UI
 * adapter must not receive an allow result for a signal that the transport will
 * later reject. This is an additional local gate, not authorization.
 */
export class BrowserSignalPublicationPolicy {
  private readonly hiddenPresenceHeartbeatPolicy: HiddenPresenceHeartbeatPolicy;

  constructor(options: BrowserSignalPublicationPolicyOptions = {}) {
    this.hiddenPresenceHeartbeatPolicy = options?.hiddenPresenceHeartbeatPolicy === "allow-away-coarse"
      ? "allow-away-coarse"
      : "deny";
  }

  decide(request: BrowserSignalPublicationRequest): BrowserSignalPublicationDecision {
    if (!request || typeof request !== "object" || typeof request.kind !== "string" || !isSupportedRealtimeKind(request.kind)) {
      return { allowed: false, reason: "unsupported_kind" };
    }
    const kind = request.kind;
    if (!isPublicationContext(request.context)) return { allowed: false, reason: "invalid_context" };
    if (!request.context.online) return { allowed: false, reason: "offline" };
    if (kind === "agent.public-status") return { allowed: false, reason: "browser_agent_status_forbidden" };
    if (parseRealtimePayload(kind, request.payload) === undefined) return { allowed: false, reason: "invalid_payload" };

    if (kind === "presence.leave") {
      return request.intent === "lifecycle-exit"
        ? { allowed: true, kind }
        : { allowed: false, reason: "lifecycle_exit_required" };
    }

    if (kind === "presence.heartbeat" && !request.context.visible) {
      if (this.hiddenPresenceHeartbeatPolicy !== "allow-away-coarse") {
        return { allowed: false, reason: "hidden_presence_not_allowed" };
      }
      return hiddenHeartbeatIsNeutral(request.payload)
        ? { allowed: true, kind }
        : { allowed: false, reason: "hidden_presence_not_neutral" };
    }

    if (!request.context.visible) return { allowed: false, reason: "browser_hidden" };
    if (fineHumanSignals.has(kind) && !request.context.focused) {
      return { allowed: false, reason: "browser_unfocused" };
    }
    return { allowed: true, kind };
  }
}

export function createBrowserSignalPublicationPolicy(
  options?: BrowserSignalPublicationPolicyOptions,
): BrowserSignalPublicationPolicy {
  return new BrowserSignalPublicationPolicy(options);
}
