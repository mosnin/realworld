import type { DurableRoomReadiness } from "./durable-room-session-factory";
import type { RoomSessionState } from "@/lib/realtime/room-session";

export type ParticipantRealtimeSnapshot = Readonly<{
  missionId: string;
  roomId: string;
  grantVersion: number;
  state: RoomSessionState;
}>;

type ParticipantRealtimeStateInput = Readonly<{
  enabled: boolean;
  missionLifecycle: unknown;
  missionId: unknown;
  roomId: unknown;
  grantVersion: unknown;
  readiness: unknown;
  snapshot: ParticipantRealtimeSnapshot | null;
}>;

function isExactActiveReadiness(
  value: unknown,
  missionId: unknown,
  roomId: unknown,
  grantVersion: unknown,
): value is DurableRoomReadiness {
  if (!value || typeof value !== "object") return false;
  const readiness = value as Partial<DurableRoomReadiness>;
  return readiness.missionLifecycle === "active"
    && readiness.roomState === "active"
    && readiness.missionId === missionId
    && readiness.roomId === roomId
    && readiness.grantVersion === grantVersion;
}

/** Returns no live claim unless the current durable authorization still matches exactly. */
export function participantRealtimeState(input: ParticipantRealtimeStateInput): RoomSessionState {
  if (!input.enabled
    || input.missionLifecycle !== "active"
    || typeof input.missionId !== "string"
    || typeof input.roomId !== "string"
    || typeof input.grantVersion !== "number"
    || !Number.isSafeInteger(input.grantVersion)
    || input.grantVersion <= 0
    || !isExactActiveReadiness(input.readiness, input.missionId, input.roomId, input.grantVersion)
    || input.snapshot === null
    || input.snapshot.missionId !== input.missionId
    || input.snapshot.roomId !== input.roomId
    || input.snapshot.grantVersion !== input.grantVersion) return "idle";
  return input.snapshot.state;
}

export function participantRealtimeStatusLabel(state: RoomSessionState) {
  if (state === "live") return "Live room signals";
  if (state === "connecting" || state === "reconnecting") return "Connecting live signals…";
  return "Live signals unavailable";
}

export function participantRealtimeActivityCopy(state: RoomSessionState, missionLifecycle: unknown) {
  if (missionLifecycle !== "active") return "Live room signals are unavailable for this read-only Mission.";
  if (state === "live") return "Live room transport is connected. Occupancy is not shown until a privacy-safe identity projection exists.";
  return "Live room signals are unavailable. Durable room state remains available.";
}
