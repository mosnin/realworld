import { describe, expect, it } from "vitest";

import {
  participantRealtimeActivityCopy,
  participantRealtimeState,
  participantRealtimeStatusLabel,
} from "../../app/realtime/participant-realtime-state";

const readiness = {
  missionId: "mission_a",
  roomId: "room_a",
  grantVersion: 3,
  missionLifecycle: "active" as const,
  roomState: "active" as const,
};
const snapshot = { missionId: "mission_a", roomId: "room_a", grantVersion: 3, state: "live" as const };

function current(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    missionLifecycle: "active",
    missionId: "mission_a",
    roomId: "room_a",
    grantVersion: 3,
    readiness,
    snapshot,
    ...overrides,
  };
}

describe("participant realtime presentation state", () => {
  it("shows the exact eligible room state and maps every public label truthfully", () => {
    expect(participantRealtimeState(current())).toBe("live");
    expect(participantRealtimeStatusLabel("live")).toBe("Live room signals");
    expect(participantRealtimeStatusLabel("connecting")).toBe("Connecting live signals…");
    expect(participantRealtimeStatusLabel("reconnecting")).toBe("Connecting live signals…");
    for (const state of ["idle", "degraded", "unauthorized", "stopped"] as const) {
      expect(participantRealtimeStatusLabel(state)).toBe("Live signals unavailable");
    }
  });

  it("fails closed for feature-off, missing readiness, archive, and every scope or grant mismatch", () => {
    expect(participantRealtimeState(current({ enabled: false }))).toBe("idle");
    expect(participantRealtimeState(current({ readiness: undefined }))).toBe("idle");
    expect(participantRealtimeState(current({ missionLifecycle: "archived" }))).toBe("idle");
    expect(participantRealtimeState(current({ missionId: "mission_b" }))).toBe("idle");
    expect(participantRealtimeState(current({ roomId: "room_b" }))).toBe("idle");
    expect(participantRealtimeState(current({ grantVersion: 4 }))).toBe("idle");
    expect(participantRealtimeState(current({ snapshot: { ...snapshot, grantVersion: 4 } }))).toBe("idle");
  });

  it("never claims occupancy and keeps archived copy read-only", () => {
    expect(participantRealtimeActivityCopy("live", "active")).toContain("Occupancy is not shown");
    expect(participantRealtimeActivityCopy("idle", "active")).toBe("Live room signals are unavailable. Durable room state remains available.");
    expect(participantRealtimeActivityCopy("live", "archived")).toBe("Live room signals are unavailable for this read-only Mission.");
  });
});
