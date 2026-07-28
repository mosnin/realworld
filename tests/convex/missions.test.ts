import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

// Keep this explicit map Node/TypeScript-compatible. `convex-test` uses the
// generated entry to infer the Convex root, then resolves `missions` from it.
const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/invites.ts": () => import("../../convex/invites"),
  "../../convex/canvas.ts": () => import("../../convex/canvas"),
  "../../convex/launch.ts": () => import("../../convex/launch"),
};

function createTest() {
  return convexTest(schema, modules);
}

const ownerIdentity = {
  tokenIdentifier: "https://realworld.test|owner",
  subject: "owner",
  issuer: "https://realworld.test",
  name: "Owner",
};

const contributorIdentity = {
  tokenIdentifier: "https://realworld.test|contributor",
  subject: "contributor",
  issuer: "https://realworld.test",
  name: "Contributor",
};

const createArgs = {
  slug: "build-a-living-world",
  title: "Build a living world",
  summary: "A private Mission with durable, attributable collaboration.",
  idempotencyKey: "create-mission-001",
  correlationId: "correlation-create-001",
};

async function createMission(t = createTest()) {
  const asOwner = t.withIdentity(ownerIdentity);
  const result = await asOwner.mutation(api.missions.createPrivateMission, createArgs);
  return { t, asOwner, result };
}

describe("missions", () => {
  it("rejects an unauthenticated private Mission creation", async () => {
    const t = createTest();

    await expect(t.mutation(api.missions.createPrivateMission, createArgs)).rejects.toThrow("Unauthorized");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("missions").collect()).toHaveLength(0);
      expect(await ctx.db.query("principals").collect()).toHaveLength(0);
      expect(await ctx.db.query("missionEvents").collect()).toHaveLength(0);
    });
  });

  it("creates a private Mission with owner membership and an append-only creation event", async () => {
    const { t, result } = await createMission();

    await t.run(async (ctx) => {
      const mission = await ctx.db.get(result.missionId);
      expect(mission).toMatchObject({
        slug: createArgs.slug,
        title: createArgs.title,
        summary: createArgs.summary,
        visibility: "private",
        lifecycle: "active",
        currentVersion: 1,
        eventSequence: 1,
      });

      const owner = await ctx.db.get(mission!.ownerPrincipalId);
      expect(owner).toMatchObject({
        type: "human",
        state: "active",
        tokenIdentifier: ownerIdentity.tokenIdentifier,
      });

      const membership = await ctx.db
        .query("missionMembers")
        .withIndex("by_mission_and_principal", (q) =>
          q.eq("missionId", result.missionId).eq("principalId", mission!.ownerPrincipalId),
        )
        .unique();
      expect(membership).toMatchObject({
        role: "owner",
        state: "active",
        scope: ["mission:*"],
        grantVersion: 1,
      });

      const event = await ctx.db
        .query("missionEvents")
        .withIndex("by_mission_and_sequence", (q) => q.eq("missionId", result.missionId).eq("missionSequence", 1))
        .unique();
      expect(event).toMatchObject({
        type: "mission.created",
        aggregateType: "mission",
        aggregateId: result.missionId,
        actorPrincipalId: mission!.ownerPrincipalId,
        effectiveRole: "owner",
        idempotencyKey: createArgs.idempotencyKey,
        correlationId: createArgs.correlationId,
        afterVersion: 1,
      });

      const receipt = await ctx.db
        .query("operationReceipts")
        .withIndex("by_scope_and_idempotency_key", (q) =>
          q.eq("scope", `principal:${ownerIdentity.tokenIdentifier}:createMission`).eq("idempotencyKey", createArgs.idempotencyKey),
        )
        .unique();
      expect(receipt).toMatchObject({
        missionId: result.missionId,
        eventId: result.eventId,
        resultVersion: 1,
      });
    });
  });

  it("replays the same creation idempotency key without another Mission, event, or receipt", async () => {
    const { t, asOwner, result } = await createMission();

    const replay = await asOwner.mutation(api.missions.createPrivateMission, createArgs);
    expect(replay).toEqual(result);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("missions").collect()).toHaveLength(1);
      expect(await ctx.db.query("missionEvents").collect()).toHaveLength(1);
      expect(await ctx.db.query("operationReceipts").collect()).toHaveLength(1);
    });
  });

  it("rejects an idempotency key reused for a different create command", async () => {
    const { asOwner } = await createMission();

    await expect(
      asOwner.mutation(api.missions.createPrivateMission, {
        ...createArgs,
        title: "A different Mission",
      }),
    ).rejects.toThrow("Idempotency key reuse with a different command");
  });

  it("keeps a private Mission unreadable to an authenticated non-member", async () => {
    const { t, asOwner } = await createMission();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("principals", {
        type: "human",
        state: "active",
        tokenIdentifier: contributorIdentity.tokenIdentifier,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
    });

    expect(await asOwner.query(api.missions.getPrivateMissionBySlug, { slug: createArgs.slug })).toMatchObject({
      slug: createArgs.slug,
      role: "owner",
    });
    const outsider = t.withIdentity(contributorIdentity);
    expect(await outsider.query(api.missions.getPrivateMissionBySlug, { slug: createArgs.slug })).toBeNull();
  });

  it("allows only the owner to archive, detects a stale version, and replays a successful archive", async () => {
    const { t, asOwner, result } = await createMission();

    await t.run(async (ctx) => {
      const now = Date.now();
      const contributorPrincipalId = await ctx.db.insert("principals", {
        type: "human",
        state: "active",
        tokenIdentifier: contributorIdentity.tokenIdentifier,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      await ctx.db.insert("missionMembers", {
        missionId: result.missionId,
        principalId: contributorPrincipalId,
        role: "contributor",
        state: "active",
        scope: ["artifact:propose"],
        grantVersion: 1,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
    });

    const asContributor = t.withIdentity(contributorIdentity);
    const archiveArgs = {
      missionId: result.missionId,
      expectedVersion: 1,
      idempotencyKey: "archive-mission-001",
      correlationId: "correlation-archive-001",
    };

    await expect(asContributor.mutation(api.missions.archivePrivateMission, archiveArgs)).rejects.toThrow("Not found");
    await expect(
      asOwner.mutation(api.missions.archivePrivateMission, { ...archiveArgs, expectedVersion: 0 }),
    ).rejects.toThrow("Mission version conflict");

    const archived = await asOwner.mutation(api.missions.archivePrivateMission, archiveArgs);
    expect(archived).toMatchObject({ missionId: result.missionId, currentVersion: 2 });
    expect(await asOwner.mutation(api.missions.archivePrivateMission, archiveArgs)).toEqual(archived);

    await t.run(async (ctx) => {
      const mission = await ctx.db.get(result.missionId);
      expect(mission).toMatchObject({ lifecycle: "archived", currentVersion: 2, eventSequence: 2 });

      const events = await ctx.db
        .query("missionEvents")
        .withIndex("by_mission_and_sequence", (q) => q.eq("missionId", result.missionId))
        .collect();
      expect(events.map((event) => [event.missionSequence, event.type])).toEqual([
        [1, "mission.created"],
        [2, "mission.archived"],
      ]);

      const archiveReceipt = await ctx.db
        .query("operationReceipts")
        .withIndex("by_scope_and_idempotency_key", (q) =>
          q.eq("scope", `mission:${result.missionId}:archive`).eq("idempotencyKey", archiveArgs.idempotencyKey),
        )
        .unique();
      expect(archiveReceipt).toMatchObject({ eventId: archived.eventId, resultVersion: 2 });
    });
  });

  it("edits, archives, and restores a private Mission with OCC and replayable events", async () => {
    const { t, asOwner, result } = await createMission();
    const edited = await asOwner.mutation(api.missions.editPrivateMission, { missionId: result.missionId, title: "Living world", summary: "An edited private Mission.", expectedVersion: 1, idempotencyKey: "edit-1", correlationId: "edit-c" });
    expect(edited.currentVersion).toBe(2);
    expect(await asOwner.mutation(api.missions.editPrivateMission, { missionId: result.missionId, title: "Living world", summary: "An edited private Mission.", expectedVersion: 1, idempotencyKey: "edit-1", correlationId: "edit-c" })).toEqual(edited);
    const archived = await asOwner.mutation(api.missions.archivePrivateMission, { missionId: result.missionId, expectedVersion: 2, idempotencyKey: "archive-after-edit", correlationId: "archive-c" });
    const restored = await asOwner.mutation(api.missions.restorePrivateMission, { missionId: result.missionId, expectedVersion: archived.currentVersion, idempotencyKey: "restore-1", correlationId: "restore-c" });
    expect(restored.currentVersion).toBe(4);
    await t.run(async (ctx) => { const mission = await ctx.db.get(result.missionId); const events = await ctx.db.query("missionEvents").withIndex("by_mission_and_sequence", (query) => query.eq("missionId", result.missionId)).collect(); expect(mission).toMatchObject({ title: "Living world", lifecycle: "active", currentVersion: 4 }); expect(events.map((event) => event.type)).toEqual(["mission.created", "mission.updated", "mission.archived", "mission.restored"]); });
  });

  it("denies expired memberships across Mission discovery, historical reads, and writes", async () => {
    const { t, asOwner, result } = await createMission();
    await t.run(async (ctx) => {
      const mission = await ctx.db.get(result.missionId);
      const membership = await ctx.db.query("missionMembers").withIndex("by_mission_and_principal", (query) => query.eq("missionId", result.missionId).eq("principalId", mission!.ownerPrincipalId)).unique();
      await ctx.db.patch(membership!._id, { expiresAt: Date.now() - 1 });
    });

    expect(await asOwner.query(api.missions.listMyMissions, {})).toEqual([]);
    expect(await asOwner.query(api.missions.getPrivateMissionBySlug, { slug: createArgs.slug })).toBeNull();
    await expect(asOwner.mutation(api.missions.editPrivateMission, { missionId: result.missionId, title: "Expired", summary: "No longer authorized.", expectedVersion: 1, idempotencyKey: "expired-edit", correlationId: "expired" })).rejects.toThrow("Not found");
  });

  it("keeps archived Missions discoverable as read-only history for unexpired collaborators", async () => {
    const { t, asOwner, result } = await createMission();
    await t.run(async (ctx) => {
      const now = Date.now();
      const principalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: contributorIdentity.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await ctx.db.insert("missionMembers", { missionId: result.missionId, principalId, role: "observer", state: "active", scope: ["mission:read"], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId: result.missionId, expectedVersion: 1, idempotencyKey: "history-archive", correlationId: "history" });

    expect(await t.withIdentity(contributorIdentity).query(api.missions.listMyMissions, {})).toEqual([expect.objectContaining({ _id: result.missionId, lifecycle: "archived", role: "observer" })]);
  });
});

describe("invites and durable canvas", () => {
  async function roomFor(t: ReturnType<typeof createTest>, missionId: Awaited<ReturnType<typeof createMission>>["result"]["missionId"]) {
    return await t.run(async (ctx) => ctx.db.insert("rooms", { missionId, kind: "workshop", title: "Workshop", accessPolicy: "mission", mapType: "field", layout: { x: 0, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
  }

  it("creates, accepts, replays, and revokes a scoped contributor invite without storing the token", async () => {
    const { t, asOwner, result } = await createMission(); const roomId = await roomFor(t, result.missionId); const token = "a".repeat(40);
    const invite = await asOwner.mutation(api.invites.createInvite, { missionId: result.missionId, role: "contributor", roomIds: [roomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: token, idempotencyKey: "invite-1", correlationId: "invite-c" });
    const guest = t.withIdentity(contributorIdentity); const accepted = await guest.mutation(api.invites.acceptInvite, { inviteToken: token, idempotencyKey: "accept-1", correlationId: "accept-c" });
    expect(accepted.role).toBe("contributor"); expect(await guest.mutation(api.invites.acceptInvite, { inviteToken: token, idempotencyKey: "accept-1", correlationId: "accept-c" })).toEqual(accepted);
    await asOwner.mutation(api.invites.revokeInvite, { inviteId: invite.inviteId, idempotencyKey: "revoke-1", correlationId: "revoke-c" });
    await t.run(async (ctx) => { const stored = await ctx.db.get(invite.inviteId); expect(stored?.tokenHash).not.toBe(token); expect(stored).toMatchObject({ uses: 1, state: "revoked" }); });
  });

  it("exposes active rooms to members but reserves the issuing console for the owner", async () => {
    const { t, asOwner, result } = await createMission();
    const roomId = await roomFor(t, result.missionId);
    const ownerContext = await asOwner.query(api.invites.inviteManagerContext, { missionId: result.missionId });
    expect(ownerContext).toMatchObject({ mission: { _id: result.missionId, title: createArgs.title }, role: "owner", canIssue: true });
    expect(ownerContext.rooms).toEqual([expect.objectContaining({ _id: roomId, title: "Workshop", kind: "workshop" })]);

    await t.run(async (ctx) => {
      const now = Date.now();
      const contributorPrincipalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: contributorIdentity.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await ctx.db.insert("missionMembers", { missionId: result.missionId, principalId: contributorPrincipalId, role: "contributor", state: "active", scope: [`room:${roomId}`], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });
    await expect(t.withIdentity(contributorIdentity).query(api.invites.inviteManagerContext, { missionId: result.missionId })).resolves.toMatchObject({ role: "contributor", canIssue: false });
  });

  it("rejects owner/steward grants, expired/max-use tokens, non-owner issuers, and cross-mission rooms", async () => {
    const { t, asOwner, result } = await createMission(); const roomId = await roomFor(t, result.missionId); const guest = t.withIdentity(contributorIdentity);
    await expect(asOwner.mutation(api.invites.createInvite, { missionId: result.missionId, role: "owner" as never, roomIds: [roomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: "b".repeat(40), idempotencyKey: "bad-role", correlationId: "c" })).rejects.toThrow();
    await expect(asOwner.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: "z".repeat(40), idempotencyKey: "empty-rooms", correlationId: "c" })).rejects.toThrow("Invalid invite constraints");
    await t.run(async (ctx) => { const id = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: contributorIdentity.tokenIdentifier, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }); await ctx.db.insert("missionMembers", { missionId: result.missionId, principalId: id, role: "contributor", state: "active", scope: [], grantVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }); });
    await expect(guest.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [roomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: "c".repeat(40), idempotencyKey: "guest-invite", correlationId: "c" })).rejects.toThrow("Not found");
  });

  it("rejects fresh acceptance after revocation or maximum-use exhaustion", async () => {
    const { t, asOwner, result } = await createMission();
    const roomId = await roomFor(t, result.missionId);
    const revokedToken = "d".repeat(40);
    const revoked = await asOwner.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [roomId], expiresAt: Date.now() + 60_000, maxUses: 2, inviteToken: revokedToken, idempotencyKey: "revoked-invite", correlationId: "revoked-c" });
    await asOwner.mutation(api.invites.revokeInvite, { inviteId: revoked.inviteId, idempotencyKey: "revoke-before-accept", correlationId: "revoke-c" });
    await expect(t.withIdentity(contributorIdentity).mutation(api.invites.acceptInvite, { inviteToken: revokedToken, idempotencyKey: "revoked-accept", correlationId: "revoked-accept-c" })).rejects.toThrow("Invite is unavailable");

    const limitedToken = "e".repeat(40);
    await asOwner.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [roomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: limitedToken, idempotencyKey: "limited-invite", correlationId: "limited-c" });
    await t.withIdentity(contributorIdentity).mutation(api.invites.acceptInvite, { inviteToken: limitedToken, idempotencyKey: "limited-first", correlationId: "limited-first-c" });
    await expect(t.withIdentity({ ...contributorIdentity, tokenIdentifier: "https://realworld.test|second-guest", subject: "second-guest" }).mutation(api.invites.acceptInvite, { inviteToken: limitedToken, idempotencyKey: "limited-second", correlationId: "limited-second-c" })).rejects.toThrow("Invite is unavailable");
  });

  it("freezes room and invitation writes while a Mission is archived", async () => {
    const { t, asOwner, result } = await createMission(); const roomId = await roomFor(t, result.missionId);
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId: result.missionId, expectedVersion: 1, idempotencyKey: "freeze-archive", correlationId: "freeze" });
    await expect(asOwner.mutation(api.canvas.updateRoomLayout, { roomId, expectedLayoutVersion: 1, layout: { x: 20, y: 20, width: 220, height: 140 }, idempotencyKey: "freeze-layout" })).rejects.toThrow("Mission is not active");
    await expect(asOwner.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [roomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: "q".repeat(40), idempotencyKey: "freeze-invite", correlationId: "freeze" })).rejects.toThrow("Mission is not active");
  });

  it("replays completed room and invitation commands after archive without unfreezing writes", async () => {
    const { asOwner, result } = await createMission();
    const roomArgs = { missionId: result.missionId, title: "Replay room", kind: "branchLab" as const, layout: { x: 100, y: 200, width: 220, height: 140 }, idempotencyKey: "replay-room" };
    const createdRoom = await asOwner.mutation(api.canvas.createRoom, roomArgs);
    const inviteArgs = { missionId: result.missionId, role: "observer" as const, roomIds: [createdRoom.roomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: "r".repeat(40), idempotencyKey: "replay-invite", correlationId: "replay" };
    const createdInvite = await asOwner.mutation(api.invites.createInvite, inviteArgs);
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId: result.missionId, expectedVersion: 1, idempotencyKey: "replay-archive", correlationId: "replay" });

    await expect(asOwner.mutation(api.canvas.createRoom, roomArgs)).resolves.toEqual(createdRoom);
    await expect(asOwner.mutation(api.invites.createInvite, inviteArgs)).resolves.toEqual(createdInvite);
    await expect(asOwner.mutation(api.canvas.createRoom, { ...roomArgs, idempotencyKey: "fresh-archived-room" })).rejects.toThrow("Mission is not active");
  });

  it("does not let an authenticated agent principal redeem a human invitation", async () => {
    const { t, asOwner, result } = await createMission();
    const roomId = await roomFor(t, result.missionId);
    const token = "f".repeat(40);
    await asOwner.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [roomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: token, idempotencyKey: "agent-invite", correlationId: "agent-c" });
    const agentIdentity = { tokenIdentifier: "https://realworld.test|agent", subject: "agent", issuer: "https://realworld.test", name: "Agent" };
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("principals", { type: "agent", state: "active", tokenIdentifier: agentIdentity.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });
    await expect(t.withIdentity(agentIdentity).mutation(api.invites.acceptInvite, { inviteToken: token, idempotencyKey: "agent-accept", correlationId: "agent-accept-c" })).rejects.toThrow("Unauthorized");
  });

  it("enforces canvas membership, OCC, and Mission isolation", async () => {
    const { t, asOwner, result } = await createMission(); const roomId = await roomFor(t, result.missionId); const guest = t.withIdentity(contributorIdentity);
    await expect(guest.query(api.canvas.roomLayouts, { missionId: result.missionId })).rejects.toThrow("Unauthorized");
    const moved = await asOwner.mutation(api.canvas.updateRoomLayout, { roomId, expectedLayoutVersion: 1, layout: { x: 20, y: 30, width: 300, height: 200 }, idempotencyKey: "layout-1" }); expect(moved.layoutVersion).toBe(2);
    await expect(asOwner.mutation(api.canvas.updateRoomLayout, { roomId, expectedLayoutVersion: 1, layout: { x: 21, y: 30, width: 300, height: 200 }, idempotencyKey: "layout-stale" })).rejects.toThrow("Room layout version conflict");
    await t.run(async (ctx) => {
      const mission = await ctx.db.get(result.missionId);
      const events = await ctx.db.query("missionEvents").withIndex("by_mission_and_sequence", (query) => query.eq("missionId", result.missionId)).collect();
      expect(mission?.eventSequence).toBe(2);
      expect(events.map((event) => [event.missionSequence, event.type])).toEqual([[1, "mission.created"], [2, "room.layoutUpdated"]]);
    });
  });

  it("returns only explicitly scoped rooms to a contributor invite membership", async () => {
    const { t, asOwner, result } = await createMission();
    const allowedRoomId = await roomFor(t, result.missionId);
    const hiddenRoomId = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId: result.missionId, kind: "observatory", title: "Hidden Observatory", accessPolicy: "mission", mapType: "field", layout: { x: 300, y: 180, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
    await t.run(async (ctx) => {
      const now = Date.now();
      const contributorPrincipalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: contributorIdentity.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await ctx.db.insert("missionMembers", { missionId: result.missionId, principalId: contributorPrincipalId, role: "contributor", state: "active", scope: [`room:${allowedRoomId}`], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });
    expect((await asOwner.query(api.canvas.roomLayouts, { missionId: result.missionId })).map((room) => room._id).sort()).toEqual([allowedRoomId, hiddenRoomId].sort());
    expect((await t.withIdentity(contributorIdentity).query(api.canvas.roomLayouts, { missionId: result.missionId })).map((room) => room._id)).toEqual([allowedRoomId]);
  });

  it("enforces the Mission role matrix across archive, invites, and durable rooms", async () => {
    const { t, asOwner, result } = await createMission();
    const sharedRoomId = await roomFor(t, result.missionId);
    const identities = {
      steward: { tokenIdentifier: "https://realworld.test|steward", subject: "steward", issuer: "https://realworld.test", name: "Steward" },
      builder: { tokenIdentifier: "https://realworld.test|builder", subject: "builder", issuer: "https://realworld.test", name: "Builder" },
      reviewer: { tokenIdentifier: "https://realworld.test|reviewer", subject: "reviewer", issuer: "https://realworld.test", name: "Reviewer" },
      observer: { tokenIdentifier: "https://realworld.test|observer", subject: "observer", issuer: "https://realworld.test", name: "Observer" },
      agent: { tokenIdentifier: "https://realworld.test|agent-matrix", subject: "agent-matrix", issuer: "https://realworld.test", name: "Agent" },
      revoked: { tokenIdentifier: "https://realworld.test|revoked", subject: "revoked", issuer: "https://realworld.test", name: "Revoked" },
    };
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const [role, identity] of Object.entries(identities)) {
        const isAgent = role === "agent";
        const isRevoked = role === "revoked";
        const principalId = await ctx.db.insert("principals", { type: isAgent ? "agent" : "human", state: "active", tokenIdentifier: identity.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
        await ctx.db.insert("missionMembers", { missionId: result.missionId, principalId, role: isAgent ? "agent" : isRevoked ? "observer" : role as "steward" | "builder" | "reviewer" | "observer", state: isRevoked ? "revoked" : "active", scope: role === "reviewer" || role === "observer" ? [`room:${sharedRoomId}`] : ["mission:*"], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
      }
      const contributorPrincipalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: contributorIdentity.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await ctx.db.insert("missionMembers", { missionId: result.missionId, principalId: contributorPrincipalId, role: "contributor", state: "active", scope: [`room:${sharedRoomId}`], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });

    const asSteward = t.withIdentity(identities.steward);
    const asBuilder = t.withIdentity(identities.builder);
    const asReviewer = t.withIdentity(identities.reviewer);
    const asContributor = t.withIdentity(contributorIdentity);
    const asObserver = t.withIdentity(identities.observer);
    const asAgent = t.withIdentity(identities.agent);
    const asRevoked = t.withIdentity(identities.revoked);

    expect((await asSteward.query(api.canvas.roomLayouts, { missionId: result.missionId })).map((room) => room._id)).toEqual([sharedRoomId]);
    expect((await asBuilder.query(api.canvas.roomLayouts, { missionId: result.missionId })).map((room) => room._id)).toEqual([sharedRoomId]);
    expect((await asReviewer.query(api.canvas.roomLayouts, { missionId: result.missionId })).map((room) => room._id)).toEqual([sharedRoomId]);
    expect((await asContributor.query(api.canvas.roomLayouts, { missionId: result.missionId })).map((room) => room._id)).toEqual([sharedRoomId]);
    expect((await asObserver.query(api.canvas.roomLayouts, { missionId: result.missionId })).map((room) => room._id)).toEqual([sharedRoomId]);
    await expect(t.query(api.canvas.roomLayouts, { missionId: result.missionId })).rejects.toThrow("Unauthorized");
    await expect(asAgent.query(api.canvas.roomLayouts, { missionId: result.missionId })).rejects.toThrow("Unauthorized");
    await expect(asRevoked.query(api.canvas.roomLayouts, { missionId: result.missionId })).rejects.toThrow("Not found");

    const roomCommand = (title: string, idempotencyKey: string) => ({ missionId: result.missionId, title, kind: "branchLab" as const, layout: { x: 100, y: 200, width: 220, height: 140 }, idempotencyKey });
    await expect(asSteward.mutation(api.canvas.createRoom, roomCommand("Steward room", "matrix-steward-room"))).resolves.toMatchObject({ layoutVersion: 1 });
    await expect(asBuilder.mutation(api.canvas.createRoom, roomCommand("Builder room", "matrix-builder-room"))).resolves.toMatchObject({ layoutVersion: 1 });
    for (const [label, actor] of [["reviewer", asReviewer], ["contributor", asContributor], ["observer", asObserver], ["agent", asAgent], ["revoked", asRevoked]] as const) {
      await expect(actor.mutation(api.canvas.createRoom, roomCommand(`${label} room`, `matrix-${label}-room`))).rejects.toThrow();
    }

    const ownerInvite = await asOwner.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [sharedRoomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: "g".repeat(40), idempotencyKey: "matrix-owner-invite", correlationId: "matrix" });
    await expect(asSteward.mutation(api.invites.revokeInvite, { inviteId: ownerInvite.inviteId, idempotencyKey: "matrix-steward-revoke", correlationId: "matrix" })).resolves.toMatchObject({ inviteId: ownerInvite.inviteId });
    await expect(asSteward.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [sharedRoomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: "h".repeat(40), idempotencyKey: "matrix-steward-invite", correlationId: "matrix" })).resolves.toMatchObject({ inviteId: expect.any(String) });
    for (const [label, actor] of [["builder", asBuilder], ["reviewer", asReviewer], ["contributor", asContributor], ["observer", asObserver], ["agent", asAgent], ["revoked", asRevoked]] as const) {
      await expect(actor.mutation(api.invites.createInvite, { missionId: result.missionId, role: "observer", roomIds: [sharedRoomId], expiresAt: Date.now() + 60_000, maxUses: 1, inviteToken: `${label.padEnd(32, "x")}`, idempotencyKey: `matrix-${label}-invite`, correlationId: "matrix" })).rejects.toThrow();
    }
    await expect(asSteward.mutation(api.missions.archivePrivateMission, { missionId: result.missionId, expectedVersion: 1, idempotencyKey: "matrix-steward-archive", correlationId: "matrix" })).rejects.toThrow("Not found");
  });

  it("creates, renames, and archives rooms with role checks and room-version OCC", async () => {
    const { t, asOwner, result } = await createMission();
    await t.run(async (ctx) => {
      const now = Date.now();
      const contributorPrincipalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: contributorIdentity.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await ctx.db.insert("missionMembers", { missionId: result.missionId, principalId: contributorPrincipalId, role: "contributor", state: "active", scope: ["mission:read"], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });
    await expect(t.withIdentity(contributorIdentity).mutation(api.canvas.createRoom, { missionId: result.missionId, title: "Unauthorized", kind: "branchLab", layout: { x: 100, y: 200, width: 220, height: 140 }, idempotencyKey: "unauthorized-create" })).rejects.toThrow("Not found");
    const created = await asOwner.mutation(api.canvas.createRoom, { missionId: result.missionId, title: "Sound check", kind: "branchLab", layout: { x: 100, y: 200, width: 220, height: 140 }, idempotencyKey: "room-create" });
    expect(await asOwner.mutation(api.canvas.createRoom, { missionId: result.missionId, title: "Sound check", kind: "branchLab", layout: { x: 100, y: 200, width: 220, height: 140 }, idempotencyKey: "room-create" })).toEqual(created);
    const renamed = await asOwner.mutation(api.canvas.renameRoom, { roomId: created.roomId, title: "Audio check", expectedVersion: 1, idempotencyKey: "room-rename" });
    expect(renamed.currentVersion).toBe(2);
    await expect(asOwner.mutation(api.canvas.archiveRoom, { roomId: created.roomId, expectedVersion: 1, idempotencyKey: "room-archive-stale" })).rejects.toThrow("Room version conflict");
    const archived = await asOwner.mutation(api.canvas.archiveRoom, { roomId: created.roomId, expectedVersion: 2, idempotencyKey: "room-archive" });
    expect(archived.currentVersion).toBe(3);
    await t.run(async (ctx) => {
      const room = await ctx.db.get(created.roomId);
      const mission = await ctx.db.get(result.missionId);
      expect(room).toMatchObject({ title: "Audio check", state: "archived", currentVersion: 3 });
      expect(mission?.eventSequence).toBe(4);
    });
  });
});
