import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
  "../../convex/pulse.ts": () => import("../../convex/pulse"),
};

const owner = { tokenIdentifier: "https://realworld.test|pulse-owner", subject: "pulse-owner", issuer: "https://realworld.test", name: "Pulse owner" };

function identity(name: string) {
  return { tokenIdentifier: `https://realworld.test|pulse-${name}`, subject: `pulse-${name}`, issuer: "https://realworld.test", name: `Pulse ${name}` };
}

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const mission = await asOwner.mutation(api.missions.createPrivateMission, {
    slug: "pulse-kernel",
    title: "Pulse kernel",
    summary: "Authoritative bounded activity.",
    idempotencyKey: "pulse-mission",
    correlationId: "pulse-mission",
  });
  const [workshopId, restrictedId] = await t.run(async (ctx) => {
    const now = Date.now();
    const workshopId = await ctx.db.insert("rooms", {
      missionId: mission.missionId,
      kind: "workshop",
      title: "Workshop",
      accessPolicy: "mission",
      mapType: "field",
      layout: { x: 0, y: 0, width: 220, height: 140 },
      layoutVersion: 1,
      state: "active",
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    const restrictedId = await ctx.db.insert("rooms", {
      missionId: mission.missionId,
      kind: "observatory",
      title: "Restricted",
      accessPolicy: "restricted",
      mapType: "field",
      layout: { x: 240, y: 0, width: 220, height: 140 },
      layoutVersion: 1,
      state: "active",
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    return [workshopId, restrictedId];
  });
  return { t, asOwner, missionId: mission.missionId, workshopId, restrictedId };
}

async function grant(
  t: Awaited<ReturnType<typeof setup>>["t"],
  missionId: Awaited<ReturnType<typeof setup>>["missionId"],
  name: string,
  role: "builder" | "reviewer" | "observer",
  scope: string[],
) {
  const member = identity(name);
  await t.run(async (ctx) => {
    const now = Date.now();
    const principalId = await ctx.db.insert("principals", {
      type: "human",
      state: "active",
      tokenIdentifier: member.tokenIdentifier,
      displayName: member.name,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    await ctx.db.insert("missionMembers", {
      missionId,
      principalId,
      role,
      state: "active",
      scope,
      grantVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  });
  return t.withIdentity(member);
}

function createMoveArgs(
  missionId: Awaited<ReturnType<typeof setup>>["missionId"],
  roomId: Awaited<ReturnType<typeof setup>>["workshopId"],
  idempotencyKey: string,
) {
  return {
    missionId,
    roomId,
    title: `Move ${idempotencyKey}`,
    intent: "Produce a durable bounded activity event.",
    dependencyMoveIds: [],
    idempotencyKey,
    correlationId: idempotencyKey,
  };
}

describe("Pulse kernel", () => {
  it("projects authoritative room activity newest-first, bounded, and without principal identifiers", async () => {
    const { t, asOwner, missionId, workshopId, restrictedId } = await setup();
    const asBuilder = await grant(t, missionId, "builder", "builder", [`room:${workshopId}`]);
    const workshopMove = await asBuilder.mutation(api.moves.createMove, createMoveArgs(missionId, workshopId, "workshop-move"));
    const restrictedMove = await asOwner.mutation(api.moves.createMove, createMoveArgs(missionId, restrictedId, "restricted-move"));
    const legacyEventId = await t.run(async (ctx) => {
      const mission = await ctx.db.get(missionId);
      const principal = await ctx.db.query("principals")
        .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", owner.tokenIdentifier))
        .unique();
      if (!mission || !principal) throw new Error("Test setup failed");
      const missionSequence = mission.eventSequence + 1;
      await ctx.db.patch(missionId, { eventSequence: missionSequence, updatedAt: Date.now() });
      return await ctx.db.insert("missionEvents", {
        missionId,
        missionSequence,
        type: "move.created",
        aggregateType: "mission",
        aggregateId: missionId,
        actorPrincipalId: principal._id,
        effectiveRole: "owner",
        correlationId: "legacy-pulse-event",
        idempotencyKey: "legacy-pulse-event",
        publicSummary: "A legacy room event without an immutable scope",
        afterVersion: 1,
        createdAt: Date.now(),
        schemaVersion: 1,
      });
    });

    const ownerPulse = await asOwner.query(api.pulse.listMissionPulse, { missionId, limit: 50 });
    expect(ownerPulse.map((entry) => entry.missionSequence)).toEqual([...ownerPulse.map((entry) => entry.missionSequence)].sort((left, right) => right - left));
    expect(ownerPulse).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: workshopMove.eventId, roomId: workshopId, roomTitle: "Workshop", actorDisplayName: "Pulse builder", actorType: "human", eventType: "move.created" }),
      expect.objectContaining({ _id: restrictedMove.eventId, roomId: restrictedId, roomTitle: "Restricted" }),
      expect.objectContaining({ eventType: "mission.created" }),
    ]));
    expect(ownerPulse.map((entry) => entry._id)).not.toContain(legacyEventId);
    expect(ownerPulse[0]).not.toHaveProperty("actorPrincipalId");
    expect(ownerPulse[0]).not.toHaveProperty("correlationId");
    expect(await asOwner.query(api.pulse.listMissionPulse, { missionId, limit: 1 })).toHaveLength(1);

    const builderPulse = await asBuilder.query(api.pulse.listMissionPulse, { missionId, limit: 50 });
    expect(builderPulse).toEqual([expect.objectContaining({ _id: workshopMove.eventId, roomId: workshopId })]);
    expect(await asBuilder.query(api.pulse.listMissionPulse, { missionId, roomId: workshopId })).toEqual([
      expect.objectContaining({ _id: workshopMove.eventId, roomTitle: "Workshop" }),
    ]);
    await expect(asBuilder.query(api.pulse.listMissionPulse, { missionId, roomId: restrictedId })).rejects.toThrow("Not found");
  });

  it("denies observer and cross-Mission probes while retaining authorized history after archive", async () => {
    const { t, asOwner, missionId, workshopId } = await setup();
    const asBuilder = await grant(t, missionId, "builder", "builder", [`room:${workshopId}`]);
    const asObserver = await grant(t, missionId, "observer", "observer", [`room:${workshopId}`]);
    const move = await asBuilder.mutation(api.moves.createMove, createMoveArgs(missionId, workshopId, "archive-workshop-move"));
    const otherMission = await asOwner.mutation(api.missions.createPrivateMission, {
      slug: "other-pulse-kernel",
      title: "Other pulse kernel",
      summary: "A separate Mission remains undiscoverable.",
      idempotencyKey: "other-pulse-mission",
      correlationId: "other-pulse-mission",
    });
    await expect(asBuilder.query(api.pulse.listMissionPulse, { missionId: otherMission.missionId })).rejects.toThrow("Not found");
    await expect(asObserver.query(api.pulse.listMissionPulse, { missionId })).rejects.toThrow("Not found");

    await asOwner.mutation(api.missions.archivePrivateMission, {
      missionId,
      expectedVersion: 1,
      idempotencyKey: "archive-pulse-mission",
      correlationId: "archive-pulse-mission",
    });
    const ownerHistory = await asOwner.query(api.pulse.listMissionPulse, { missionId });
    expect(ownerHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "mission.archived" }),
      expect.objectContaining({ _id: move.eventId, roomId: workshopId }),
    ]));
    expect(await asBuilder.query(api.pulse.listMissionPulse, { missionId })).toEqual([
      expect.objectContaining({ _id: move.eventId, roomId: workshopId }),
    ]);
  });
});
