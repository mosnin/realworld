import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { isActiveMembership, requireActiveMembership, requireAuthenticatedTokenIdentifier, requireExistingHumanPrincipal, requireRole } from "./lib/auth";
import { humanAttributionAtAction } from "./lib/human-attribution";

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
    const actorAttributionAtAction = await humanAttributionAtAction(ctx, principalId);
    const eventId = await ctx.db.insert("missionEvents", {
      missionId,
      type: "mission.created",
      aggregateType: "mission",
      aggregateId: missionId,
      actorPrincipalId: principalId,
      ...(actorAttributionAtAction ?? {}),
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
      constitution: v.optional(v.string()),
      desiredOutcomes: v.optional(v.array(v.string())),
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
    if (membership === null || !isActiveMembership(membership)) {
      return null;
    }
    return {
      _id: mission._id,
      slug: mission.slug,
      title: mission.title,
      summary: mission.summary,
      constitution: mission.constitution,
      desiredOutcomes: mission.desiredOutcomes,
      lifecycle: mission.lifecycle,
      currentVersion: mission.currentVersion,
      updatedAt: mission.updatedAt,
      role: membership.role,
    };
  },
});

export const listMyMissions = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("missions"), title: v.string(), slug: v.string(), summary: v.string(), constitution: v.optional(v.string()), desiredOutcomes: v.optional(v.array(v.string())), templateKey: v.optional(v.string()), role: v.string(), grantVersion: v.number(), lifecycle: missionLifecycle, currentVersion: v.number() })),
  handler: async (ctx) => {
    const tokenIdentifier = await requireAuthenticatedTokenIdentifier(ctx);
    const principal = await ctx.db
      .query("principals")
      .withIndex("by_token_identifier", (query) => query.eq("tokenIdentifier", tokenIdentifier))
      .unique();
    if (principal === null) return [];
    if (principal.type !== "human" || principal.state !== "active") throw new Error("Unauthorized");
    const memberships = await ctx.db.query("missionMembers").withIndex("by_principal_and_state", q => q.eq("principalId", principal._id).eq("state", "active")).take(100);
    const values = await Promise.all(memberships.filter((membership) => isActiveMembership(membership)).map(async membership => { const mission = await ctx.db.get(membership.missionId); if (mission === null) return null; return { _id: mission._id, title: mission.title, slug: mission.slug, summary: mission.summary, constitution: mission.constitution, desiredOutcomes: mission.desiredOutcomes, templateKey: mission.templateKey, role: membership.role, grantVersion: membership.grantVersion, lifecycle: mission.lifecycle, currentVersion: mission.currentVersion }; }));
    return values.filter((value): value is NonNullable<typeof value> => value !== null);
  },
});

/**
 * An authoritative, deliberately narrow precondition for a future ephemeral
 * room session. It proves the current human grant, active Mission, and active
 * accessible room at one durable Convex read boundary; it creates no token or
 * transport capability.
 */
export const getRealtimeRoomReadiness = query({
  args: { missionId: v.id("missions"), roomId: v.id("rooms") },
  returns: v.union(
    v.null(),
    v.object({
      missionId: v.id("missions"),
      roomId: v.id("rooms"),
      grantVersion: v.number(),
      missionLifecycle: v.literal("active"),
      roomState: v.literal("active"),
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await requireExistingHumanPrincipal(ctx);
    const [mission, room, membership] = await Promise.all([
      ctx.db.get(args.missionId),
      ctx.db.get(args.roomId),
      ctx.db.query("missionMembers")
        .withIndex("by_mission_and_principal", (index) => index.eq("missionId", args.missionId).eq("principalId", principal._id))
        .unique(),
    ]);
    if (mission === null || mission.visibility !== "private" || mission.lifecycle !== "active") return null;
    if (room === null || room.missionId !== mission._id || room.state !== "active") return null;
    if (membership === null || membership.role === "agent" || !isActiveMembership(membership)) return null;
    if (!membership.scope.includes("mission:*") && !membership.scope.includes(`room:${room._id}`)) return null;
    return {
      missionId: mission._id,
      roomId: room._id,
      grantVersion: membership.grantVersion,
      missionLifecycle: "active" as const,
      roomState: "active" as const,
    };
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
    const now = Date.now(); const nextVersion = mission.currentVersion + 1; await ctx.db.patch(mission._id, { title, summary, currentVersion: nextVersion, updatedAt: now });
    const actorAttributionAtAction = await humanAttributionAtAction(ctx, membership.principalId);
    const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, type: "mission.updated", aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: membership.principalId, ...(actorAttributionAtAction ?? {}), effectiveRole: membership.role, correlationId: args.correlationId, idempotencyKey: args.idempotencyKey, publicSummary: "Mission details updated", beforeVersion: mission.currentVersion, afterVersion: nextVersion, createdAt: now, schemaVersion: 1 });
    const operationReceiptId = await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint, state: "complete", missionId: mission._id, eventId, resultVersion: nextVersion, correlationId: args.correlationId, createdAt: now, expiresAt: now + receiptRetentionMs, schemaVersion: 1 }); return { missionId: mission._id, eventId, operationReceiptId, currentVersion: nextVersion };
  },
});

export const updateConstitution = mutation({
  args: { missionId: v.id("missions"), constitution: v.string(), desiredOutcomes: v.array(v.string()), expectedVersion: v.number(), idempotencyKey: v.string(), correlationId: v.string() },
  returns: missionResult,
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId); requireRole(membership, ["owner"]);
    const constitution = requireNonBlank(args.constitution, "constitution", 10_000);
    if (args.desiredOutcomes.length < 1 || args.desiredOutcomes.length > 20) throw new Error("Invalid desired outcomes");
    const desiredOutcomes = args.desiredOutcomes.map((outcome) => requireNonBlank(outcome, "desired outcome", 280));
    if (new Set(desiredOutcomes.map((outcome) => outcome.toLowerCase())).size !== desiredOutcomes.length) throw new Error("Duplicate desired outcome");
    const idempotencyKey = requireNonBlank(args.idempotencyKey, "idempotency key", 200);
    const correlationId = requireNonBlank(args.correlationId, "correlation id", 200);
    const scope = `mission:${args.missionId}:constitution`; const commandFingerprint = JSON.stringify({ command: "updateConstitution", constitution, desiredOutcomes, expectedVersion: args.expectedVersion }); const prior = await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", scope).eq("idempotencyKey", idempotencyKey)).unique();
    if (prior) { if (prior.commandFingerprint !== commandFingerprint) throw new Error("Idempotency key reuse with a different command"); return { missionId: prior.missionId, eventId: prior.eventId, operationReceiptId: prior._id, currentVersion: prior.resultVersion }; }
    const mission = await ctx.db.get(args.missionId); if (!mission || mission.lifecycle !== "active" || mission.visibility !== "private") throw new Error("Mission is not active"); if (mission.currentVersion !== args.expectedVersion) throw new Error("Mission version conflict");
    const now = Date.now(); const currentVersion = mission.currentVersion + 1; await ctx.db.patch(mission._id, { constitution, desiredOutcomes, currentVersion, updatedAt: now });
    const actorAttributionAtAction = await humanAttributionAtAction(ctx, membership.principalId);
    const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, type: "mission.constitutionUpdated", aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: membership.principalId, ...(actorAttributionAtAction ?? {}), effectiveRole: membership.role, correlationId, idempotencyKey, publicSummary: "Mission Constitution updated", beforeVersion: mission.currentVersion, afterVersion: currentVersion, createdAt: now, schemaVersion: 1 });
    const operationReceiptId = await ctx.db.insert("operationReceipts", { scope, idempotencyKey, commandFingerprint, state: "complete", missionId: mission._id, eventId, resultVersion: currentVersion, correlationId, createdAt: now, expiresAt: now + receiptRetentionMs, schemaVersion: 1 }); return { missionId: mission._id, eventId, operationReceiptId, currentVersion };
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
    const now = Date.now(); const nextVersion = mission.currentVersion + 1; await ctx.db.patch(mission._id, { lifecycle: "active", currentVersion: nextVersion, updatedAt: now });
    const actorAttributionAtAction = await humanAttributionAtAction(ctx, membership.principalId);
    const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, type: "mission.restored", aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: membership.principalId, ...(actorAttributionAtAction ?? {}), effectiveRole: membership.role, correlationId: args.correlationId, idempotencyKey: args.idempotencyKey, publicSummary: "Mission restored", beforeVersion: mission.currentVersion, afterVersion: nextVersion, createdAt: now, schemaVersion: 1 });
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
    await ctx.db.patch(args.missionId, {
      lifecycle: "archived",
      currentVersion: nextVersion,
      updatedAt: now,
    });
    const actorAttributionAtAction = await humanAttributionAtAction(ctx, membership.principalId);
    const eventId = await ctx.db.insert("missionEvents", {
      missionId: mission._id,
      type: "mission.archived",
      aggregateType: "mission",
      aggregateId: mission._id,
      actorPrincipalId: membership.principalId,
      ...(actorAttributionAtAction ?? {}),
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
