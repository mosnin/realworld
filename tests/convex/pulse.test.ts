import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/profiles.ts": () => import("../../convex/profiles"),
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
  await asOwner.mutation(api.profiles.setMine, { displayName: "Pulse Owner", idempotencyKey: "pulse-owner-profile" });
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
      const principal = await ctx.db.query("principals")
        .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", owner.tokenIdentifier))
        .unique();
      if (!principal) throw new Error("Test setup failed");
      return await ctx.db.insert("missionEvents", {
        missionId,
        missionSequence: 1,
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
    const repeatedOwnerPulse = await asOwner.query(api.pulse.listMissionPulse, { missionId, limit: 50 });
    expect(ownerPulse.map((entry) => entry._id)).toEqual(repeatedOwnerPulse.map((entry) => entry._id));
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

  it("keeps concurrent aggregate writes off the Mission counter and orders tied timestamps stably", async () => {
    const { t, asOwner, missionId, workshopId } = await setup();
    const before = await t.run(async (ctx) => ctx.db.get(missionId));
    const inputs = Array.from({ length: 50 }, (_, index) => createMoveArgs(missionId, workshopId, `parallel-move-${index}`));
    const created = await Promise.all(inputs.map((args) => asOwner.mutation(api.moves.createMove, args)));
    expect(await asOwner.mutation(api.moves.createMove, inputs[0]!)).toEqual(created[0]);

    const [firstTie, secondTie] = await t.run(async (ctx) => {
      const principal = await ctx.db.query("principals")
        .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", owner.tokenIdentifier))
        .unique();
      if (!principal) throw new Error("Test setup failed");
      const createdAt = 1_700_000_000_000;
      const common = {
        missionId,
        roomId: workshopId,
        type: "move.created" as const,
        aggregateType: "mission" as const,
        aggregateId: missionId,
        actorPrincipalId: principal._id,
        effectiveRole: "owner" as const,
        afterVersion: 1,
        createdAt,
        schemaVersion: 1,
      };
      return await Promise.all([
        ctx.db.insert("missionEvents", { ...common, correlationId: "tied-pulse-a", idempotencyKey: "tied-pulse-a", publicSummary: "Tied event A" }),
        ctx.db.insert("missionEvents", { ...common, correlationId: "tied-pulse-b", idempotencyKey: "tied-pulse-b", publicSummary: "Tied event B" }),
      ]);
    });

    await t.run(async (ctx) => {
      const mission = await ctx.db.get(missionId);
      const events = await ctx.db.query("missionEvents")
        .withIndex("by_mission", (index) => index.eq("missionId", missionId))
        .collect();
      expect(mission?.eventSequence).toBe(before?.eventSequence);
      expect(events.filter((event) => created.some((result) => result.eventId === event._id))).toHaveLength(created.length);
      expect(events.filter((event) => created.some((result) => result.eventId === event._id)).every((event) => event.missionSequence === undefined)).toBe(true);
      expect(events.filter((event) => event._id === created[0]!.eventId)).toHaveLength(1);
    });

    const pulse = await asOwner.query(api.pulse.listMissionPulse, { missionId, limit: 50 });
    const repeatedPulse = await asOwner.query(api.pulse.listMissionPulse, { missionId, limit: 50 });
    const ids = pulse.map((entry) => entry._id);
    expect(ids).toEqual(repeatedPulse.map((entry) => entry._id));
    expect(ids.indexOf(secondTie)).toBeLessThan(ids.indexOf(firstTie));
    expect(pulse).toHaveLength(50);
    expect(pulse.every((entry) => entry.roomId === workshopId)).toBe(true);
  });

  it("keeps action-time callsigns immutable and renders legacy rows without mutable-principal joins", async () => {
    const { t, asOwner, missionId, workshopId } = await setup();
    const builder = identity("builder");
    const asBuilder = await grant(t, missionId, "builder", "builder", [`room:${workshopId}`]);
    const firstArgs = createMoveArgs(missionId, workshopId, "callsign-before-rename");
    const first = await asBuilder.mutation(api.moves.createMove, firstArgs);

    await t.run(async (ctx) => {
      const principal = await ctx.db.query("principals")
        .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", builder.tokenIdentifier))
        .unique();
      if (!principal) throw new Error("Test setup failed");
      await ctx.db.patch(principal._id, {
        displayName: "Renamed Builder",
        displayNameUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    // Exact replay returns the original durable action rather than recapturing
    // the current profile name.
    expect(await asBuilder.mutation(api.moves.createMove, firstArgs)).toEqual(first);
    const second = await asBuilder.mutation(api.moves.createMove, createMoveArgs(missionId, workshopId, "callsign-after-rename"));
    const [legacyCurrentActorEventId, legacyMissingActorEventId] = await t.run(async (ctx) => {
      const now = Date.now();
      const builderPrincipal = await ctx.db.query("principals")
        .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", builder.tokenIdentifier))
        .unique();
      if (!builderPrincipal) throw new Error("Test setup failed");
      const legacyCurrentActorEventId = await ctx.db.insert("missionEvents", {
        missionId,
        roomId: workshopId,
        type: "move.created",
        aggregateType: "mission",
        aggregateId: missionId,
        actorPrincipalId: builderPrincipal._id,
        effectiveRole: "builder",
        correlationId: "legacy-current-actor",
        idempotencyKey: "legacy-current-actor",
        publicSummary: "Legacy event must not read the renamed principal",
        afterVersion: 1,
        createdAt: now,
        schemaVersion: 1,
      });
      const missingPrincipalId = await ctx.db.insert("principals", {
        type: "human",
        state: "active",
        displayName: "Mutable legacy name",
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      const eventId = await ctx.db.insert("missionEvents", {
        missionId,
        type: "mission.updated",
        aggregateType: "mission",
        aggregateId: missionId,
        actorPrincipalId: missingPrincipalId,
        effectiveRole: "owner",
        correlationId: "legacy-missing-actor",
        idempotencyKey: "legacy-missing-actor",
        publicSummary: "Legacy event stays attributable only by role",
        afterVersion: 1,
        createdAt: now,
        schemaVersion: 1,
      });
      await ctx.db.delete(missingPrincipalId);
      return [legacyCurrentActorEventId, eventId];
    });

    const pulse = await asOwner.query(api.pulse.listMissionPulse, { missionId, limit: 50 });
    expect(pulse.find((entry) => entry._id === first.eventId)).toMatchObject({
      actorDisplayName: "Pulse builder",
      actorType: "human",
    });
    expect(pulse.find((entry) => entry._id === second.eventId)).toMatchObject({
      actorDisplayName: "Renamed Builder",
      actorType: "human",
    });
    expect(pulse.find((entry) => entry._id === legacyCurrentActorEventId)).toMatchObject({
      actorDisplayName: "builder collaborator",
      actorType: "human",
    });
    expect(pulse.find((entry) => entry._id === legacyMissingActorEventId)).toMatchObject({
      actorDisplayName: "owner collaborator",
      actorType: "human",
    });
    await t.run(async (ctx) => {
      const [firstEvent, secondEvent] = await Promise.all([
        ctx.db.get(first.eventId),
        ctx.db.get(second.eventId),
      ]);
      expect(firstEvent).toMatchObject({ actorDisplayNameAtAction: "Pulse builder", actorTypeAtAction: "human" });
      expect(secondEvent).toMatchObject({ actorDisplayNameAtAction: "Renamed Builder", actorTypeAtAction: "human" });
    });
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
