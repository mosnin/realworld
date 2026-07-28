import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireActiveMembership, requireRole, requireWritableMission } from "./lib/auth";

const callStatus = v.union(
  v.literal("open"),
  v.literal("accepted"),
  v.literal("resolved"),
  v.literal("cancelled"),
);
const transitionStatus = v.union(v.literal("open"), v.literal("accepted"), v.literal("resolved"), v.literal("cancelled"));
const receiptMs = 30 * 86400000;
const maxListSize = 100;

const callView = v.object({
  _id: v.id("calls"),
  missionId: v.id("missions"),
  roomId: v.optional(v.id("rooms")),
  linkedMoveId: v.optional(v.id("moves")),
  creatorPrincipalId: v.id("principals"),
  title: v.string(),
  detail: v.string(),
  status: callStatus,
  currentVersion: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
const callResult = v.object({
  callId: v.id("calls"),
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

function canReadCall(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  call: Pick<Doc<"calls">, "roomId">,
) {
  return membership.scope.includes("mission:*") || (
    call.roomId === undefined
      ? membership.scope.includes("mission:read")
      : membership.scope.includes(`room:${call.roomId}`)
  );
}

function requireCallWrite(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  call: Pick<Doc<"calls">, "roomId">,
) {
  requireRole(membership, ["owner", "steward", "builder", "contributor"]);
  if (!canReadCall(membership, call)) throw new Error("Not found");
}

function isTransitionAllowed(current: Doc<"calls">["status"], next: Doc<"calls">["status"]) {
  return ({
    open: ["accepted", "cancelled"],
    accepted: ["open", "resolved", "cancelled"],
    resolved: [],
    cancelled: [],
  } as const)[current].includes(next as never);
}

async function operationReceipt(ctx: MutationCtx, scope: string, idempotencyKey: string) {
  return await ctx.db
    .query("operationReceipts")
    .withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", scope).eq("idempotencyKey", idempotencyKey))
    .unique();
}

async function requireCallRoom(
  ctx: MutationCtx,
  missionId: Id<"missions">,
  roomId: Id<"rooms"> | undefined,
) {
  if (roomId === undefined) return;
  const room = await ctx.db.get(roomId);
  if (!room || room.missionId !== missionId || room.state !== "active") throw new Error("Invalid Call room");
}

async function requireVisibleLinkedMove(
  ctx: MutationCtx,
  missionId: Id<"missions">,
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  callRoomId: Id<"rooms"> | undefined,
  linkedMoveId: Id<"moves"> | undefined,
) {
  if (linkedMoveId === undefined) return;
  const move = await ctx.db.get(linkedMoveId);
  if (!move || move.missionId !== missionId || move.roomId !== callRoomId || !canReadCall(membership, move)) throw new Error("Not found");
}

async function recordCallEvent(
  ctx: MutationCtx,
  call: Pick<Doc<"calls">, "missionId">,
  membership: Pick<Doc<"missionMembers">, "principalId" | "role">,
  type: "call.created" | "call.updated" | "call.transitioned",
  idempotencyKey: string,
  correlationId: string,
  summary: string,
  beforeVersion: number | undefined,
  afterVersion: number,
) {
  const mission = await ctx.db.get(call.missionId);
  if (!mission) throw new Error("Not found");
  const now = Date.now();
  const sequence = mission.eventSequence + 1;
  await ctx.db.patch(mission._id, { eventSequence: sequence, updatedAt: now });
  const eventId = await ctx.db.insert("missionEvents", {
    missionId: mission._id,
    missionSequence: sequence,
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
    callId: Id<"calls">;
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
    callId: values.callId,
    eventId: values.eventId,
    resultVersion: values.currentVersion,
    correlationId: values.correlationId,
    createdAt: values.now,
    expiresAt: values.now + receiptMs,
    schemaVersion: 1,
  });
}

export const listMissionCalls = query({
  args: { missionId: v.id("missions"), limit: v.optional(v.number()) },
  returns: v.array(callView),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    const limit = args.limit ?? maxListSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxListSize) throw new Error("Invalid Call list limit");
    const calls = await ctx.db
      .query("calls")
      .withIndex("by_mission", (index) => index.eq("missionId", args.missionId))
      .order("desc")
      .take(limit);
    return calls
      .filter((call) => canReadCall(membership, call))
      .map((call) => ({
        _id: call._id,
        missionId: call.missionId,
        roomId: call.roomId,
        linkedMoveId: call.linkedMoveId,
        creatorPrincipalId: call.creatorPrincipalId,
        title: call.title,
        detail: call.detail,
        status: call.status,
        currentVersion: call.currentVersion,
        createdAt: call.createdAt,
        updatedAt: call.updatedAt,
      }));
  },
});

export const createCall = mutation({
  args: {
    missionId: v.id("missions"),
    roomId: v.optional(v.id("rooms")),
    linkedMoveId: v.optional(v.id("moves")),
    title: v.string(),
    detail: v.string(),
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: callResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireCallWrite(membership, { roomId: args.roomId });
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const title = requiredText(args.title, "Call title", 160);
    const detail = requiredText(args.detail, "Call detail", 2_000);
    const scope = `mission:${args.missionId}:createCall`;
    const commandFingerprint = JSON.stringify({ command: "createCall", roomId: args.roomId, linkedMoveId: args.linkedMoveId, title, detail });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.callId === undefined) throw new Error("Idempotency key reuse with a different command");
      return { callId: prior.callId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion };
    }
    await requireWritableMission(ctx, args.missionId);
    await requireCallRoom(ctx, args.missionId, args.roomId);
    await requireVisibleLinkedMove(ctx, args.missionId, membership, args.roomId, args.linkedMoveId);
    const now = Date.now();
    const callId = await ctx.db.insert("calls", {
      missionId: args.missionId,
      roomId: args.roomId,
      linkedMoveId: args.linkedMoveId,
      creatorPrincipalId: membership.principalId,
      title,
      detail,
      status: "open",
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    const event = await recordCallEvent(ctx, { missionId: args.missionId }, membership, "call.created", idempotencyKey, correlationId, "Call created", undefined, 1);
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: args.missionId, callId, eventId: event.eventId, currentVersion: 1, correlationId, now: event.now });
    return { callId, eventId: event.eventId, operationReceiptId, currentVersion: 1 };
  },
});

export const updateCall = mutation({
  args: {
    callId: v.id("calls"),
    expectedVersion: v.number(),
    roomId: v.optional(v.id("rooms")),
    linkedMoveId: v.union(v.id("moves"), v.null()),
    title: v.string(),
    detail: v.string(),
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: callResult,
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    requireCallWrite(membership, call);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const title = requiredText(args.title, "Call title", 160);
    const detail = requiredText(args.detail, "Call detail", 2_000);
    const linkedMoveId = args.linkedMoveId ?? undefined;
    const scope = `call:${call._id}:update`;
    const commandFingerprint = JSON.stringify({ command: "updateCall", expectedVersion: args.expectedVersion, roomId: args.roomId, linkedMoveId: args.linkedMoveId, title, detail });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.callId === undefined) throw new Error("Idempotency key reuse with a different command");
      return { callId: prior.callId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion };
    }
    if (call.status === "resolved" || call.status === "cancelled") throw new Error("Terminal Calls cannot be updated");
    await requireWritableMission(ctx, call.missionId);
    if (call.currentVersion !== args.expectedVersion) throw new Error("Call version conflict");
    requireCallWrite(membership, { roomId: args.roomId });
    await requireCallRoom(ctx, call.missionId, args.roomId);
    await requireVisibleLinkedMove(ctx, call.missionId, membership, args.roomId, linkedMoveId);
    const nextVersion = call.currentVersion + 1;
    const event = await recordCallEvent(ctx, call, membership, "call.updated", idempotencyKey, correlationId, "Call details updated", call.currentVersion, nextVersion);
    await ctx.db.patch(call._id, { roomId: args.roomId, linkedMoveId, title, detail, currentVersion: nextVersion, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { callId: call._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

export const transitionCall = mutation({
  args: { callId: v.id("calls"), expectedVersion: v.number(), nextStatus: transitionStatus, idempotencyKey: v.string(), correlationId: v.string() },
  returns: callResult,
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    requireCallWrite(membership, call);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const scope = `call:${call._id}:transition`;
    const commandFingerprint = JSON.stringify({ command: "transitionCall", expectedVersion: args.expectedVersion, nextStatus: args.nextStatus });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.callId === undefined) throw new Error("Idempotency key reuse with a different command");
      return { callId: prior.callId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion };
    }
    await requireWritableMission(ctx, call.missionId);
    if (call.currentVersion !== args.expectedVersion) throw new Error("Call version conflict");
    if (!isTransitionAllowed(call.status, args.nextStatus)) throw new Error("Invalid Call transition");
    const nextVersion = call.currentVersion + 1;
    const event = await recordCallEvent(ctx, call, membership, "call.transitioned", idempotencyKey, correlationId, `Call transitioned to ${args.nextStatus}`, call.currentVersion, nextVersion);
    await ctx.db.patch(call._id, { status: args.nextStatus, currentVersion: nextVersion, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { callId: call._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});
