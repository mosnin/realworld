import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

// Keep this explicit map Node/TypeScript-compatible. `convex-test` uses the
// generated entry to infer the Convex root, then resolves `missions` from it.
const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
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
});
