import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireActiveMembership, requireRole } from "./lib/auth";

const layout = v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() });
function valid(value: { x: number; y: number; width: number; height: number }) { if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.width < 80 || value.width > 1600 || value.height < 60 || value.height > 1200) throw new Error("Invalid room layout"); return value; }

export const roomLayouts = query({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({ _id: v.id("rooms"), title: v.string(), kind: v.string(), mapType: v.union(v.literal("field"), v.literal("canvas")), layout, layoutVersion: v.number() })),
  handler: async (ctx, args) => { await requireActiveMembership(ctx, args.missionId); const rooms = await ctx.db.query("rooms").withIndex("by_mission_and_state", q => q.eq("missionId", args.missionId).eq("state", "active")).take(100); return rooms.map(room => ({ _id: room._id, title: room.title, kind: room.kind, mapType: room.mapType, layout: room.layout, layoutVersion: room.layoutVersion })); },
});

export const updateRoomLayout = mutation({
  args: { roomId: v.id("rooms"), expectedLayoutVersion: v.number(), layout, idempotencyKey: v.string() },
  returns: v.object({ roomId: v.id("rooms"), layoutVersion: v.number() }),
  handler: async (ctx, args) => { const room = await ctx.db.get(args.roomId); if (!room || room.state !== "active") throw new Error("Not found"); const member = await requireActiveMembership(ctx, room.missionId); requireRole(member, ["owner", "steward", "builder"]); valid(args.layout); const scope = `room:${room._id}:layout`; const fp = JSON.stringify({ layout: args.layout, expectedLayoutVersion: args.expectedLayoutVersion }); const prior = await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", q => q.eq("scope", scope).eq("idempotencyKey", args.idempotencyKey)).unique(); if (prior) { if (prior.commandFingerprint !== fp) throw new Error("Idempotency key reuse with a different command"); return { roomId: room._id, layoutVersion: prior.resultVersion }; } if (room.layoutVersion !== args.expectedLayoutVersion) throw new Error("Room layout version conflict"); const now = Date.now(); const next = room.layoutVersion + 1; await ctx.db.patch(room._id, { layout: args.layout, layoutVersion: next, currentVersion: room.currentVersion + 1, updatedAt: now }); const eventId = await ctx.db.insert("missionEvents", { missionId: room.missionId, missionSequence: (await ctx.db.get(room.missionId))!.eventSequence + 1, type: "membership.invited", aggregateType: "mission", aggregateId: room.missionId, actorPrincipalId: member.principalId, effectiveRole: member.role, correlationId: `layout:${args.idempotencyKey}`, idempotencyKey: args.idempotencyKey, publicSummary: "Room layout updated", afterVersion: room.currentVersion + 1, createdAt: now, schemaVersion: 1 }); await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint: fp, state: "complete", missionId: room.missionId, eventId, resultVersion: next, correlationId: `layout:${args.idempotencyKey}`, createdAt: now, expiresAt: now + 30 * 86400000, schemaVersion: 1 }); return { roomId: room._id, layoutVersion: next }; },
});
