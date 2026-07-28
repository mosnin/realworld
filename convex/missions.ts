import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireActiveMembership, requireAuthenticatedTokenIdentifier, requireExistingHumanPrincipal, requireRole } from "./lib/auth";

const receiptRetentionMs = 30 * 24 * 60 * 60 * 1000;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const missionLifecycle = v.union(v.literal("active"), v.literal("archived"), v.literal("pendingDeletion"), v.literal("deletedTombstone"));

const missionResult = v.object({
  missionId: v.id("missions"),
  eventId: v.id("missionEvents"),
  operationReceiptId: v.id("operationReceipts"),
  currentVersion: v.number(),
});

function requireNonBlank(value: string, field: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new Error(`Invalid ${field}`);
  }
  return trimmed;
}

function requireSlug(value: string) {
  if (value.length < 3 || value.length > 80 || !slugPattern.test(value)) {
    throw new Error("Invalid slug");
  }
  return value;
}

function fingerprintCreateMission(args: {
  slug: string;
  title: string;
  summary: string;
}): string {
  return JSON.stringify({ command: "createPrivateMission", ...args });
}

function fingerprintArchiveMission(args: { missionId: Id<"missions">; expectedVersion: number }): string {
  return JSON.stringify({ command: "archivePrivateMission", ...args });
}

export const createPrivateMission = mutation({
  args: {
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: missionResult,
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireAuthenticatedTokenIdentifier(ctx);
    const slug = requireSlug(args.slug);
    const title = requireNonBlank(args.title, "title", 160);
    const summary = requireNonBlank(args.summary, "summary", 1_000);
    const idempotencyKey = requireNonBlank(args.idempotencyKey, "idempotency key", 200);
    const correlationId = requireNonBlank(args.correlationId, "correlation id", 200);
    const commandFingerprint = fingerprintCreateMission({ slug, title, summary });
    const idempotencyScope = `principal:${tokenIdentifier}:createMission`;

    const existingReceipt = await ctx.db
      .query("operationReceipts")
      .withIndex("by_scope_and_idempotency_key", (query) =>
        query.eq("scope", idempotencyScope).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existingReceipt !== null) {
      if (existingReceipt.commandFingerprint !== commandFingerprint) {
        throw new Error("Idempotency key reuse with a different command");
      }
      return {
        missionId: existingReceipt.missionId,
        eventId: existingReceipt.eventId,
        operationReceiptId: existingReceipt._id,
        currentVersion: existingReceipt.resultVersion,
      };
    }

    const existingMission = await ctx.db
      .query("missions")
      .withIndex("by_slug", (query) => query.eq("slug", slug))
      .unique();
    if (existingMission !== null) {
      throw new Error("Mission could not be created with that slug");
    }

    const existingPrincipal = await ctx.db
      .query("principals")
      .withIndex("by_token_identifier", (query) => query.eq("tokenIdentifier", tokenIdentifier))
      .unique();
    const now = Date.now();
    const principalId =
      existingPrincipal === null
        ? await ctx.db.insert("principals", {
            type: "human",
            state: "active",
            tokenIdentifier,
            createdAt: now,
            updatedAt: now,
            schemaVersion: 1,
          })
        : existingPrincipal._id;

    if (existingPrincipal !== null && (existingPrincipal.type !== "human" || existingPrincipal.state !== "active")) {
      throw new Error("Unauthorized");
    }

    const missionId = await ctx.db.insert("missions", {
      ownerPrincipalId: principalId,
      slug,
      title,
      summary,
      visibility: "private",
      lifecycle: "active",
      currentVersion: 1,
      eventSequence: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    await ctx.db.insert("missionMembers", {
      missionId,
      principalId,
      role: "owner",
      state: "active",
      scope: ["mission:*"],
      grantVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    const eventId = await ctx.db.insert("missionEvents", {
      missionId,
      missionSequence: 1,
      type: "mission.created",
      aggregateType: "mission",
      aggregateId: missionId,
      actorPrincipalId: principalId,
      effectiveRole: "owner",
      correlationId,
      idempotencyKey,
      publicSummary: "Mission created",
      afterVersion: 1,
      createdAt: now,
      schemaVersion: 1,
    });
    const operationReceiptId = await ctx.db.insert("operationReceipts", {
      scope: idempotencyScope,
      idempotencyKey,
      commandFingerprint,
      state: "complete",
      missionId,
      eventId,
      resultVersion: 1,
      correlationId,
      createdAt: now,
      expiresAt: now + receiptRetentionMs,
      schemaVersion: 1,
    });

    return { missionId, eventId, operationReceiptId, currentVersion: 1 };
  },
});

export const getPrivateMissionBySlug = query({
  args: { slug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("missions"),
      slug: v.string(),
      title: v.string(),
      summary: v.string(),
      lifecycle: v.union(v.literal("active"), v.literal("archived"), v.literal("pendingDeletion"), v.literal("deletedTombstone")),
      currentVersion: v.number(),
      updatedAt: v.number(),
      role: v.union(
        v.literal("owner"),
        v.literal("steward"),
        v.literal("builder"),
        v.literal("reviewer"),
        v.literal("contributor"),
        v.literal("observer"),
        v.literal("agent"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await requireExistingHumanPrincipal(ctx);
    const mission = await ctx.db
      .query("missions")
      .withIndex("by_slug", (query) => query.eq("slug", args.slug))
      .unique();
    if (mission === null || mission.visibility !== "private") {
      return null;
    }
    const membership = await ctx.db
      .query("missionMembers")
      .withIndex("by_mission_and_principal", (query) =>
        query.eq("missionId", mission._id).eq("principalId", principal._id),
      )
      .unique();
    if (membership === null || membership.state !== "active") {
      return null;
    }
    return {
      _id: mission._id,
      slug: mission.slug,
      title: mission.title,
      summary: mission.summary,
      lifecycle: mission.lifecycle,
      currentVersion: mission.currentVersion,
      updatedAt: mission.updatedAt,
      role: membership.role,
    };
  },
});

export const listMyMissions = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("missions"), title: v.string(), slug: v.string(), summary: v.string(), templateKey: v.optional(v.string()), role: v.string(), lifecycle: missionLifecycle, currentVersion: v.number() })),
  handler: async (ctx) => {
    const tokenIdentifier = await requireAuthenticatedTokenIdentifier(ctx);
    const principal = await ctx.db
      .query("principals")
      .withIndex("by_token_identifier", (query) => query.eq("tokenIdentifier", tokenIdentifier))
      .unique();
    if (principal === null) return [];
    if (principal.type !== "human" || principal.state !== "active") throw new Error("Unauthorized");
    const memberships = await ctx.db.query("missionMembers").withIndex("by_principal_and_state", q => q.eq("principalId", principal._id).eq("state", "active")).take(100);
    const values = await Promise.all(memberships.map(async membership => { const mission = await ctx.db.get(membership.missionId); if (mission === null || (mission.lifecycle !== "active" && membership.role !== "owner")) return null; return { _id: mission._id, title: mission.title, slug: mission.slug, summary: mission.summary, templateKey: mission.templateKey, role: membership.role, lifecycle: mission.lifecycle, currentVersion: mission.currentVersion }; }));
    return values.filter((value): value is NonNullable<typeof value> => value !== null);
  },
});

export const editPrivateMission = mutation({
  args: { missionId: v.id("missions"), title: v.string(), summary: v.string(), expectedVersion: v.number(), idempotencyKey: v.string(), correlationId: v.string() },
  returns: missionResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId); requireRole(membership, ["owner"]);
    const title = requireNonBlank(args.title, "title", 160); const summary = requireNonBlank(args.summary, "summary", 1_000);
    const scope = `mission:${args.missionId}:edit`; const commandFingerprint = JSON.stringify({ command: "editPrivateMission", title, summary, expectedVersion: args.expectedVersion });
    const prior = await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", scope).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (prior) { if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command"); return { missionId: prior.missionId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion }; }
    const mission = await ctx.db.get(args.missionId); if (!mission || mission.visibility !== "private" || mission.lifecycle !== "active") throw new Error("Not found"); if (mission.currentVersion !== args.expectedVersion) throw new Error("Mission version conflict");
    const now = Date.now(); const nextVersion = mission.currentVersion + 1; const sequence = mission.eventSequence + 1; await ctx.db.patch(mission._id, { title, summary, currentVersion: nextVersion, eventSequence: sequence, updatedAt: now });
    const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, missionSequence: sequence, type: "mission.updated", aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: membership.principalId, effectiveRole: membership.role, correlationId: args.correlationId, idempotencyKey: args.idempotencyKey, publicSummary: "Mission details updated", beforeVersion: mission.currentVersion, afterVersion: nextVersion, createdAt: now, schemaVersion: 1 });
    const operationReceiptId = await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint, state: "complete", missionId: mission._id, eventId, resultVersion: nextVersion, correlationId: args.correlationId, createdAt: now, expiresAt: now + receiptRetentionMs, schemaVersion: 1 }); return { missionId: mission._id, eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

export const restorePrivateMission = mutation({
  args: { missionId: v.id("missions"), expectedVersion: v.number(), idempotencyKey: v.string(), correlationId: v.string() },
  returns: missionResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId); requireRole(membership, ["owner"]);
    const scope = `mission:${args.missionId}:restore`; const commandFingerprint = JSON.stringify({ command: "restorePrivateMission", expectedVersion: args.expectedVersion }); const prior = await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", scope).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (prior) { if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command"); return { missionId: prior.missionId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion }; }
    const mission = await ctx.db.get(args.missionId); if (!mission || mission.visibility !== "private" || mission.lifecycle !== "archived") throw new Error("Not found"); if (mission.currentVersion !== args.expectedVersion) throw new Error("Mission version conflict");
    const now = Date.now(); const nextVersion = mission.currentVersion + 1; const sequence = mission.eventSequence + 1; await ctx.db.patch(mission._id, { lifecycle: "active", currentVersion: nextVersion, eventSequence: sequence, updatedAt: now });
    const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, missionSequence: sequence, type: "mission.restored", aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: membership.principalId, effectiveRole: membership.role, correlationId: args.correlationId, idempotencyKey: args.idempotencyKey, publicSummary: "Mission restored", beforeVersion: mission.currentVersion, afterVersion: nextVersion, createdAt: now, schemaVersion: 1 });
    const operationReceiptId = await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint, state: "complete", missionId: mission._id, eventId, resultVersion: nextVersion, correlationId: args.correlationId, createdAt: now, expiresAt: now + receiptRetentionMs, schemaVersion: 1 }); return { missionId: mission._id, eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

export const archivePrivateMission = mutation({
  args: {
    missionId: v.id("missions"),
    expectedVersion: v.number(),
    idempotencyKey: v.string(),
    correlationId: v.string(),
  },
  returns: missionResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireRole(membership, ["owner"]);
    const idempotencyKey = requireNonBlank(args.idempotencyKey, "idempotency key", 200);
    const correlationId = requireNonBlank(args.correlationId, "correlation id", 200);
    const commandFingerprint = fingerprintArchiveMission({
      missionId: args.missionId,
      expectedVersion: args.expectedVersion,
    });
    const idempotencyScope = `mission:${args.missionId}:archive`;
    const existingReceipt = await ctx.db
      .query("operationReceipts")
      .withIndex("by_scope_and_idempotency_key", (query) =>
        query.eq("scope", idempotencyScope).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existingReceipt !== null) {
      if (existingReceipt.commandFingerprint !== commandFingerprint) {
        throw new Error("Idempotency key reuse with a different command");
      }
      return {
        missionId: existingReceipt.missionId,
        eventId: existingReceipt.eventId,
        operationReceiptId: existingReceipt._id,
        currentVersion: existingReceipt.resultVersion,
      };
    }

    const mission = await ctx.db.get(args.missionId);
    if (mission === null || mission.visibility !== "private") {
      throw new Error("Not found");
    }
    if (mission.currentVersion !== args.expectedVersion) {
      throw new Error("Mission version conflict");
    }
    if (mission.lifecycle !== "active") {
      throw new Error("Mission cannot be archived from its current lifecycle state");
    }

    const now = Date.now();
    const nextVersion = mission.currentVersion + 1;
    const nextSequence = mission.eventSequence + 1;
    await ctx.db.patch(args.missionId, {
      lifecycle: "archived",
      currentVersion: nextVersion,
      eventSequence: nextSequence,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("missionEvents", {
      missionId: mission._id,
      missionSequence: nextSequence,
      type: "mission.archived",
      aggregateType: "mission",
      aggregateId: mission._id,
      actorPrincipalId: membership.principalId,
      effectiveRole: membership.role,
      correlationId,
      idempotencyKey,
      publicSummary: "Mission archived",
      beforeVersion: mission.currentVersion,
      afterVersion: nextVersion,
      createdAt: now,
      schemaVersion: 1,
    });
    const operationReceiptId = await ctx.db.insert("operationReceipts", {
      scope: idempotencyScope,
      idempotencyKey,
      commandFingerprint,
      state: "complete",
      missionId: mission._id,
      eventId,
      resultVersion: nextVersion,
      correlationId,
      createdAt: now,
      expiresAt: now + receiptRetentionMs,
      schemaVersion: 1,
    });
    return {
      missionId: mission._id,
      eventId,
      operationReceiptId,
      currentVersion: nextVersion,
    };
  },
});
