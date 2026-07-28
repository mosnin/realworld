import { describe, expect, it } from "vitest";

import {
  channelFamilyForKind,
  isSupportedRealtimeKind,
  parseRealtimePayload,
  type SupportedRealtimeKind,
} from "../../lib/realtime/message-schema";

const validPayloads: Record<SupportedRealtimeKind, unknown> = {
  "world.location": { roomId: "room_a", mode: "room", roomSequence: 2 },
  "world.selection": { targetId: "target_a", mode: "inspect" },
  "world.transition": { sourceRoomId: "room_a", targetRoomId: "room_b", effect: "enter", durableEventId: "event_a" },
  "presence.heartbeat": { activity: "focus", privacy: "coarse", roomSequence: 3 },
  "presence.leave": { reason: "hidden" },
  "interaction.cursor": { targetId: "target_a", x: 0.2, y: 0.8, mode: "artifact" },
  "interaction.selection": { targetId: "target_a", selectionDigest: "digest_a", mode: "range" },
  "interaction.viewport": { targetId: "target_a", x: 0.2, y: 0.8, zoom: 1.25 },
  "interaction.typing": { targetId: "target_a", isTyping: true },
  "interaction.drag": { targetId: "target_a", x: 0.1, y: 0.2, width: 0.3, height: 0.4, phase: "move" },
  "interaction.attention": { targetId: "target_a", reason: "review" },
  "surge.readiness": { surgeId: "surge_a", state: "ready" },
  "surge.clock": { surgeId: "surge_a", localTimeMs: 1_000_000, sampleSequence: 2 },
  "surge.reaction": { surgeId: "surge_a", reaction: "focus" },
  "agent.public-status": { runId: "run_a", state: "drafting", safeSummary: "Drafting the public outline.", durableVersion: 4, evidenceRef: "proof_a" },
};

describe("realtime message schema", () => {
  it("accepts every enumerated public kind and assigns an exact channel family", () => {
    for (const [kind, payload] of Object.entries(validPayloads) as Array<[SupportedRealtimeKind, unknown]>) {
      expect(isSupportedRealtimeKind(kind)).toBe(true);
      expect(channelFamilyForKind(kind)).toMatch(/^(world|presence|interaction|surge|agent-status)$/);
      expect(parseRealtimePayload(kind, payload)).toEqual(payload);
    }
  });

  it("fails closed for unknown kinds, unknown keys, invalid bounds, and private agent fields", () => {
    expect(isSupportedRealtimeKind("agent.private-status")).toBe(false);
    expect(channelFamilyForKind("surge.signal")).toBeUndefined();
    expect(parseRealtimePayload("surge.signal", { surgeId: "surge_a" })).toBeUndefined();

    for (const [kind, payload] of Object.entries(validPayloads) as Array<[SupportedRealtimeKind, Record<string, unknown>]>) {
      expect(parseRealtimePayload(kind, { ...payload, unexpected: "nope" })).toBeUndefined();
    }

    expect(parseRealtimePayload("interaction.cursor", { targetId: "target_a", x: 1.01, y: 0.2, mode: "map" })).toBeUndefined();
    expect(parseRealtimePayload("interaction.cursor", { targetId: "target_a", x: 0.2, y: 0.2, mode: "map", artifactText: "private" })).toBeUndefined();
    expect(parseRealtimePayload("presence.heartbeat", { activity: "active", privacy: "coarse", roomSequence: -1 })).toBeUndefined();
    expect(parseRealtimePayload("agent.public-status", {
      runId: "run_a", state: "drafting", safeSummary: "Safe", durableVersion: 1, privateReasoning: "never transport chain of thought",
    })).toBeUndefined();
    expect(parseRealtimePayload("agent.public-status", {
      runId: "run_a", state: "drafting", safeSummary: "Safe", durableVersion: 1, toolArguments: { secret: "never transport" },
    })).toBeUndefined();
  });
});
