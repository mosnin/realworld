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
const maxHistorySize = 50;

const callView = v.object({
  _id: v.id("calls"),
  missionId: v.id("missions"),
  roomId: v.optional(v.id("rooms")),
  linkedMoveId: v.optional(v.id("moves")),
  creatorPrincipalId: v.id("principals"),
  title: v.string(),
  detail: v.string(),
  maxParticipants: v.number(),
  joinedCount: v.number(),
  deadlineAt: v.optional(v.number()),
  resolutionSummary: v.optional(v.string()),
  resolvedAt: v.optional(v.number()),
  canAdminister: v.boolean(),
  status: callStatus,
  currentVersion: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
const responseHistoryView = v.object({
  _id: v.id("callResponseRevisions"),
  callId: v.id("calls"),
  displayName: v.optional(v.string()),
  role: v.optional(v.union(
    v.literal("owner"),
    v.literal("steward"),
    v.literal("builder"),
    v.literal("reviewer"),
    v.literal("contributor"),
    v.literal("observer"),
    v.literal("agent"),
  )),
  isCurrentUser: v.boolean(),
  revision: v.number(),
  response: v.string(),
  createdAt: v.number(),
});
const participantView = v.object({
  _id: v.id("callParticipants"),
  callId: v.id("calls"),
  displayName: v.optional(v.string()),
  role: v.optional(v.union(
    v.literal("owner"),
    v.literal("steward"),
    v.literal("builder"),
    v.literal("reviewer"),
    v.literal("contributor"),
    v.literal("observer"),
    v.literal("agent"),
  )),
  isCurrentUser: v.boolean(),
  response: v.optional(v.string()),
  currentVersion: v.number(),
  joinedAt: v.number(),
  updatedAt: v.number(),
});
const callResult = v.object({
  callId: v.id("calls"),
  eventId: v.id("missionEvents"),
  operationReceiptId: v.id("operationReceipts"),
  currentVersion: v.number(),
});
const participantResult = v.object({
  callId: v.id("calls"),
  participantId: v.id("callParticipants"),
  eventId: v.id("missionEvents"),
  operationReceiptId: v.id("operationReceipts"),
  currentVersion: v.number(),
  joinedCount: v.number(),
  maxParticipants: v.number(),
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

function normalizedMaxParticipants(value: number | undefined) {
  const maxParticipants = value ?? 50;
  if (!Number.isInteger(maxParticipants) || maxParticipants < 1 || maxParticipants > 50) throw new Error("Invalid Call participant limit");
  return maxParticipants;
}

function normalizedDeadlineAt(value: number | null | undefined) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value <= Date.now()) throw new Error("Invalid Call deadline");
  return value;
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

function requireCallCreate(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  call: Pick<Doc<"calls">, "roomId">,
) {
  requireRole(membership, ["owner", "steward", "builder", "contributor"]);
  if (!canReadCall(membership, call)) throw new Error("Not found");
}

function requireCallAdmin(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  call: Pick<Doc<"calls">, "roomId" | "creatorPrincipalId">,
) {
  if (!canReadCall(membership, call)) throw new Error("Not found");
  if (!["owner", "steward"].includes(membership.role) && membership.principalId !== call.creatorPrincipalId) throw new Error("Not found");
}

function canAdministerCall(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  call: Pick<Doc<"calls">, "roomId" | "creatorPrincipalId">,
) {
  return canReadCall(membership, call) && (
    membership.role === "owner"
    || membership.role === "steward"
    || membership.principalId === call.creatorPrincipalId
  );
}

function requireCallParticipation(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  call: Pick<Doc<"calls">, "roomId">,
) {
  requireRole(membership, ["owner", "steward", "builder", "reviewer", "contributor"]);
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
  call: Pick<Doc<"calls">, "missionId" | "roomId">,
  membership: Pick<Doc<"missionMembers">, "principalId" | "role">,
  type: "call.created" | "call.updated" | "call.transitioned" | "call.participantJoined" | "call.participantWithdrawn" | "call.responseUpdated",
  idempotencyKey: string,
  correlationId: string,
  summary: string,
  beforeVersion: number | undefined,
  afterVersion: number,
) {
  const mission = await ctx.db.get(call.missionId);
  if (!mission) throw new Error("Not found");
  const now = Date.now();
  const eventId = await ctx.db.insert("missionEvents", {
    missionId: mission._id,
    ...(call.roomId === undefined ? {} : { roomId: call.roomId }),
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
    participantId?: Id<"callParticipants">;
    currentVersion: number;
    resultJoinedCount?: number;
    resultMaxParticipants?: number;
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
    participantId: values.participantId,
    eventId: values.eventId,
    resultVersion: values.currentVersion,
    resultJoinedCount: values.resultJoinedCount,
    resultMaxParticipants: values.resultMaxParticipants,
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
        maxParticipants: normalizedMaxParticipants(call.maxParticipants),
        joinedCount: call.joinedCount ?? 0,
        deadlineAt: call.deadlineAt,
        resolutionSummary: call.resolutionSummary,
        resolvedAt: call.resolvedAt,
        canAdminister: canAdministerCall(membership, call),
        status: call.status,
        currentVersion: call.currentVersion,
        createdAt: call.createdAt,
        updatedAt: call.updatedAt,
      }));
  },
});

export const listCallResponseHistory = query({
  args: { callId: v.id("calls"), limit: v.optional(v.number()) },
  returns: v.array(responseHistoryView),
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    if (!canReadCall(membership, call)) throw new Error("Not found");
    const limit = args.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxHistorySize) throw new Error("Invalid Call response history limit");
    const revisions = await ctx.db
      .query("callResponseRevisions")
      .withIndex("by_call", (index) => index.eq("callId", call._id))
      .order("desc")
      .take(limit);
    return await Promise.all(revisions.map(async (revision) => {
      const [principal, revisionMembership] = await Promise.all([
        ctx.db.get(revision.principalId),
        ctx.db
          .query("missionMembers")
          .withIndex("by_mission_and_principal", (index) =>
            index.eq("missionId", call.missionId).eq("principalId", revision.principalId))
          .unique(),
      ]);
      return {
        _id: revision._id,
        callId: revision.callId,
        displayName: principal?.displayName,
        role: revisionMembership?.role,
        isCurrentUser: revision.principalId === membership.principalId,
        revision: revision.revision,
        response: revision.response,
        createdAt: revision.createdAt,
      };
    }));
  },
});

export const listCallParticipants = query({
  args: { callId: v.id("calls") },
  returns: v.array(participantView),
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    if (!canReadCall(membership, call)) throw new Error("Not found");
    const participants = await ctx.db
      .query("callParticipants")
      .withIndex("by_call_and_state", (index) => index.eq("callId", call._id).eq("state", "joined"))
      .take(50);
    return await Promise.all(participants.map(async (participant) => {
      const [principal, participantMembership] = await Promise.all([
        ctx.db.get(participant.principalId),
        ctx.db
          .query("missionMembers")
          .withIndex("by_mission_and_principal", (index) =>
            index.eq("missionId", call.missionId).eq("principalId", participant.principalId))
          .unique(),
      ]);
      return {
        _id: participant._id,
        callId: participant.callId,
        displayName: principal?.displayName,
        role: participantMembership?.role,
        isCurrentUser: participant.principalId === membership.principalId,
        response: participant.response,
        currentVersion: participant.currentVersion,
        joinedAt: participant.joinedAt,
        updatedAt: participant.updatedAt,
      };
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
    maxParticipants: v.optional(v.number()),
    deadlineAt: v.optional(v.union(v.number(), v.null())),
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: callResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireCallCreate(membership, { roomId: args.roomId });
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const title = requiredText(args.title, "Call title", 160);
    const detail = requiredText(args.detail, "Call detail", 2_000);
    const maxParticipants = normalizedMaxParticipants(args.maxParticipants);
    const scope = `mission:${args.missionId}:principal:${membership.principalId}:createCall`;
    const commandFingerprint = JSON.stringify({ command: "createCall", roomId: args.roomId, linkedMoveId: args.linkedMoveId, title, detail, maxParticipants, deadlineAt: args.deadlineAt });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.callId === undefined) throw new Error("Idempotency key reuse with a different command");
      return { callId: prior.callId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion };
    }
    const deadlineAt = normalizedDeadlineAt(args.deadlineAt);
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
      maxParticipants,
      joinedCount: 0,
      deadlineAt,
      status: "open",
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    const event = await recordCallEvent(ctx, { missionId: args.missionId, roomId: args.roomId }, membership, "call.created", idempotencyKey, correlationId, "Call created", undefined, 1);
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
    maxParticipants: v.optional(v.number()),
    deadlineAt: v.optional(v.union(v.number(), v.null())),
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: callResult,
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    requireCallAdmin(membership, call);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const title = requiredText(args.title, "Call title", 160);
    const detail = requiredText(args.detail, "Call detail", 2_000);
    const linkedMoveId = args.linkedMoveId ?? undefined;
    const maxParticipants = normalizedMaxParticipants(args.maxParticipants ?? call.maxParticipants);
    const scope = `call:${call._id}:principal:${membership.principalId}:update`;
    const commandFingerprint = JSON.stringify({ command: "updateCall", expectedVersion: args.expectedVersion, roomId: args.roomId, linkedMoveId: args.linkedMoveId, title, detail, maxParticipants, deadlineAt: args.deadlineAt });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.callId === undefined) throw new Error("Idempotency key reuse with a different command");
      return { callId: prior.callId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion };
    }
    const deadlineAt = args.deadlineAt === undefined ? call.deadlineAt : normalizedDeadlineAt(args.deadlineAt);
    if (call.status === "resolved" || call.status === "cancelled") throw new Error("Terminal Calls cannot be updated");
    await requireWritableMission(ctx, call.missionId);
    if (call.currentVersion !== args.expectedVersion) throw new Error("Call version conflict");
    if (maxParticipants < (call.joinedCount ?? 0)) throw new Error("Call participant limit cannot exclude joined participants");
    if (args.roomId !== call.roomId) {
      const participantHistory = await ctx.db
        .query("callParticipants")
        .withIndex("by_call_and_principal", (index) => index.eq("callId", call._id))
        .take(1);
      if (participantHistory.length > 0) throw new Error("Call room cannot change after participation");
    }
    requireCallAdmin(membership, { roomId: args.roomId, creatorPrincipalId: call.creatorPrincipalId });
    await requireCallRoom(ctx, call.missionId, args.roomId);
    await requireVisibleLinkedMove(ctx, call.missionId, membership, args.roomId, linkedMoveId);
    const nextVersion = call.currentVersion + 1;
    const event = await recordCallEvent(ctx, { ...call, roomId: args.roomId }, membership, "call.updated", idempotencyKey, correlationId, "Call details updated", call.currentVersion, nextVersion);
    await ctx.db.patch(call._id, { roomId: args.roomId, linkedMoveId, title, detail, maxParticipants, deadlineAt, currentVersion: nextVersion, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { callId: call._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

export const transitionCall = mutation({
  args: { callId: v.id("calls"), expectedVersion: v.number(), nextStatus: transitionStatus, resolutionSummary: v.optional(v.union(v.string(), v.null())), idempotencyKey: v.string(), correlationId: v.string() },
  returns: callResult,
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    requireCallAdmin(membership, call);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const scope = `call:${call._id}:principal:${membership.principalId}:transition`;
    const commandFingerprint = JSON.stringify({ command: "transitionCall", expectedVersion: args.expectedVersion, nextStatus: args.nextStatus, resolutionSummary: args.resolutionSummary });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.callId === undefined) throw new Error("Idempotency key reuse with a different command");
      return { callId: prior.callId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion };
    }
    await requireWritableMission(ctx, call.missionId);
    if (call.currentVersion !== args.expectedVersion) throw new Error("Call version conflict");
    if (!isTransitionAllowed(call.status, args.nextStatus)) throw new Error("Invalid Call transition");
    if (args.nextStatus !== "resolved" && args.resolutionSummary !== undefined && args.resolutionSummary !== null) throw new Error("Only resolved Calls may include a resolution summary");
    const resolutionSummary = args.nextStatus === "resolved"
      ? requiredText(args.resolutionSummary ?? "", "Call resolution summary", 2_000)
      : undefined;
    const nextVersion = call.currentVersion + 1;
    const event = await recordCallEvent(ctx, call, membership, "call.transitioned", idempotencyKey, correlationId, `Call transitioned to ${args.nextStatus}`, call.currentVersion, nextVersion);
    await ctx.db.patch(call._id, {
      status: args.nextStatus,
      ...(resolutionSummary === undefined ? {} : { resolutionSummary, resolvedAt: event.now }),
      currentVersion: nextVersion,
      updatedAt: event.now,
    });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { callId: call._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

function participantReceiptScope(callId: Id<"calls">, principalId: Id<"principals">, command: "join" | "withdraw" | "respond") {
  return `call:${callId}:participant:${principalId}:${command}`;
}

function participantResponse(
  call: Doc<"calls">,
  participant: Doc<"callParticipants">,
  eventId: Id<"missionEvents">,
  operationReceiptId: Id<"operationReceipts">,
  replay?: { currentVersion: number; joinedCount?: number; maxParticipants?: number },
) {
  return {
    callId: call._id,
    participantId: participant._id,
    eventId,
    operationReceiptId,
    currentVersion: replay?.currentVersion ?? participant.currentVersion,
    joinedCount: replay?.joinedCount ?? call.joinedCount ?? 0,
    maxParticipants: replay?.maxParticipants ?? normalizedMaxParticipants(call.maxParticipants),
  };
}

export const joinCall = mutation({
  args: { callId: v.id("calls"), idempotencyKey: v.string(), correlationId: v.string() },
  returns: participantResult,
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    requireCallParticipation(membership, call);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const scope = participantReceiptScope(call._id, membership.principalId, "join");
    const commandFingerprint = JSON.stringify({ command: "joinCall" });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.participantId === undefined) throw new Error("Idempotency key reuse with a different command");
      const participant = await ctx.db.get(prior.participantId);
      if (!participant) throw new Error("Not found");
      return participantResponse(call, participant, prior.eventId, prior._id, { currentVersion: prior.resultVersion, joinedCount: prior.resultJoinedCount, maxParticipants: prior.resultMaxParticipants });
    }
    await requireWritableMission(ctx, call.missionId);
    if (call.status !== "open" && call.status !== "accepted") throw new Error("Call is not accepting participants");
    const existing = await ctx.db
      .query("callParticipants")
      .withIndex("by_call_and_principal", (index) => index.eq("callId", call._id).eq("principalId", membership.principalId))
      .unique();
    if (existing?.state === "joined") {
      const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, participantId: existing._id, eventId: existing.joinEventId, currentVersion: existing.currentVersion, resultJoinedCount: call.joinedCount ?? 0, resultMaxParticipants: normalizedMaxParticipants(call.maxParticipants), correlationId, now: Date.now() });
      return participantResponse(call, existing, existing.joinEventId, operationReceiptId);
    }
    const maxParticipants = normalizedMaxParticipants(call.maxParticipants);
    const joinedCount = call.joinedCount ?? 0;
    if (joinedCount >= maxParticipants) throw new Error("Call participant capacity reached");
    const nextCallVersion = call.currentVersion + 1;
    const event = await recordCallEvent(ctx, call, membership, "call.participantJoined", idempotencyKey, correlationId, "Call participant joined", call.currentVersion, nextCallVersion);
    const participantVersion = (existing?.currentVersion ?? 0) + 1;
    const participantId = existing?._id ?? await ctx.db.insert("callParticipants", {
      callId: call._id,
      missionId: call.missionId,
      principalId: membership.principalId,
      state: "joined",
      currentVersion: participantVersion,
      joinedAt: event.now,
      updatedAt: event.now,
      joinEventId: event.eventId,
      schemaVersion: 1,
    });
    if (existing) {
      await ctx.db.patch(existing._id, { state: "joined", response: undefined, currentVersion: participantVersion, joinedAt: event.now, updatedAt: event.now, joinEventId: event.eventId, withdrawEventId: undefined, responseEventId: undefined });
    }
    const nextCall = { ...call, currentVersion: nextCallVersion, joinedCount: joinedCount + 1, updatedAt: event.now };
    await ctx.db.patch(call._id, { currentVersion: nextCallVersion, joinedCount: joinedCount + 1, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, participantId, eventId: event.eventId, currentVersion: participantVersion, resultJoinedCount: joinedCount + 1, resultMaxParticipants: maxParticipants, correlationId, now: event.now });
    const participant = await ctx.db.get(participantId);
    if (!participant) throw new Error("Not found");
    return participantResponse(nextCall, participant, event.eventId, operationReceiptId);
  },
});

export const withdrawCall = mutation({
  args: { callId: v.id("calls"), expectedParticipantVersion: v.number(), idempotencyKey: v.string(), correlationId: v.string() },
  returns: participantResult,
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    requireCallParticipation(membership, call);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const scope = participantReceiptScope(call._id, membership.principalId, "withdraw");
    const commandFingerprint = JSON.stringify({ command: "withdrawCall", expectedParticipantVersion: args.expectedParticipantVersion });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.participantId === undefined) throw new Error("Idempotency key reuse with a different command");
      const participant = await ctx.db.get(prior.participantId);
      if (!participant) throw new Error("Not found");
      return participantResponse(call, participant, prior.eventId, prior._id, { currentVersion: prior.resultVersion, joinedCount: prior.resultJoinedCount, maxParticipants: prior.resultMaxParticipants });
    }
    await requireWritableMission(ctx, call.missionId);
    if (call.status === "resolved" || call.status === "cancelled") throw new Error("Terminal Calls are read-only");
    const participant = await ctx.db
      .query("callParticipants")
      .withIndex("by_call_and_principal", (index) => index.eq("callId", call._id).eq("principalId", membership.principalId))
      .unique();
    if (!participant) throw new Error("Not found");
    if (participant.state === "withdrawn" && participant.withdrawEventId) {
      const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, participantId: participant._id, eventId: participant.withdrawEventId, currentVersion: participant.currentVersion, resultJoinedCount: call.joinedCount ?? 0, resultMaxParticipants: normalizedMaxParticipants(call.maxParticipants), correlationId, now: Date.now() });
      return participantResponse(call, participant, participant.withdrawEventId, operationReceiptId);
    }
    if (participant.currentVersion !== args.expectedParticipantVersion) throw new Error("Call participant version conflict");
    const nextCallVersion = call.currentVersion + 1;
    const event = await recordCallEvent(ctx, call, membership, "call.participantWithdrawn", idempotencyKey, correlationId, "Call participant withdrew", call.currentVersion, nextCallVersion);
    const nextParticipantVersion = participant.currentVersion + 1;
    const nextJoinedCount = Math.max(0, (call.joinedCount ?? 0) - 1);
    const nextCall = { ...call, currentVersion: nextCallVersion, joinedCount: nextJoinedCount, updatedAt: event.now };
    await ctx.db.patch(call._id, { currentVersion: nextCallVersion, joinedCount: nextJoinedCount, updatedAt: event.now });
    await ctx.db.patch(participant._id, { state: "withdrawn", currentVersion: nextParticipantVersion, updatedAt: event.now, withdrawEventId: event.eventId });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, participantId: participant._id, eventId: event.eventId, currentVersion: nextParticipantVersion, resultJoinedCount: nextJoinedCount, resultMaxParticipants: normalizedMaxParticipants(call.maxParticipants), correlationId, now: event.now });
    return participantResponse(nextCall, { ...participant, state: "withdrawn", currentVersion: nextParticipantVersion, updatedAt: event.now, withdrawEventId: event.eventId }, event.eventId, operationReceiptId);
  },
});

export const respondToCall = mutation({
  args: { callId: v.id("calls"), expectedParticipantVersion: v.number(), response: v.string(), idempotencyKey: v.string(), correlationId: v.string() },
  returns: participantResult,
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, call.missionId);
    requireCallParticipation(membership, call);
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const response = requiredText(args.response, "Call response", 2_000);
    const scope = participantReceiptScope(call._id, membership.principalId, "respond");
    const commandFingerprint = JSON.stringify({ command: "respondToCall", expectedParticipantVersion: args.expectedParticipantVersion, response });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint || prior.participantId === undefined) throw new Error("Idempotency key reuse with a different command");
      const participant = await ctx.db.get(prior.participantId);
      if (!participant) throw new Error("Not found");
      return participantResponse(call, participant, prior.eventId, prior._id, { currentVersion: prior.resultVersion, joinedCount: prior.resultJoinedCount, maxParticipants: prior.resultMaxParticipants });
    }
    await requireWritableMission(ctx, call.missionId);
    if (call.status === "resolved" || call.status === "cancelled") throw new Error("Terminal Calls are read-only");
    const participant = await ctx.db
      .query("callParticipants")
      .withIndex("by_call_and_principal", (index) => index.eq("callId", call._id).eq("principalId", membership.principalId))
      .unique();
    if (!participant || participant.state !== "joined") throw new Error("Not found");
    if (participant.currentVersion !== args.expectedParticipantVersion) throw new Error("Call participant version conflict");
    const nextCallVersion = call.currentVersion + 1;
    const event = await recordCallEvent(ctx, call, membership, "call.responseUpdated", idempotencyKey, correlationId, "Call response updated", call.currentVersion, nextCallVersion);
    const nextParticipantVersion = participant.currentVersion + 1;
    const latestResponseRevision = await ctx.db
      .query("callResponseRevisions")
      .withIndex("by_participant", (index) => index.eq("participantId", participant._id))
      .order("desc")
      .first();
    const nextResponseRevision = (latestResponseRevision?.revision ?? 0) + 1;
    const nextCall = { ...call, currentVersion: nextCallVersion, updatedAt: event.now };
    await ctx.db.patch(call._id, { currentVersion: nextCallVersion, updatedAt: event.now });
    await ctx.db.patch(participant._id, { response, currentVersion: nextParticipantVersion, updatedAt: event.now, responseEventId: event.eventId });
    await ctx.db.insert("callResponseRevisions", {
      callId: call._id,
      missionId: call.missionId,
      participantId: participant._id,
      principalId: membership.principalId,
      revision: nextResponseRevision,
      response,
      eventId: event.eventId,
      createdAt: event.now,
      schemaVersion: 1,
    });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: call.missionId, callId: call._id, participantId: participant._id, eventId: event.eventId, currentVersion: nextParticipantVersion, resultJoinedCount: call.joinedCount ?? 0, resultMaxParticipants: normalizedMaxParticipants(call.maxParticipants), correlationId, now: event.now });
    return participantResponse(nextCall, { ...participant, response, currentVersion: nextParticipantVersion, updatedAt: event.now, responseEventId: event.eventId }, event.eventId, operationReceiptId);
  },
});
