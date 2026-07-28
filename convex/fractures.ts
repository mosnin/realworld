import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireActiveMembership, requireRole, requireWritableMission } from "./lib/auth";

const fractureStatus = v.union(v.literal("open"), v.literal("investigating"), v.literal("resolved"), v.literal("dismissed"));
const fractureSeverity = v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"));
const receiptMs = 30 * 86400000;
const defaultListLimit = 25;
const maxListLimit = 100;

const fractureView = v.object({
  _id: v.id("fractures"),
  missionId: v.id("missions"),
  roomId: v.id("rooms"),
  linkedMoveId: v.optional(v.id("moves")),
  reporterDisplayName: v.optional(v.string()),
  title: v.string(),
  detail: v.string(),
  severity: fractureSeverity,
  status: fractureStatus,
  currentVersion: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  canAdminister: v.boolean(),
});

const fractureResult = v.object({
  fractureId: v.id("fractures"),
  eventId: v.id("missionEvents"),
  operationReceiptId: v.id("operationReceipts"),
  currentVersion: v.number(),
});

function requiredText(value: string, field: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) throw new Error(`Invalid ${field}`);
  return trimmed;
}

function commandIds(idempotencyKey: string, correlationId: string) {
  return {
    idempotencyKey: requiredText(idempotencyKey, "idempotency key", 200),
    correlationId: requiredText(correlationId, "correlation id", 200),
  };
}

function canReadFracture(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  fracture: Pick<Doc<"fractures">, "roomId">,
) {
  return membership.scope.includes("mission:*") || membership.scope.includes(`room:${fracture.roomId}`);
}

function requireFractureRead(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  fracture: Pick<Doc<"fractures">, "roomId">,
) {
  requireRole(membership, ["owner", "steward", "builder", "reviewer", "contributor"]);
  if (!canReadFracture(membership, fracture)) throw new Error("Not found");
}

function requireFractureCreate(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  fracture: Pick<Doc<"fractures">, "roomId">,
) {
  requireRole(membership, ["owner", "steward", "builder", "contributor"]);
  if (!canReadFracture(membership, fracture)) throw new Error("Not found");
}

function requireFractureAdmin(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  fracture: Pick<Doc<"fractures">, "roomId" | "reporterPrincipalId">,
) {
  requireFractureRead(membership, fracture);
  if (!(["owner", "steward"].includes(membership.role) || membership.principalId === fracture.reporterPrincipalId)) {
    throw new Error("Not found");
  }
}

function canAdministerFracture(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  fracture: Pick<Doc<"fractures">, "roomId" | "reporterPrincipalId">,
) {
  return canReadFracture(membership, fracture)
    && (["owner", "steward"].includes(membership.role) || membership.principalId === fracture.reporterPrincipalId);
}

function transitionAllowed(current: Doc<"fractures">["status"], next: Doc<"fractures">["status"]) {
  return ({
    open: ["investigating", "resolved", "dismissed"],
    investigating: ["open", "resolved", "dismissed"],
    resolved: ["open"],
    dismissed: ["open"],
  } as const)[current].includes(next as never);
}

async function operationReceipt(ctx: MutationCtx, scope: string, idempotencyKey: string) {
  return await ctx.db
    .query("operationReceipts")
    .withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", scope).eq("idempotencyKey", idempotencyKey))
    .unique();
}

async function requireFractureRoom(ctx: MutationCtx, missionId: Id<"missions">, roomId: Id<"rooms">) {
  const room = await ctx.db.get(roomId);
  if (!room || room.missionId !== missionId || room.state !== "active") throw new Error("Invalid Fracture room");
}

async function requireLinkedMove(ctx: MutationCtx, missionId: Id<"missions">, roomId: Id<"rooms">, linkedMoveId: Id<"moves"> | undefined) {
  if (linkedMoveId === undefined) return;
  const move = await ctx.db.get(linkedMoveId);
  if (!move || move.missionId !== missionId || move.roomId !== roomId) throw new Error("Not found");
}

async function recordFractureEvent(
  ctx: MutationCtx,
  fracture: Pick<Doc<"fractures">, "missionId" | "roomId">,
  membership: Pick<Doc<"missionMembers">, "principalId" | "role">,
  type: "fracture.created" | "fracture.updated" | "fracture.transitioned",
  idempotencyKey: string,
  correlationId: string,
  summary: string,
  beforeVersion: number | undefined,
  afterVersion: number,
) {
  const mission = await ctx.db.get(fracture.missionId);
  if (!mission) throw new Error("Not found");
  const now = Date.now();
  const eventId = await ctx.db.insert("missionEvents", {
    missionId: mission._id,
    roomId: fracture.roomId,
    type,
    aggregateType: "mission",
    aggregateId: mission._id,
    actorPrincipalId: membership.principalId,
    effectiveRole: membership.role,
    correlationId,
    idempotencyKey,
    publicSummary: summary,
    ...(beforeVersion === undefined ? {} : { beforeVersion }),
    afterVersion,
    createdAt: now,
    schemaVersion: 1,
  });
  return { eventId, now };
}

async function saveReceipt(
  ctx: MutationCtx,
  values: {
    scope: string;
    idempotencyKey: string;
    commandFingerprint: string;
    missionId: Id<"missions">;
    fractureId: Id<"fractures">;
    eventId: Id<"missionEvents">;
    currentVersion: number;
    correlationId: string;
    now: number;
  },
) {
  return await ctx.db.insert("operationReceipts", {
    scope: values.scope,
    idempotencyKey: values.idempotencyKey,
    commandFingerprint: values.commandFingerprint,
    state: "complete",
    missionId: values.missionId,
    fractureId: values.fractureId,
    eventId: values.eventId,
    resultVersion: values.currentVersion,
    correlationId: values.correlationId,
    createdAt: values.now,
    expiresAt: values.now + receiptMs,
    schemaVersion: 1,
  });
}

function replayReceipt(receipt: Doc<"operationReceipts">) {
  if (receipt.fractureId === undefined) throw new Error("Idempotency key reuse with a different command");
  return {
    fractureId: receipt.fractureId,
    eventId: receipt.eventId,
    operationReceiptId: receipt._id,
    currentVersion: receipt.resultVersion,
  };
}

async function fractureProjection(
  ctx: Pick<QueryCtx, "db">,
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  fracture: Doc<"fractures">,
) {
  const reporter = await ctx.db.get(fracture.reporterPrincipalId);
  return {
    _id: fracture._id,
    missionId: fracture.missionId,
    roomId: fracture.roomId,
    linkedMoveId: fracture.linkedMoveId,
    reporterDisplayName: reporter?.displayName,
    title: fracture.title,
    detail: fracture.detail,
    severity: fracture.severity,
    status: fracture.status,
    currentVersion: fracture.currentVersion,
    createdAt: fracture.createdAt,
    updatedAt: fracture.updatedAt,
    canAdminister: canAdministerFracture(membership, fracture),
  };
}

export const listRoomFractures = query({
  args: { roomId: v.id("rooms"), status: v.optional(fractureStatus), limit: v.optional(v.number()) },
  returns: v.array(fractureView),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, room.missionId);
    requireFractureRead(membership, { roomId: room._id });
    const limit = args.limit ?? defaultListLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxListLimit) throw new Error("Invalid Fracture list limit");
    const fractures = args.status === undefined
      ? await ctx.db.query("fractures").withIndex("by_room_and_status", (index) => index.eq("roomId", room._id)).order("desc").take(limit)
      : await ctx.db.query("fractures").withIndex("by_room_and_status", (index) => index.eq("roomId", room._id).eq("status", args.status!)).order("desc").take(limit);
    return await Promise.all(fractures.map((fracture) => fractureProjection(ctx, membership, fracture)));
  },
});

export const listMissionFractures = query({
  args: { missionId: v.id("missions"), limit: v.optional(v.number()) },
  returns: v.array(fractureView),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireRole(membership, ["owner", "steward", "builder", "reviewer", "contributor"]);
    const limit = args.limit ?? defaultListLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxListLimit) throw new Error("Invalid Fracture list limit");
    const candidates = await ctx.db
      .query("fractures")
      .withIndex("by_mission_and_status", (index) => index.eq("missionId", args.missionId))
      .order("desc")
      .take(maxListLimit);
    const visible = candidates.filter((fracture) => canReadFracture(membership, fracture)).slice(0, limit);
    return await Promise.all(visible.map((fracture) => fractureProjection(ctx, membership, fracture)));
  },
});

export const createFracture = mutation({
  args: {
    missionId: v.id("missions"),
    roomId: v.id("rooms"),
    linkedMoveId: v.optional(v.id("moves")),
    title: v.string(),
    detail: v.string(),
    severity: fractureSeverity,
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: fractureResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireFractureCreate(membership, { roomId: args.roomId });
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const title = requiredText(args.title, "Fracture title", 160);
    const detail = requiredText(args.detail, "Fracture detail", 2_000);
    const scope = `mission:${args.missionId}:principal:${membership.principalId}:createFracture`;
    const commandFingerprint = JSON.stringify({ command: "createFracture", roomId: args.roomId, linkedMoveId: args.linkedMoveId, title, detail, severity: args.severity });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command");
      return replayReceipt(prior);
    }
    await requireWritableMission(ctx, args.missionId);
    await requireFractureRoom(ctx, args.missionId, args.roomId);
    await requireLinkedMove(ctx, args.missionId, args.roomId, args.linkedMoveId);
    const now = Date.now();
    const fractureId = await ctx.db.insert("fractures", {
      missionId: args.missionId,
      roomId: args.roomId,
      linkedMoveId: args.linkedMoveId,
      reporterPrincipalId: membership.principalId,
      title,
      detail,
      severity: args.severity,
      status: "open",
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    const event = await recordFractureEvent(ctx, { missionId: args.missionId, roomId: args.roomId }, membership, "fracture.created", idempotencyKey, correlationId, "Fracture reported", undefined, 1);
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: args.missionId, fractureId, eventId: event.eventId, currentVersion: 1, correlationId, now: event.now });
    return { fractureId, eventId: event.eventId, operationReceiptId, currentVersion: 1 };
  },
});

export const updateFracture = mutation({
  args: {
    fractureId: v.id("fractures"),
    expectedVersion: v.number(),
    roomId: v.id("rooms"),
    linkedMoveId: v.union(v.id("moves"), v.null()),
    title: v.string(),
    detail: v.string(),
    severity: fractureSeverity,
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: fractureResult,
  handler: async (ctx, args) => {
    const fracture = await ctx.db.get(args.fractureId);
    if (!fracture) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, fracture.missionId);
    requireFractureAdmin(membership, fracture);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const title = requiredText(args.title, "Fracture title", 160);
    const detail = requiredText(args.detail, "Fracture detail", 2_000);
    const linkedMoveId = args.linkedMoveId ?? undefined;
    const scope = `fracture:${fracture._id}:principal:${membership.principalId}:update`;
    const commandFingerprint = JSON.stringify({ command: "updateFracture", expectedVersion: args.expectedVersion, roomId: args.roomId, linkedMoveId: args.linkedMoveId, title, detail, severity: args.severity });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command");
      return replayReceipt(prior);
    }
    if (fracture.status === "resolved" || fracture.status === "dismissed") throw new Error("Terminal Fractures cannot be updated");
    await requireWritableMission(ctx, fracture.missionId);
    if (fracture.currentVersion !== args.expectedVersion) throw new Error("Fracture version conflict");
    if (!canReadFracture(membership, { roomId: args.roomId })) throw new Error("Not found");
    await requireFractureRoom(ctx, fracture.missionId, args.roomId);
    await requireLinkedMove(ctx, fracture.missionId, args.roomId, linkedMoveId);
    const nextVersion = fracture.currentVersion + 1;
    const event = await recordFractureEvent(ctx, { ...fracture, roomId: args.roomId }, membership, "fracture.updated", idempotencyKey, correlationId, "Fracture details updated", fracture.currentVersion, nextVersion);
    await ctx.db.patch(fracture._id, { roomId: args.roomId, linkedMoveId, title, detail, severity: args.severity, currentVersion: nextVersion, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: fracture.missionId, fractureId: fracture._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { fractureId: fracture._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

export const transitionFracture = mutation({
  args: { fractureId: v.id("fractures"), expectedVersion: v.number(), nextStatus: fractureStatus, idempotencyKey: v.string(), correlationId: v.string() },
  returns: fractureResult,
  handler: async (ctx, args) => {
    const fracture = await ctx.db.get(args.fractureId);
    if (!fracture) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, fracture.missionId);
    requireFractureAdmin(membership, fracture);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const scope = `fracture:${fracture._id}:principal:${membership.principalId}:transition`;
    const commandFingerprint = JSON.stringify({ command: "transitionFracture", expectedVersion: args.expectedVersion, nextStatus: args.nextStatus });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command");
      return replayReceipt(prior);
    }
    await requireWritableMission(ctx, fracture.missionId);
    if (fracture.currentVersion !== args.expectedVersion) throw new Error("Fracture version conflict");
    if (!transitionAllowed(fracture.status, args.nextStatus)) throw new Error("Invalid Fracture transition");
    const nextVersion = fracture.currentVersion + 1;
    const event = await recordFractureEvent(ctx, fracture, membership, "fracture.transitioned", idempotencyKey, correlationId, `Fracture transitioned to ${args.nextStatus}`, fracture.currentVersion, nextVersion);
    await ctx.db.patch(fracture._id, { status: args.nextStatus, currentVersion: nextVersion, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: fracture.missionId, fractureId: fracture._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { fractureId: fracture._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});
