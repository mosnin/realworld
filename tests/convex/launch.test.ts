import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/profiles.ts": () => import("../../convex/profiles"),
  "../../convex/launch.ts": () => import("../../convex/launch"),
};

const identity = {
  tokenIdentifier: "https://realworld.test|blank-canvas-owner",
  subject: "blank-canvas-owner",
  issuer: "https://realworld.test",
  name: "Blank Canvas Owner",
};

const launchArgs = {
  templateKey: "blankCanvas",
  slug: "blank-canvas-mission",
  title: "Blank Canvas Mission",
  idempotencyKey: "blank-canvas-launch-001",
  correlationId: "blank-canvas-correlation-001",
} as const;

describe("blank Canvas Mission launch", () => {
  it("requires a completed profile, creates only Mission Core and Workshop with zero Moves, and exactly replays", async () => {
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(identity);

    await expect(asOwner.mutation(api.launch.createMissionFromTemplate, launchArgs))
      .rejects.toThrow("Set your callsign before you can launch a Mission");

    await asOwner.mutation(api.profiles.setMine, {
      displayName: "Canvas Owner",
      idempotencyKey: "blank-canvas-profile-001",
    });
    await expect(asOwner.mutation(api.launch.createMissionFromTemplate, {
      ...launchArgs,
      templateKey: "not-a-template" as never,
      slug: "invalid-template-key",
      idempotencyKey: "invalid-template-key-001",
      correlationId: "invalid-template-key-001",
    })).rejects.toThrow();
    const launched = await asOwner.mutation(api.launch.createMissionFromTemplate, launchArgs);
    expect(await asOwner.mutation(api.launch.createMissionFromTemplate, launchArgs)).toEqual(launched);
    await t.run(async (ctx) => {
      const principal = await ctx.db
        .query("principals")
        .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", identity.tokenIdentifier))
        .unique();
      await ctx.db.patch(principal!._id, { displayName: undefined, displayNameUpdatedAt: undefined });
    });
    expect(await asOwner.mutation(api.launch.createMissionFromTemplate, launchArgs)).toEqual(launched);
    await expect(asOwner.mutation(api.launch.createMissionFromTemplate, { ...launchArgs, templateKey: "companySprint" }))
      .rejects.toThrow("Idempotency key reuse with a different command");
    await expect(asOwner.mutation(api.launch.createMissionFromTemplate, { ...launchArgs, title: "Different Blank Canvas Mission" }))
      .rejects.toThrow("Idempotency key reuse with a different command");

    await t.run(async (ctx) => {
      const mission = await ctx.db.get(launched.missionId);
      const owner = await ctx.db.get(mission!.ownerPrincipalId);
      const rooms = await ctx.db
        .query("rooms")
        .withIndex("by_mission_and_state", (index) => index.eq("missionId", launched.missionId).eq("state", "active"))
        .collect();
      const moves = await ctx.db
        .query("moves")
        .withIndex("by_mission_and_state", (index) => index.eq("missionId", launched.missionId))
        .collect();
      const calls = await ctx.db
        .query("calls")
        .withIndex("by_mission", (index) => index.eq("missionId", launched.missionId))
        .collect();
      const fractures = await ctx.db
        .query("fractures")
        .withIndex("by_mission_and_status", (index) => index.eq("missionId", launched.missionId))
        .collect();
      const proofs = await ctx.db
        .query("proofs")
        .withIndex("by_mission_and_status", (index) => index.eq("missionId", launched.missionId))
        .collect();
      const membership = await ctx.db
        .query("missionMembers")
        .withIndex("by_mission_and_principal", (index) => index.eq("missionId", launched.missionId).eq("principalId", mission!.ownerPrincipalId))
        .unique();
      const events = await ctx.db
        .query("missionEvents")
        .withIndex("by_mission", (index) => index.eq("missionId", launched.missionId))
        .collect();
      const receipts = await ctx.db
        .query("operationReceipts")
        .withIndex("by_scope_and_idempotency_key", (index) => index
          .eq("scope", `principal:${identity.tokenIdentifier}:launchMission`)
          .eq("idempotencyKey", launchArgs.idempotencyKey))
        .collect();

      expect(mission).toMatchObject({ templateKey: "blankCanvas", lifecycle: "active", currentVersion: 1 });
      expect(rooms.map((room) => ({ kind: room.kind, title: room.title })).sort((left, right) => left.kind.localeCompare(right.kind))).toEqual([
        { kind: "missionCore", title: "Mission Core" },
        { kind: "workshop", title: "Workshop" },
      ]);
      expect(moves).toEqual([]);
      expect(calls).toEqual([]);
      expect(fractures).toEqual([]);
      expect(proofs).toEqual([]);
      expect(membership).toMatchObject({ principalId: mission!.ownerPrincipalId, role: "owner", state: "active", scope: ["mission:*"], grantVersion: 1 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "mission.created", actorPrincipalId: mission!.ownerPrincipalId, actorDisplayNameAtAction: "Canvas Owner", effectiveRole: "owner", idempotencyKey: launchArgs.idempotencyKey, correlationId: launchArgs.correlationId, afterVersion: 1 });
      expect(owner).toMatchObject({ tokenIdentifier: identity.tokenIdentifier, type: "human", state: "active" });
      expect(receipts).toEqual([expect.objectContaining({ missionId: launched.missionId, eventId: launched.eventId, resultVersion: 1 })]);
    });
  });
});
