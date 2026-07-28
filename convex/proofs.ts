import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireActiveMembership, requireRole, requireWritableMission } from "./lib/auth";

const proofStatus = v.union(v.literal("submitted"), v.literal("verified"), v.literal("rejected"));
const receiptMs = 30 * 86400000;
const defaultListLimit = 25;
const maxListLimit = 100;

const proofView = v.object({
  _id: v.id("proofs"),
  missionId: v.id("missions"),
  roomId: v.id("rooms"),
  linkedMoveId: v.optional(v.id("moves")),
  submitterDisplayName: v.optional(v.string()),
  verifierDisplayName: v.optional(v.string()),
  verifiedAt: v.optional(v.number()),
  title: v.string(),
  claim: v.string(),
  evidenceNote: v.string(),
  status: proofStatus,
  currentVersion: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  canEdit: v.boolean(),
  canReview: v.boolean(),
  canResubmit: v.boolean(),
});

const proofResult = v.object({
  proofId: v.id("proofs"),
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

function canReadProof(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  proof: Pick<Doc<"proofs">, "roomId">,
) {
  return membership.scope.includes("mission:*") || membership.scope.includes(`room:${proof.roomId}`);
}

function requireProofRead(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  proof: Pick<Doc<"proofs">, "roomId">,
) {
  requireRole(membership, ["owner", "steward", "builder", "reviewer", "contributor"]);
  if (!canReadProof(membership, proof)) throw new Error("Not found");
}

function requireProofCreate(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  proof: Pick<Doc<"proofs">, "roomId">,
) {
  requireRole(membership, ["owner", "steward", "builder", "contributor"]);
  if (!canReadProof(membership, proof)) throw new Error("Not found");
}

function hasProofEditAuthority(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  proof: Pick<Doc<"proofs">, "roomId" | "submitterPrincipalId">,
) {
  return canReadProof(membership, proof)
    && (["owner", "steward"].includes(membership.role) || membership.principalId === proof.submitterPrincipalId);
}

function hasProofReviewAuthority(
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  proof: Pick<Doc<"proofs">, "roomId">,
) {
  return canReadProof(membership, proof)
    && ["owner", "steward", "reviewer"].includes(membership.role);
}

async function operationReceipt(ctx: MutationCtx, scope: string, idempotencyKey: string) {
  return await ctx.db
    .query("operationReceipts")
    .withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", scope).eq("idempotencyKey", idempotencyKey))
    .unique();
}

async function requireProofRoom(ctx: MutationCtx, missionId: Id<"missions">, roomId: Id<"rooms">) {
  const room = await ctx.db.get(roomId);
  if (!room || room.missionId !== missionId || room.state !== "active") throw new Error("Invalid Proof room");
}

async function requireLinkedMove(ctx: MutationCtx, missionId: Id<"missions">, roomId: Id<"rooms">, linkedMoveId: Id<"moves"> | undefined) {
  if (linkedMoveId === undefined) return;
  const move = await ctx.db.get(linkedMoveId);
  if (!move || move.missionId !== missionId || move.roomId !== roomId) throw new Error("Not found");
}

async function recordProofEvent(
  ctx: MutationCtx,
  proof: Pick<Doc<"proofs">, "missionId">,
  membership: Pick<Doc<"missionMembers">, "principalId" | "role">,
  type: "proof.submitted" | "proof.updated" | "proof.verified" | "proof.rejected" | "proof.resubmitted",
  idempotencyKey: string,
  correlationId: string,
  summary: string,
  beforeVersion: number | undefined,
  afterVersion: number,
) {
  const mission = await ctx.db.get(proof.missionId);
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
    proofId: Id<"proofs">;
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
    proofId: values.proofId,
    eventId: values.eventId,
    resultVersion: values.currentVersion,
    correlationId: values.correlationId,
    createdAt: values.now,
    expiresAt: values.now + receiptMs,
    schemaVersion: 1,
  });
}

function replayReceipt(receipt: Doc<"operationReceipts">) {
  if (receipt.proofId === undefined) throw new Error("Idempotency key reuse with a different command");
  return { proofId: receipt.proofId, eventId: receipt.eventId, operationReceiptId: receipt._id, currentVersion: receipt.resultVersion };
}

async function proofProjection(
  ctx: Pick<QueryCtx, "db">,
  membership: Awaited<ReturnType<typeof requireActiveMembership>>,
  proof: Doc<"proofs">,
) {
  const [submitter, verifier] = await Promise.all([
    ctx.db.get(proof.submitterPrincipalId),
    proof.verifierPrincipalId === undefined ? undefined : ctx.db.get(proof.verifierPrincipalId),
  ]);
  return {
    _id: proof._id,
    missionId: proof.missionId,
    roomId: proof.roomId,
    linkedMoveId: proof.linkedMoveId,
    ...(submitter?.displayName === undefined ? {} : { submitterDisplayName: submitter.displayName }),
    ...(verifier?.displayName === undefined ? {} : { verifierDisplayName: verifier.displayName }),
    ...(proof.verifiedAt === undefined ? {} : { verifiedAt: proof.verifiedAt }),
    title: proof.title,
    claim: proof.claim,
    evidenceNote: proof.evidenceNote,
    status: proof.status,
    currentVersion: proof.currentVersion,
    createdAt: proof.createdAt,
    updatedAt: proof.updatedAt,
    canEdit: proof.status !== "verified" && hasProofEditAuthority(membership, proof),
    canReview: proof.status === "submitted" && hasProofReviewAuthority(membership, proof),
    canResubmit: proof.status === "rejected" && hasProofEditAuthority(membership, proof),
  };
}

export const listMissionProofs = query({
  args: { missionId: v.id("missions"), limit: v.optional(v.number()) },
  returns: v.array(proofView),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireRole(membership, ["owner", "steward", "builder", "reviewer", "contributor"]);
    const limit = args.limit ?? defaultListLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxListLimit) throw new Error("Invalid Proof list limit");
    const candidates = await ctx.db
      .query("proofs")
      .withIndex("by_mission_and_status", (index) => index.eq("missionId", args.missionId))
      .order("desc")
      .take(maxListLimit);
    const visible = candidates.filter((proof) => canReadProof(membership, proof)).slice(0, limit);
    return await Promise.all(visible.map((proof) => proofProjection(ctx, membership, proof)));
  },
});

export const listRoomProofs = query({
  args: { roomId: v.id("rooms"), status: v.optional(proofStatus), limit: v.optional(v.number()) },
  returns: v.array(proofView),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, room.missionId);
    requireProofRead(membership, { roomId: room._id });
    const limit = args.limit ?? defaultListLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxListLimit) throw new Error("Invalid Proof list limit");
    const proofs = args.status === undefined
      ? await ctx.db.query("proofs").withIndex("by_room_and_status", (index) => index.eq("roomId", room._id)).order("desc").take(limit)
      : await ctx.db.query("proofs").withIndex("by_room_and_status", (index) => index.eq("roomId", room._id).eq("status", args.status!)).order("desc").take(limit);
    return await Promise.all(proofs.map((proof) => proofProjection(ctx, membership, proof)));
  },
});

export const createProof = mutation({
  args: {
    missionId: v.id("missions"),
    roomId: v.id("rooms"),
    linkedMoveId: v.optional(v.id("moves")),
    title: v.string(),
    claim: v.string(),
    evidenceNote: v.string(),
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: proofResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireProofCreate(membership, { roomId: args.roomId });
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const title = requiredText(args.title, "Proof title", 160);
    const claim = requiredText(args.claim, "Proof claim", 2_000);
    const evidenceNote = requiredText(args.evidenceNote, "Proof evidence note", 4_000);
    const scope = `mission:${args.missionId}:principal:${membership.principalId}:createProof`;
    const commandFingerprint = JSON.stringify({ command: "createProof", roomId: args.roomId, linkedMoveId: args.linkedMoveId, title, claim, evidenceNote });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command");
      return replayReceipt(prior);
    }
    await requireWritableMission(ctx, args.missionId);
    await requireProofRoom(ctx, args.missionId, args.roomId);
    await requireLinkedMove(ctx, args.missionId, args.roomId, args.linkedMoveId);
    const now = Date.now();
    const proofId = await ctx.db.insert("proofs", {
      missionId: args.missionId,
      roomId: args.roomId,
      linkedMoveId: args.linkedMoveId,
      submitterPrincipalId: membership.principalId,
      title,
      claim,
      evidenceNote,
      status: "submitted",
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    const event = await recordProofEvent(ctx, { missionId: args.missionId }, membership, "proof.submitted", idempotencyKey, correlationId, "Proof submitted", undefined, 1);
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: args.missionId, proofId, eventId: event.eventId, currentVersion: 1, correlationId, now: event.now });
    return { proofId, eventId: event.eventId, operationReceiptId, currentVersion: 1 };
  },
});

export const updateProof = mutation({
  args: {
    proofId: v.id("proofs"),
    expectedVersion: v.number(),
    roomId: v.id("rooms"),
    linkedMoveId: v.union(v.id("moves"), v.null()),
    title: v.string(),
    claim: v.string(),
    evidenceNote: v.string(),
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: proofResult,
  handler: async (ctx, args) => {
    const proof = await ctx.db.get(args.proofId);
    if (!proof) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, proof.missionId);
    requireProofRead(membership, proof);
    if (!hasProofEditAuthority(membership, proof)) throw new Error("Not found");
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const title = requiredText(args.title, "Proof title", 160);
    const claim = requiredText(args.claim, "Proof claim", 2_000);
    const evidenceNote = requiredText(args.evidenceNote, "Proof evidence note", 4_000);
    const linkedMoveId = args.linkedMoveId ?? undefined;
    const scope = `proof:${proof._id}:principal:${membership.principalId}:update`;
    const commandFingerprint = JSON.stringify({ command: "updateProof", expectedVersion: args.expectedVersion, roomId: args.roomId, linkedMoveId: args.linkedMoveId, title, claim, evidenceNote });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command");
      return replayReceipt(prior);
    }
    if (proof.status === "verified") throw new Error("Verified Proofs cannot be updated");
    await requireWritableMission(ctx, proof.missionId);
    if (proof.currentVersion !== args.expectedVersion) throw new Error("Proof version conflict");
    if (!canReadProof(membership, { roomId: args.roomId })) throw new Error("Not found");
    await requireProofRoom(ctx, proof.missionId, args.roomId);
    await requireLinkedMove(ctx, proof.missionId, args.roomId, linkedMoveId);
    const nextVersion = proof.currentVersion + 1;
    const event = await recordProofEvent(ctx, proof, membership, "proof.updated", idempotencyKey, correlationId, "Proof details updated", proof.currentVersion, nextVersion);
    await ctx.db.patch(proof._id, { roomId: args.roomId, linkedMoveId, title, claim, evidenceNote, currentVersion: nextVersion, updatedAt: event.now });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: proof.missionId, proofId: proof._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { proofId: proof._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

export const transitionProof = mutation({
  args: { proofId: v.id("proofs"), expectedVersion: v.number(), nextStatus: proofStatus, idempotencyKey: v.string(), correlationId: v.string() },
  returns: proofResult,
  handler: async (ctx, args) => {
    const proof = await ctx.db.get(args.proofId);
    if (!proof) throw new Error("Not found");
    const membership = await requireActiveMembership(ctx, proof.missionId);
    const isResubmission = args.nextStatus === "submitted";
    requireProofRead(membership, proof);
    if (isResubmission ? !hasProofEditAuthority(membership, proof) : !hasProofReviewAuthority(membership, proof)) throw new Error("Not found");
    const { idempotencyKey, correlationId } = commandIds(args.idempotencyKey, args.correlationId);
    const scope = `proof:${proof._id}:principal:${membership.principalId}:transition`;
    const commandFingerprint = JSON.stringify({ command: "transitionProof", expectedVersion: args.expectedVersion, nextStatus: args.nextStatus });
    const prior = await operationReceipt(ctx, scope, idempotencyKey);
    if (prior) {
      if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command");
      return replayReceipt(prior);
    }
    await requireWritableMission(ctx, proof.missionId);
    if (proof.currentVersion !== args.expectedVersion) throw new Error("Proof version conflict");
    const isAllowed = (proof.status === "submitted" && (args.nextStatus === "verified" || args.nextStatus === "rejected"))
      || (proof.status === "rejected" && args.nextStatus === "submitted");
    if (!isAllowed) throw new Error("Invalid Proof transition");
    const nextVersion = proof.currentVersion + 1;
    const eventType = args.nextStatus === "verified" ? "proof.verified" : args.nextStatus === "rejected" ? "proof.rejected" : "proof.resubmitted";
    const event = await recordProofEvent(ctx, proof, membership, eventType, idempotencyKey, correlationId, `Proof ${args.nextStatus}`, proof.currentVersion, nextVersion);
    await ctx.db.patch(proof._id, {
      status: args.nextStatus,
      ...(args.nextStatus === "verified"
        ? { verifierPrincipalId: membership.principalId, verifiedAt: event.now }
        : { verifierPrincipalId: undefined, verifiedAt: undefined }),
      currentVersion: nextVersion,
      updatedAt: event.now,
    });
    const operationReceiptId = await saveReceipt(ctx, { scope, idempotencyKey, commandFingerprint, missionId: proof.missionId, proofId: proof._id, eventId: event.eventId, currentVersion: nextVersion, correlationId, now: event.now });
    return { proofId: proof._id, eventId: event.eventId, operationReceiptId, currentVersion: nextVersion };
  },
});
