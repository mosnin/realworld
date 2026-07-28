import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireActiveMembership, requireRole, requireWritableMission } from "./lib/auth";

const moveState = v.union(v.literal("proposed"), v.literal("ready"), v.literal("inProgress"), v.literal("blocked"), v.literal("review"), v.literal("completed"), v.literal("cancelled"));
const storedMoveState = v.union(v.literal("proposed"), v.literal("ready"), v.literal("claimed"), v.literal("inProgress"), v.literal("blocked"), v.literal("review"), v.literal("completed"), v.literal("cancelled"), v.literal("archived"));
const receiptMs = 30 * 86400000;
const maxDependencies = 20;

const moveView = v.object({
  _id: v.id("moves"),
  missionId: v.id("missions"),
  roomId: v.optional(v.id("rooms")),
  title: v.string(),
  intent: v.string(),
  dependencyMoveIds: v.array(v.id("moves")),
  state: storedMoveState,
  currentVersion: v.number(),
  updatedAt: v.number(),
});
const moveResult = v.object({ moveId: v.id("moves"), eventId: v.id("missionEvents"), operationReceiptId: v.id("operationReceipts"), currentVersion: v.number() });

function requiredText(value: string, field: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) throw new Error(`Invalid ${field}`);
  return trimmed;
}

function normalizedDependencies(value: Id<"moves">[]) {
  if (value.length > maxDependencies || new Set(value).size !== value.length) throw new Error("Invalid Move dependencies");
  return value;
}

function commandIds(idempotencyKey: string, correlationId: string) {
  return { idempotencyKey: requiredText(idempotencyKey, "idempotency key", 200), correlationId: requiredText(correlationId, "correlation id", 200) };
}

function canReadMove(membership: Awaited<ReturnType<typeof requireActiveMembership>>, move: Pick<Doc<"moves">, "roomId">) {
  return membership.scope.includes("mission:*") || (move.roomId === undefined ? membership.scope.includes("mission:read") : membership.scope.includes(`room:${move.roomId}`));
}

function requireMoveWrite(membership: Awaited<ReturnType<typeof requireActiveMembership>>, move: Pick<Doc<"moves">, "roomId">) {
  requireRole(membership, ["owner", "steward", "builder"]);
  if (!canReadMove(membership, move)) throw new Error("Not found");
}

async function operationReceipt(ctx: MutationCtx, scope: string, idempotencyKey: string) {
  return await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", scope).eq("idempotencyKey", idempotencyKey)).unique();
}

async function assertDependencies(ctx: MutationCtx, missionId: Id<"missions">, membership: Awaited<ReturnType<typeof requireActiveMembership>>, moveId: Id<"moves"> | undefined, dependencies: Id<"moves">[]) {
  normalizedDependencies(dependencies);
  if (moveId !== undefined && dependencies.includes(moveId)) throw new Error("A Move cannot depend on itself");
  const moves = await ctx.db.query("moves").withIndex("by_mission_and_state", (index) => index.eq("missionId", missionId)).collect();
  const byId = new Map(moves.map((move) => [move._id, move]));
  for (const dependencyId of dependencies) { const dependency = byId.get(dependencyId); if (!dependency || !canReadMove(membership, dependency)) throw new Error("Not found"); }
  if (moveId === undefined) return;
  const reachesCandidate = (candidateId: Id<"moves">, visited = new Set<Id<"moves">>()): boolean => {
    if (candidateId === moveId) return true;
    if (visited.has(candidateId)) return false;
    visited.add(candidateId);
    return (byId.get(candidateId)?.dependencyMoveIds ?? []).some((nextId) => reachesCandidate(nextId, visited));
  };
  if (dependencies.some((dependencyId) => reachesCandidate(dependencyId))) throw new Error("Move dependencies cannot form a cycle");
}

async function requireCompletedDependencies(ctx: MutationCtx, move: Doc<"moves">) {
  for (const dependencyId of move.dependencyMoveIds ?? []) {
    const dependency = await ctx.db.get(dependencyId);
    if (!dependency || dependency.missionId !== move.missionId || dependency.state !== "completed") throw new Error("Move dependencies must be completed before ready");
  }
}

function transitionAllowed(current: Doc<"moves">["state"], next: "proposed" | "ready" | "inProgress" | "blocked" | "review" | "completed" | "cancelled") {
  return ({ proposed: ["ready", "cancelled"], ready: ["inProgress", "blocked", "cancelled"], inProgress: ["review", "blocked", "cancelled"], blocked: ["ready", "cancelled"], review: ["completed", "inProgress", "blocked"], completed: [], cancelled: [], claimed: [], archived: [] } as const)[current].includes(next as never);
}

async function recordMoveEvent(ctx: MutationCtx, move: Pick<Doc<"moves">, "missionId" | "_id">, membership: Pick<Doc<"missionMembers">, "principalId" | "role">, type: "move.created" | "move.updated" | "move.transitioned", idempotencyKey: string, correlationId: string, summary: string, beforeVersion: number | undefined, afterVersion: number) {
  const mission = await ctx.db.get(move.missionId);
  if (!mission) throw new Error("Not found");
  const now = Date.now();
  const sequence = mission.eventSequence + 1;
  await ctx.db.patch(mission._id, { eventSequence: sequence, updatedAt: now });
  const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, missionSequence: sequence, type, aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: membership.principalId, effectiveRole: membership.role, correlationId, idempotencyKey, publicSummary: summary, ...(beforeVersion === undefined ? {} : { beforeVersion }), afterVersion, createdAt: now, schemaVersion: 1 });
  return { eventId, now };
}

async function saveReceipt(ctx: MutationCtx, values: { scope: string; idempotencyKey: string; commandFingerprint: string; missionId: Id<"missions">; moveId: Id<"moves">; eventId: Id<"missionEvents">; currentVersion: number; correlationId: string; now: number }) {
  return await ctx.db.insert("operationReceipts", { scope: values.scope, idempotencyKey: values.idempotencyKey, commandFingerprint: values.commandFingerprint, state: "complete", missionId: values.missionId, moveId: values.moveId, eventId: values.eventId, resultVersion: values.currentVersion, correlationId: values.correlationId, createdAt: values.now, expiresAt: values.now + receiptMs, schemaVersion: 1 });
}

export const listMissionMoves = query({
  args: { missionId: v.id("missions") },
  returns: v.array(moveView),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    const moves = await ctx.db.query("moves").withIndex("by_mission_and_state", (index) => index.eq("missionId", args.missionId)).collect();
    return moves.filter((move) => canReadMove(membership, move)).map((move) => ({ _id: move._id, missionId: move.missionId, roomId: move.roomId, title: move.title, intent: move.intent, dependencyMoveIds: move.dependencyMoveIds ?? [], state: move.state, currentVersion: move.currentVersion, updatedAt: move.updatedAt }));
  },
});

export const createMove = mutation({
  args: { missionId: v.id("missions"), roomId: v.optional(v.id("rooms")), title: v.string(), intent: v.string(), dependencyMoveIds: v.array(v.id("moves")), idempotencyKey: v.string(), correlationId: v.string() },
  returns: moveResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireMoveWrite(membership, { roomId: args.roomId });
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId); const title = requiredText(args.title, "Move title", 160); const intent = requiredText(args.intent, "Move intent", 1_000); const dependencies = normalizedDependencies(args.dependencyMoveIds);
    const scope = `mission:${args.missionId}:createMove`; const commandFingerprint = JSON.stringify({ command: "createMove", roomId: args.roomId, title, intent, dependencyMoveIds: dependencies });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) { if (prior.commandFingerprint !== commandFingerprint || prior.moveId === undefined) throw new Error("Idempotency key reuse with a different command"); return { moveId: prior.moveId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion }; }
    await requireWritableMission(ctx, args.missionId);
    if (args.roomId !== undefined) { const room = await ctx.db.get(args.roomId); if (!room || room.missionId !== args.missionId || room.state !== "active") throw new Error("Invalid Move room"); }
    await assertDependencies(ctx, args.missionId, membership, undefined, dependencies);
    const now = Date.now(); const moveId = await ctx.db.insert("moves", { missionId: args.missionId, roomId: args.roomId, title, intent, dependencyMoveIds: dependencies, state: "proposed", currentVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    const event = await recordMoveEvent(ctx, { missionId: args.missionId, _id: moveId }, membership, "move.created", idempotencyKey, correlationId, "Move created", undefined, 1);
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: args.missionId, moveId, eventId: event.eventId, currentVersion: 1, correlationId, now: event.now });
    return { moveId, eventId: event.eventId, operationReceiptId, currentVersion: 1 };
  },
});

export const updateMove = mutation({
  args: { moveId: v.id("moves"), expectedVersion: v.number(), title: v.string(), intent: v.string(), dependencyMoveIds: v.array(v.id("moves")), idempotencyKey: v.string(), correlationId: v.string() },
  returns: moveResult,
  handler: async (ctx, args) => {
    const move = await ctx.db.get(args.moveId); if (!move) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, move.missionId); requireMoveWrite(membership, move);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId); const title = requiredText(args.title, "Move title", 160); const intent = requiredText(args.intent, "Move intent", 1_000); const dependencies = normalizedDependencies(args.dependencyMoveIds);
    const scope = `move:${move._id}:update`; const commandFingerprint = JSON.stringify({ command: "updateMove", expectedVersion: args.expectedVersion, title, intent, dependencyMoveIds: dependencies });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) { if (prior.commandFingerprint !== commandFingerprint || prior.moveId === undefined) throw new Error("Idempotency key reuse with a different command"); return { moveId: prior.moveId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion }; }
    await requireWritableMission(ctx, move.missionId); if (move.currentVersion !== args.expectedVersion) throw new Error("Move version conflict");
    await assertDependencies(ctx, move.missionId, membership, move._id, dependencies);
    const nextVersion = move.currentVersion + 1; const event = await recordMoveEvent(ctx, move, membership, "move.updated", idempotencyKey, correlationId, "Move details updated", move.currentVersion, nextVersion);
    await ctx.db.patch(move._id, { title, intent, dependencyMoveIds: dependencies, currentVersion: nextVersion, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: move.missionId, moveId: move._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { moveId: move._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

export const transitionMove = mutation({
  args: { moveId: v.id("moves"), expectedVersion: v.number(), nextState: moveState, idempotencyKey: v.string(), correlationId: v.string() },
  returns: moveResult,
  handler: async (ctx, args) => {
    const move = await ctx.db.get(args.moveId); if (!move) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, move.missionId); requireMoveWrite(membership, move);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const scope = `move:${move._id}:transition`; const commandFingerprint = JSON.stringify({ command: "transitionMove", expectedVersion: args.expectedVersion, nextState: args.nextState });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) { if (prior.commandFingerprint !== commandFingerprint || prior.moveId === undefined) throw new Error("Idempotency key reuse with a different command"); return { moveId: prior.moveId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion }; }
    await requireWritableMission(ctx, move.missionId); if (move.currentVersion !== args.expectedVersion) throw new Error("Move version conflict");
    if (!transitionAllowed(move.state, args.nextState)) throw new Error("Invalid Move transition");
    if (args.nextState === "ready") await requireCompletedDependencies(ctx, move);
    const nextVersion = move.currentVersion + 1; const event = await recordMoveEvent(ctx, move, membership, "move.transitioned", idempotencyKey, correlationId, `Move transitioned to ${args.nextState}`, move.currentVersion, nextVersion);
    await ctx.db.patch(move._id, { state: args.nextState, currentVersion: nextVersion, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: move.missionId, moveId: move._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { moveId: move._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});
