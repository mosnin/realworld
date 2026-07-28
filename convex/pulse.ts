import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireActiveMembership, requireRole } from "./lib/auth";

const defaultLimit = 20;
const maxLimit = 50;

const pulseEntry = v.object({
  _id: v.id("missionEvents"),
  missionId: v.id("missions"),
  eventType: v.string(),
  summary: v.string(),
  actorDisplayName: v.optional(v.string()),
  actorType: v.union(v.literal("human"), v.literal("agent"), v.literal("service")),
  effectiveRole: v.union(v.literal("owner"), v.literal("steward"), v.literal("builder"), v.literal("reviewer"), v.literal("contributor"), v.literal("observer"), v.literal("agent")),
  roomId: v.optional(v.id("rooms")),
  roomTitle: v.optional(v.string()),
  createdAt: v.number(),
});

function isRoomScopedEvent(type: Doc<"missionEvents">["type"]) {
  return type.startsWith("room.")
    || type.startsWith("move.")
    || type.startsWith("call.")
    || type.startsWith("fracture.")
    || type.startsWith("proof.");
}

function canReadMissionWide(membership: Awaited<ReturnType<typeof requireActiveMembership>>) {
  return membership.scope.includes("mission:*") || membership.scope.includes("mission:read");
}

function canReadRoom(membership: Awaited<ReturnType<typeof requireActiveMembership>>, roomId: Id<"rooms">) {
  return membership.scope.includes("mission:*") || membership.scope.includes(`room:${roomId}`);
}

function requirePulseRead(membership: Awaited<ReturnType<typeof requireActiveMembership>>) {
  requireRole(membership, ["owner", "steward", "builder", "reviewer", "contributor"]);
}

async function roomScopeForEvent(ctx: Pick<QueryCtx, "db">, event: Doc<"missionEvents">) {
  // A persisted room target is authoritative even for future event families.
  // Known room event types without an event-time target fail closed for legacy
  // rows instead of consulting mutable aggregate state.
  if (event.roomId === undefined && !isRoomScopedEvent(event.type)) return undefined;
  if (!event.roomId) return null;
  const room = await ctx.db.get(event.roomId);
  if (!room || room.missionId !== event.missionId) return null;
  return room;
}

async function projectEvent(
  ctx: Pick<QueryCtx, "db">,
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  event: Doc<"missionEvents">,
  requestedRoomId: Id<"rooms"> | undefined,
) {
  const room = await roomScopeForEvent(ctx, event);
  if (room === null) return null;
  if (room === undefined) {
    if (requestedRoomId !== undefined || !canReadMissionWide(membership)) return null;
  } else if (requestedRoomId !== undefined ? room._id !== requestedRoomId : !canReadRoom(membership, room._id)) {
    return null;
  }
  const actor = await ctx.db.get(event.actorPrincipalId);
  if (!actor) return null;
  return {
    _id: event._id,
    missionId: event.missionId,
    eventType: event.type,
    summary: event.publicSummary,
    ...(actor.displayName === undefined ? {} : { actorDisplayName: actor.displayName }),
    actorType: actor.type,
    effectiveRole: event.effectiveRole,
    ...(room === undefined ? {} : { roomId: room._id, roomTitle: room.title }),
    createdAt: event.createdAt,
  };
}

export const listMissionPulse = query({
  args: { missionId: v.id("missions"), limit: v.optional(v.number()), roomId: v.optional(v.id("rooms")) },
  returns: v.array(pulseEntry),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requirePulseRead(membership);
    const limit = args.limit ?? defaultLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new Error("Invalid Pulse list limit");
    if (args.roomId !== undefined) {
      const room = await ctx.db.get(args.roomId);
      if (!room || room.missionId !== args.missionId || !canReadRoom(membership, room._id)) throw new Error("Not found");
    }
    const events = await ctx.db
      .query("missionEvents")
      .withIndex("by_mission", (index) => index.eq("missionId", args.missionId))
      .order("desc")
      .take(maxLimit);
    const entries = await Promise.all(events.map((event) => projectEvent(ctx, membership, event, args.roomId)));
    return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null).slice(0, limit);
  },
});
