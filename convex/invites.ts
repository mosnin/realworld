import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireActiveMembership, requireAuthenticatedTokenIdentifier, requireRole, requireWritableMission } from "./lib/auth";
import { humanAttributionAtAction } from "./lib/human_attribution";

const inviteRole = v.union(v.literal("builder"), v.literal("reviewer"), v.literal("contributor"), v.literal("observer"));
const membershipRole = v.union(v.literal("owner"), v.literal("steward"), v.literal("builder"), v.literal("reviewer"), v.literal("contributor"), v.literal("observer"), v.literal("agent"));
const receiptMs = 30 * 86400000;
// Archive pauses invitation issuance, redemption, and revocation. Existing
// invite records remain intact and become usable again only after restore.
async function tokenHash(token: string) { const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))); return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""); }
function validToken(token: string) { if (token.length < 32 || token.length > 512) throw new Error("Invalid invite token"); return token; }

/**
 * The issuing console intentionally exposes a narrower policy than the service
 * mutation: only an owner sees issuance controls. The mutation retains steward
 * support for future audited/operator workflows, but never allows privileged
 * roles to be granted by an invitation.
 */
export const inviteManagerContext = query({
  args: { missionId: v.id("missions") },
  returns: v.object({
    mission: v.object({ _id: v.id("missions"), title: v.string() }),
    role: membershipRole,
    canIssue: v.boolean(),
    rooms: v.array(v.object({ _id: v.id("rooms"), title: v.string(), kind: v.string() })),
  }),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.visibility !== "private") throw new Error("Not found");
    const rooms = await ctx.db
      .query("rooms")
      .withIndex("by_mission_and_state", (index) => index.eq("missionId", args.missionId).eq("state", "active"))
      .take(100);
    return {
      mission: { _id: mission._id, title: mission.title },
      role: membership.role,
      canIssue: membership.role === "owner",
      rooms: rooms.map((room) => ({ _id: room._id, title: room.title, kind: room.kind })),
    };
  },
});

/**
 * Owner-facing recovery view for links that may need to be invalidated after
 * the creation dialog has closed. It intentionally returns operational
 * metadata only: invite secrets remain write-only inputs and are never part
 * of a durable projection.
 */
export const listActiveInvites = query({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({
    _id: v.id("invites"),
    role: inviteRole,
    rooms: v.array(v.object({ _id: v.id("rooms"), title: v.string() })),
    expiresAt: v.number(),
    uses: v.number(),
    maxUses: v.number(),
    createdAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId);
    requireRole(membership, ["owner"]);
    const mission = await ctx.db.get(args.missionId);
    if (!mission || mission.visibility !== "private") throw new Error("Not found");

    const now = Date.now();
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_mission_and_state", (index) => index.eq("missionId", args.missionId).eq("state", "active"))
      .order("desc")
      .take(100);

    return await Promise.all(invites
      .filter((invite) => invite.expiresAt > now && invite.uses < invite.maxUses)
      .map(async (invite) => {
        const rooms = (await Promise.all(invite.roomIds.map(async (roomId) => {
          const room = await ctx.db.get(roomId);
          return room !== null && room.missionId === args.missionId
            ? { _id: room._id, title: room.title }
            : null;
        }))).flatMap((room) => room === null ? [] : [room]);
        return {
          _id: invite._id,
          role: invite.role,
          rooms,
          expiresAt: invite.expiresAt,
          uses: invite.uses,
          maxUses: invite.maxUses,
          createdAt: invite.createdAt,
        };
      }));
  },
});

export const createInvite = mutation({
  args: { missionId: v.id("missions"), role: inviteRole, roomIds: v.array(v.id("rooms")), expiresAt: v.number(), maxUses: v.number(), inviteToken: v.string(), idempotencyKey: v.string(), correlationId: v.string() },
  returns: v.object({ inviteId: v.id("invites"), eventId: v.id("missionEvents") }),
  handler: async (ctx, args) => {
    const membership = await requireActiveMembership(ctx, args.missionId); requireRole(membership, ["owner", "steward"]);
    const now = Date.now();
    const hash = await tokenHash(validToken(args.inviteToken)); const scope = `mission:${args.missionId}:invite`; const fingerprint = JSON.stringify({ role: args.role, roomIds: args.roomIds, expiresAt: args.expiresAt, maxUses: args.maxUses, hash });
    const prior = await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", q => q.eq("scope", scope).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (prior) { if (prior.commandFingerprint !== fingerprint) throw new Error("Idempotency key reuse with a different command"); const invite = await ctx.db.query("invites").withIndex("by_token_hash", q => q.eq("tokenHash", hash)).unique(); if (!invite) throw new Error("Invite receipt is inconsistent"); return { inviteId: invite._id, eventId: prior.eventId }; }
    await requireWritableMission(ctx, args.missionId);
    if (args.expiresAt <= now || args.expiresAt > now + 30 * 86400000 || args.maxUses < 1 || args.maxUses > 100 || args.roomIds.length < 1 || args.roomIds.length > 8) throw new Error("Invalid invite constraints");
    for (const roomId of args.roomIds) { const room = await ctx.db.get(roomId); if (!room || room.missionId !== args.missionId || room.state !== "active") throw new Error("Invalid invite room"); }
    if (await ctx.db.query("invites").withIndex("by_token_hash", q => q.eq("tokenHash", hash)).unique()) throw new Error("Invite token already exists");
    const inviteId = await ctx.db.insert("invites", { missionId: args.missionId, issuerPrincipalId: membership.principalId, tokenHash: hash, role: args.role, roomIds: args.roomIds, expiresAt: args.expiresAt, maxUses: args.maxUses, uses: 0, state: "active", createdAt: now, updatedAt: now, schemaVersion: 1 });
    const mission = await ctx.db.get(args.missionId); if (!mission) throw new Error("Not found");
    const actorAttributionAtAction = await humanAttributionAtAction(ctx, membership.principalId);
    const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, type: "membership.invited", aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: membership.principalId, ...(actorAttributionAtAction ?? {}), effectiveRole: membership.role, correlationId: args.correlationId, idempotencyKey: args.idempotencyKey, publicSummary: "Scoped invite created", afterVersion: mission.currentVersion, createdAt: now, schemaVersion: 1 });
    await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint: fingerprint, state: "complete", missionId: mission._id, eventId, resultVersion: mission.currentVersion, correlationId: args.correlationId, createdAt: now, expiresAt: now + receiptMs, schemaVersion: 1 }); return { inviteId, eventId };
  },
});

export const acceptInvite = mutation({
  args: { inviteToken: v.string(), idempotencyKey: v.string(), correlationId: v.string() },
  returns: v.object({ missionId: v.id("missions"), membershipId: v.id("missionMembers"), eventId: v.id("missionEvents"), role: inviteRole }),
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireAuthenticatedTokenIdentifier(ctx); const hash = await tokenHash(validToken(args.inviteToken)); const invite = await ctx.db.query("invites").withIndex("by_token_hash", q => q.eq("tokenHash", hash)).unique(); if (!invite) throw new Error("Invite is unavailable");
    const now = Date.now(); const scope = `invite:${invite._id}:principal:${tokenIdentifier}`; const fingerprint = JSON.stringify({ command: "acceptInvite", hash }); const prior = await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", q => q.eq("scope", scope).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (prior) { if (prior.commandFingerprint !== fingerprint) throw new Error("Idempotency key reuse with a different command"); const replayPrincipal = await ctx.db.query("principals").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", tokenIdentifier)).unique(); const member = replayPrincipal === null ? null : await ctx.db.query("missionMembers").withIndex("by_mission_and_principal", q => q.eq("missionId", invite.missionId).eq("principalId", replayPrincipal._id)).unique(); if (!member) throw new Error("Invite receipt is inconsistent"); return { missionId: prior.missionId, membershipId: member._id, eventId: prior.eventId, role: invite.role }; }
    await requireWritableMission(ctx, invite.missionId);
    if (invite.state !== "active" || invite.expiresAt <= now || invite.uses >= invite.maxUses) throw new Error("Invite is unavailable");
    let principal = await ctx.db.query("principals").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", tokenIdentifier)).unique(); if (!principal) { const id = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 }); principal = await ctx.db.get(id); } if (!principal || principal.type !== "human" || principal.state !== "active") throw new Error("Unauthorized");
    const existing = await ctx.db.query("missionMembers").withIndex("by_mission_and_principal", q => q.eq("missionId", invite.missionId).eq("principalId", principal!._id)).unique(); if (existing?.state === "active") throw new Error("Already a Mission member");
    const membershipId = existing ? (await ctx.db.patch(existing._id, { role: invite.role, state: "active", scope: invite.roomIds.map(id => `room:${id}`), grantVersion: existing.grantVersion + 1, updatedAt: now }), existing._id) : await ctx.db.insert("missionMembers", { missionId: invite.missionId, principalId: principal._id, role: invite.role, state: "active", scope: invite.roomIds.map(id => `room:${id}`), grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    const uses = invite.uses + 1; const state = uses >= invite.maxUses ? "exhausted" : "active"; await ctx.db.patch(invite._id, { uses, state, updatedAt: now }); const mission = await ctx.db.get(invite.missionId); if (!mission) throw new Error("Not found"); const actorAttributionAtAction = await humanAttributionAtAction(ctx, principal._id); const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, type: "membership.joined", aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: principal._id, ...(actorAttributionAtAction ?? {}), effectiveRole: invite.role, correlationId: args.correlationId, idempotencyKey: args.idempotencyKey, publicSummary: "Contributor joined through a scoped invite", afterVersion: mission.currentVersion, createdAt: now, schemaVersion: 1 }); await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint: fingerprint, state: "complete", missionId: mission._id, eventId, resultVersion: mission.currentVersion, correlationId: args.correlationId, createdAt: now, expiresAt: now + receiptMs, schemaVersion: 1 }); return { missionId: mission._id, membershipId, eventId, role: invite.role };
  },
});

export const revokeInvite = mutation({
  args: { inviteId: v.id("invites"), idempotencyKey: v.string(), correlationId: v.string() },
  returns: v.object({ inviteId: v.id("invites"), eventId: v.id("missionEvents") }),
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId); if (!invite) throw new Error("Not found"); const membership = await requireActiveMembership(ctx, invite.missionId); requireRole(membership, ["owner", "steward"]);
    const scope = `invite:${invite._id}:revoke`; const fingerprint = JSON.stringify({ command: "revokeInvite", inviteId: invite._id }); const prior = await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", q => q.eq("scope", scope).eq("idempotencyKey", args.idempotencyKey)).unique(); if (prior) { if (prior.commandFingerprint !== fingerprint) throw new Error("Idempotency key reuse with a different command"); return { inviteId: invite._id, eventId: prior.eventId }; }
    await requireWritableMission(ctx, invite.missionId);
    const now = Date.now(); await ctx.db.patch(invite._id, { state: "revoked", updatedAt: now }); const mission = await ctx.db.get(invite.missionId); if (!mission) throw new Error("Not found"); const actorAttributionAtAction = await humanAttributionAtAction(ctx, membership.principalId); const eventId = await ctx.db.insert("missionEvents", { missionId: mission._id, type: "invite.revoked", aggregateType: "mission", aggregateId: mission._id, actorPrincipalId: membership.principalId, ...(actorAttributionAtAction ?? {}), effectiveRole: membership.role, correlationId: args.correlationId, idempotencyKey: args.idempotencyKey, publicSummary: "Scoped invite revoked", afterVersion: mission.currentVersion, createdAt: now, schemaVersion: 1 }); await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint: fingerprint, state: "complete", missionId: mission._id, eventId, resultVersion: mission.currentVersion, correlationId: args.correlationId, createdAt: now, expiresAt: now + receiptMs, schemaVersion: 1 }); return { inviteId: invite._id, eventId };
  },
});
