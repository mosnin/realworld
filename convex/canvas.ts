import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireActiveMembership, requireRole, requireWritableMission } from "./lib/auth";

const layout = v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() });
const roomKind = v.union(v.literal("missionCore"), v.literal("workshop"), v.literal("observatory"), v.literal("branchLab"), v.literal("reviewDeck"), v.literal("signalTower"), v.literal("surgeHall"));
const receiptMs = 30 * 86400000;

function validLayout(value: { x: number; y: number; width: number; height: number }) {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.x < 0 || value.x > 1600 || value.y < 0 || value.y > 1200 || value.width < 80 || value.width > 1600 || value.height < 60 || value.height > 1200) throw new Error("Invalid room layout");
  return value;
}

function title(value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) throw new Error("Invalid room title");
  return trimmed;
}

/**
 * A room write is intentionally narrower than Mission membership. A privileged
 * collaborator can write either through their Mission-wide grant or an explicit
 * grant for this room; every other case is indistinguishable from an unknown
 * room to avoid turning mutation failures into room-discovery side channels.
 */
function requireRoomWriteAccess(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  roomId: string,
) {
  requireRole(membership, ["owner", "steward", "builder"]);
  if (!membership.scope.includes("mission:*") && !membership.scope.includes(`room:${roomId}`)) {
    throw new Error("Not found");
  }
}

async function receipt(ctx: MutationCtx, scope: string, idempotencyKey: string) {
  return await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", scope).eq("idempotencyKey", idempotencyKey)).unique();
}

async function recordRoomEvent(ctx: MutationCtx, room: Pick<Doc<"rooms">, "missionId">, member: Pick<Doc<"missionMembers">, "principalId" | "role">, type: "room.created" | "room.renamed" | "room.archived" | "room.layoutUpdated", idempotencyKey: string, summary: string, afterVersion: number) {
  const mission = await ctx.db.get(room.missionId);
  if (!mission) throw new Error("Not found");
  const sequence = mission.eventSequence + 1;
  const now = Date.now();
  await ctx.db.patch(mission._id, { eventSequence: sequence, updatedAt: now });
  const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, missionSequence: sequence, type, aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: member.principalId, effectiveRole: member.role, correlationId: `room:${idempotencyKey}`, idempotencyKey, publicSummary: summary, afterVersion, createdAt: now, schemaVersion: 1 });
  return { eventId, now };
}

export const roomLayouts = query({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({ _id: v.id("rooms"), title: v.string(), kind: roomKind, mapType: v.union(v.literal("field"), v.literal("canvas")), layout, layoutVersion: v.number(), currentVersion: v.number(), accessPolicy: v.union(v.literal("mission"), v.literal("members"), v.literal("restricted")) })),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    const rooms = await ctx.db.query("rooms").withIndex("by_mission_and_state", (index) => index.eq("missionId", args.missionId).eq("state", "active")).take(100);
    const hasMissionScope = ["owner", "steward", "builder"].includes(membership.role) && membership.scope.includes("mission:*");
    const allowedRoomIds = new Set(membership.scope.filter((scope) => scope.startsWith("room:")).map((scope) => scope.slice("room:".length)));
    return rooms.filter((room) => hasMissionScope || allowedRoomIds.has(room._id)).map((room) => ({ _id: room._id, title: room.title, kind: room.kind, mapType: room.mapType, layout: room.layout, layoutVersion: room.layoutVersion, currentVersion: room.currentVersion, accessPolicy: room.accessPolicy }));
  },
});

export const createRoom = mutation({
  args: { missionId: v.id("missions"), title: v.string(), kind: roomKind, layout, idempotencyKey: v.string() },
  returns: v.object({ roomId: v.id("rooms"), currentVersion: v.number(), layoutVersion: v.number() }),
  handler: async (ctx, args) => {
    const member = await requireActiveMembership(ctx, args.missionId);
    requireRole(member, ["owner", "steward", "builder"]);
    const scope = `mission:${args.missionId}:createRoom`;
    const commandFingerprint = JSON.stringify({ command: "createRoom", title: args.title.trim(), kind: args.kind, layout: args.layout });
    const prior = await receipt(ctx, scope, args.idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command");
      const room = prior.roomId === undefined ? null : await ctx.db.get(prior.roomId);
      if (!room) throw new Error("Room receipt is inconsistent");
      return { roomId: room._id, currentVersion: room.currentVersion, layoutVersion: room.layoutVersion };
    }
    await requireWritableMission(ctx, args.missionId);
    const now = Date.now();
    const roomId = await ctx.db.insert("rooms", { missionId: args.missionId, title: title(args.title), kind: args.kind, accessPolicy: "mission", mapType: "field", layout: validLayout(args.layout), layoutVersion: 1, state: "active", currentVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    const event = await recordRoomEvent(ctx, { missionId: args.missionId }, member, "room.created", args.idempotencyKey, "Room created", 1);
    await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint, state: "complete", missionId: args.missionId, eventId: event.eventId, roomId, resultVersion: 1, correlationId: `room:${args.idempotencyKey}`, createdAt: now, expiresAt: now + receiptMs, schemaVersion: 1 });
    return { roomId, currentVersion: 1, layoutVersion: 1 };
  },
});

export const updateRoomLayout = mutation({
  args: { roomId: v.id("rooms"), expectedLayoutVersion: v.number(), layout, idempotencyKey: v.string() },
  returns: v.object({ roomId: v.id("rooms"), layoutVersion: v.number() }),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId); if (!room) throw new Error("Not found");
    const member = await requireActiveMembership(ctx, room.missionId); requireRoomWriteAccess(member, room._id); validLayout(args.layout);
    const scope = `room:${room._id}:layout`; const commandFingerprint = JSON.stringify({ command: "updateRoomLayout", layout: args.layout, expectedLayoutVersion: args.expectedLayoutVersion }); const prior = await receipt(ctx, scope, args.idempotencyKey);
    if (prior) { if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command"); return { roomId: room._id, layoutVersion: prior.resultVersion }; }
    if (room.state !== "active") throw new Error("Not found"); await requireWritableMission(ctx, room.missionId);
    if (room.layoutVersion !== args.expectedLayoutVersion) throw new Error("Room layout version conflict");
    const nextLayoutVersion = room.layoutVersion + 1; const nextRoomVersion = room.currentVersion + 1; const event = await recordRoomEvent(ctx, room, member, "room.layoutUpdated", args.idempotencyKey, "Room layout updated", nextRoomVersion);
    await ctx.db.patch(room._id, { layout: args.layout, layoutVersion: nextLayoutVersion, currentVersion: nextRoomVersion, updatedAt: event.now });
    await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint, state: "complete", missionId: room.missionId, eventId: event.eventId, resultVersion: nextLayoutVersion, correlationId: `room:${args.idempotencyKey}`, createdAt: event.now, expiresAt: event.now + receiptMs, schemaVersion: 1 });
    return { roomId: room._id, layoutVersion: nextLayoutVersion };
  },
});

export const renameRoom = mutation({
  args: { roomId: v.id("rooms"), expectedVersion: v.number(), title: v.string(), idempotencyKey: v.string() },
  returns: v.object({ roomId: v.id("rooms"), currentVersion: v.number() }),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId); if (!room) throw new Error("Not found"); const member = await requireActiveMembership(ctx, room.missionId); requireRoomWriteAccess(member, room._id);
    const scope = `room:${room._id}:rename`; const nextTitle = title(args.title); const commandFingerprint = JSON.stringify({ command: "renameRoom", expectedVersion: args.expectedVersion, title: nextTitle }); const prior = await receipt(ctx, scope, args.idempotencyKey);
    if (prior) { if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command"); return { roomId: room._id, currentVersion: prior.resultVersion }; }
    if (room.state !== "active") throw new Error("Not found"); await requireWritableMission(ctx, room.missionId);
    if (room.currentVersion !== args.expectedVersion) throw new Error("Room version conflict"); const nextVersion = room.currentVersion + 1; const event = await recordRoomEvent(ctx, room, member, "room.renamed", args.idempotencyKey, "Room renamed", nextVersion);
    await ctx.db.patch(room._id, { title: nextTitle, currentVersion: nextVersion, updatedAt: event.now }); await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint, state: "complete", missionId: room.missionId, eventId: event.eventId, resultVersion: nextVersion, correlationId: `room:${args.idempotencyKey}`, createdAt: event.now, expiresAt: event.now + receiptMs, schemaVersion: 1 }); return { roomId: room._id, currentVersion: nextVersion };
  },
});

export const archiveRoom = mutation({
  args: { roomId: v.id("rooms"), expectedVersion: v.number(), idempotencyKey: v.string() },
  returns: v.object({ roomId: v.id("rooms"), currentVersion: v.number() }),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId); if (!room) throw new Error("Not found"); const member = await requireActiveMembership(ctx, room.missionId); requireRoomWriteAccess(member, room._id);
    const scope = `room:${room._id}:archive`; const commandFingerprint = JSON.stringify({ command: "archiveRoom", expectedVersion: args.expectedVersion }); const prior = await receipt(ctx, scope, args.idempotencyKey);
    if (prior) { if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command"); return { roomId: room._id, currentVersion: prior.resultVersion }; }
    if (room.state !== "active") throw new Error("Not found"); await requireWritableMission(ctx, room.missionId);
    if (room.currentVersion !== args.expectedVersion) throw new Error("Room version conflict"); const nextVersion = room.currentVersion + 1; const event = await recordRoomEvent(ctx, room, member, "room.archived", args.idempotencyKey, "Room archived", nextVersion);
    await ctx.db.patch(room._id, { state: "archived", currentVersion: nextVersion, updatedAt: event.now }); await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint, state: "complete", missionId: room.missionId, eventId: event.eventId, resultVersion: nextVersion, correlationId: `room:${args.idempotencyKey}`, createdAt: event.now, expiresAt: event.now + receiptMs, schemaVersion: 1 }); return { roomId: room._id, currentVersion: nextVersion };
  },
});
