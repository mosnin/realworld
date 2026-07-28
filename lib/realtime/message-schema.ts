import { z } from "zod";

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(128);
const boundedText = (maxLength: number) => z.string().min(1).max(maxLength);
const unit = z.number().finite().min(0).max(1);
const boundedInteger = (min: number, max: number) => z.number().int().min(min).max(max);

const payloadSchemas = {
  "world.location": z.object({ roomId: opaqueId, mode: z.enum(["map", "room", "away"]), roomSequence: boundedInteger(0, 1_000_000_000) }).strict(),
  "world.selection": z.object({ targetId: opaqueId, mode: z.enum(["map", "inspect", "artifact"]) }).strict(),
  "world.transition": z.object({ sourceRoomId: opaqueId, targetRoomId: opaqueId, effect: z.enum(["enter", "exit", "highlight", "celebrate"]), durableEventId: opaqueId.optional() }).strict(),
  "presence.heartbeat": z.object({ activity: z.enum(["active", "away", "focus"]), privacy: z.enum(["coarse", "hidden"]), roomSequence: boundedInteger(0, 1_000_000_000) }).strict(),
  "presence.leave": z.object({ reason: z.enum(["navigate", "hidden", "disconnect"]) }).strict(),
  "interaction.cursor": z.object({ targetId: opaqueId, x: unit, y: unit, mode: z.enum(["map", "artifact", "comment", "inspect"]) }).strict(),
  "interaction.selection": z.object({ targetId: opaqueId, selectionDigest: opaqueId, mode: z.enum(["object", "range"]) }).strict(),
  "interaction.viewport": z.object({ targetId: opaqueId.optional(), x: unit, y: unit, zoom: z.number().finite().min(0.1).max(8) }).strict(),
  "interaction.typing": z.object({ targetId: opaqueId, isTyping: z.boolean() }).strict(),
  "interaction.drag": z.object({ targetId: opaqueId, x: unit, y: unit, width: unit, height: unit, phase: z.enum(["start", "move", "end", "cancel"]) }).strict(),
  "interaction.attention": z.object({ targetId: opaqueId, reason: z.enum(["review", "question", "celebrate"]) }).strict(),
  "surge.readiness": z.object({ surgeId: opaqueId, state: z.enum(["ready", "here", "away"]) }).strict(),
  "surge.clock": z.object({ surgeId: opaqueId, localTimeMs: z.number().finite().int().min(0).max(9_999_999_999_999), sampleSequence: boundedInteger(0, 1_000_000_000) }).strict(),
  "surge.reaction": z.object({ surgeId: opaqueId, reaction: z.enum(["ready", "focus", "celebrate", "pause"]) }).strict(),
  "agent.public-status": z.object({
    runId: opaqueId,
    state: z.enum(["queued", "researching", "drafting", "awaiting_approval", "paused", "succeeded", "failed", "budget_exhausted"]),
    safeSummary: boundedText(280),
    durableVersion: boundedInteger(1, 1_000_000_000),
    evidenceRef: opaqueId.optional(),
  }).strict(),
} as const;

export type SupportedRealtimeKind = keyof typeof payloadSchemas;
export type RealtimePayloadByKind = { [Kind in SupportedRealtimeKind]: z.infer<(typeof payloadSchemas)[Kind]> };
export type SupportedRealtimePayload = RealtimePayloadByKind[SupportedRealtimeKind];
export type RealtimeChannelFamily = "world" | "presence" | "interaction" | "surge" | "agent-status";

export const channelFamilyByKind: Readonly<Record<SupportedRealtimeKind, RealtimeChannelFamily>> = {
  "world.location": "world", "world.selection": "world", "world.transition": "world",
  "presence.heartbeat": "presence", "presence.leave": "presence",
  "interaction.cursor": "interaction", "interaction.selection": "interaction", "interaction.viewport": "interaction", "interaction.typing": "interaction", "interaction.drag": "interaction", "interaction.attention": "interaction",
  "surge.readiness": "surge", "surge.clock": "surge", "surge.reaction": "surge",
  "agent.public-status": "agent-status",
};

export function isSupportedRealtimeKind(kind: string): kind is SupportedRealtimeKind {
  return Object.hasOwn(payloadSchemas, kind);
}

export function channelFamilyForKind(kind: string): RealtimeChannelFamily | undefined {
  return isSupportedRealtimeKind(kind) ? channelFamilyByKind[kind] : undefined;
}

/** Parses only compact public protocol payloads; unknown kinds fail closed. */
export function parseRealtimePayload(kind: string, payload: unknown): SupportedRealtimePayload | undefined {
  if (!isSupportedRealtimeKind(kind)) return undefined;
  const parsed = payloadSchemas[kind].safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}
