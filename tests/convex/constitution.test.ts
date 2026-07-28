import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
};

const ownerIdentity = {
  tokenIdentifier: "https://realworld.test|constitution-owner",
  subject: "constitution-owner",
  issuer: "https://realworld.test",
};

async function createMission() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(ownerIdentity);
  const mission = await owner.mutation(api.missions.createPrivateMission, {
    slug: "constitution-test-mission",
    title: "Constitution test Mission",
    summary: "A Mission used to verify durable governing intent.",
    idempotencyKey: "constitution-create",
    correlationId: "constitution-create-correlation",
  });
  return { t, owner, mission };
}

describe("Mission Constitution", () => {
  it("updates governing intent once with OCC, event history, query projection, and replay", async () => {
    const { t, owner, mission } = await createMission();
    const args = {
      missionId: mission.missionId,
      constitution: "Make decisions from attributable evidence and preserve reversible paths.",
      desiredOutcomes: ["Ship a trustworthy shared workflow", "Keep every consequential action attributable"],
      expectedVersion: 1,
      idempotencyKey: "constitution-update",
      correlationId: "constitution-update-correlation",
    };

    const result = await owner.mutation(api.missions.updateConstitution, args);
    expect(result.currentVersion).toBe(2);
    await expect(owner.mutation(api.missions.updateConstitution, args)).resolves.toEqual(result);

    const listed = await owner.query(api.missions.listMyMissions, {});
    expect(listed[0]).toMatchObject({
      _id: mission.missionId,
      constitution: args.constitution,
      desiredOutcomes: args.desiredOutcomes,
      currentVersion: 2,
    });

    await t.run(async (ctx) => {
      const stored = await ctx.db.get(mission.missionId);
      expect(stored).toMatchObject({ currentVersion: 2 });
      expect(stored?.eventSequence).toBeUndefined();
      const events = await ctx.db
        .query("missionEvents")
        .withIndex("by_mission", (query) => query.eq("missionId", mission.missionId))
        .collect();
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        type: "mission.constitutionUpdated",
        beforeVersion: 1,
        afterVersion: 2,
        idempotencyKey: args.idempotencyKey,
        correlationId: args.correlationId,
      });
    });
  });

  it("rejects invalid, stale, non-owner, and archived writes while replay remains safe", async () => {
    const { t, owner, mission } = await createMission();
    const valid = {
      missionId: mission.missionId,
      constitution: "Work in public inside the Mission and verify every completed outcome.",
      desiredOutcomes: ["Complete one durable outcome"],
      expectedVersion: 1,
      idempotencyKey: "constitution-valid",
      correlationId: "constitution-valid-correlation",
    };

    await expect(owner.mutation(api.missions.updateConstitution, { ...valid, desiredOutcomes: [] })).rejects.toThrow("Invalid desired outcomes");
    await expect(owner.mutation(api.missions.updateConstitution, { ...valid, desiredOutcomes: ["Same", " same "] })).rejects.toThrow("Duplicate desired outcome");
    const first = await owner.mutation(api.missions.updateConstitution, valid);
    await expect(owner.mutation(api.missions.updateConstitution, { ...valid, idempotencyKey: "constitution-stale" })).rejects.toThrow("Mission version conflict");

    const outsider = t.withIdentity({ tokenIdentifier: "https://realworld.test|constitution-outsider", subject: "outsider", issuer: "https://realworld.test" });
    await expect(outsider.mutation(api.missions.updateConstitution, { ...valid, expectedVersion: 2, idempotencyKey: "constitution-outsider" })).rejects.toThrow();

    await owner.mutation(api.missions.archivePrivateMission, {
      missionId: mission.missionId,
      expectedVersion: 2,
      idempotencyKey: "constitution-archive",
      correlationId: "constitution-archive-correlation",
    });
    await expect(owner.mutation(api.missions.updateConstitution, { ...valid, expectedVersion: 3, idempotencyKey: "constitution-archived" })).rejects.toThrow("Mission is not active");
    await expect(owner.mutation(api.missions.updateConstitution, valid)).resolves.toEqual(first);
  });
});
