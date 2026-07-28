import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
  "../../convex/fractures.ts": () => import("../../convex/fractures"),
};

const owner = { tokenIdentifier: "https://realworld.test|fracture-owner", subject: "fracture-owner", issuer: "https://realworld.test", name: "Fracture owner" };

function identity(name: string) {
  return { tokenIdentifier: `https://realworld.test|fracture-${name}`, subject: `fracture-${name}`, issuer: "https://realworld.test", name: `Fracture ${name}` };
}

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const mission = await asOwner.mutation(api.missions.createPrivateMission, {
    slug: "fracture-kernel",
    title: "Fracture kernel",
    summary: "Durable room-scoped recovery work.",
    idempotencyKey: "fracture-mission",
    correlationId: "fracture-mission",
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

function createArgs(
  missionId: Awaited<ReturnType<typeof setup>>["missionId"],
  roomId: Awaited<ReturnType<typeof setup>>["workshopId"],
  idempotencyKey: string,
  title = "Session restoration stalls",
) {
  return {
    missionId,
    roomId,
    title,
    detail: "The Workshop cannot restore an authenticated session after reconnect.",
    severity: "high" as const,
    idempotencyKey,
    correlationId: idempotencyKey,
  };
}

async function grant(
  t: Awaited<ReturnType<typeof setup>>["t"],
  missionId: Awaited<ReturnType<typeof setup>>["missionId"],
  name: string,
  role: "steward" | "builder" | "reviewer" | "contributor" | "observer",
  scope: string[],
  state: "active" | "revoked" | "expired" = "active",
  expiresAt?: number,
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
      state,
      scope,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      grantVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  });
  return t.withIdentity(member);
}

describe("Fracture kernel", () => {
  it("records an attributable room-scoped Fracture with a bounded projection and exact replay", async () => {
    const { t, asOwner, missionId, workshopId } = await setup();
    const firstArgs = createArgs(missionId, workshopId, "fracture-create");
    const first = await asOwner.mutation(api.fractures.createFracture, firstArgs);
    expect(await asOwner.mutation(api.fractures.createFracture, firstArgs)).toEqual(first);
    await expect(asOwner.mutation(api.fractures.createFracture, { ...firstArgs, title: "Changed payload" })).rejects.toThrow("Idempotency key reuse");
    await asOwner.mutation(api.fractures.createFracture, createArgs(missionId, workshopId, "fracture-create-second", "A second contained fracture"));

    const visible = await asOwner.query(api.fractures.listRoomFractures, { roomId: workshopId, limit: 1 });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ roomId: workshopId, severity: "high", status: "open" });
    await t.run(async (ctx) => {
      const fracture = await ctx.db.get(first.fractureId);
      expect(fracture).toMatchObject({ reporterPrincipalId: expect.any(String), roomId: workshopId, title: firstArgs.title, currentVersion: 1 });
      const events = await ctx.db.query("missionEvents")
        .withIndex("by_mission_and_sequence", (index) => index.eq("missionId", missionId))
        .collect();
      expect(events.map((event) => event.type)).toEqual(["mission.created", "fracture.created", "fracture.created"]);
      expect(events[1]).toMatchObject({ actorPrincipalId: fracture!.reporterPrincipalId, afterVersion: 1 });
    });
  });

  it("enforces scoped roles while allowing the reporter, owner, and steward to administer", async () => {
    const { asOwner, t, missionId, workshopId, restrictedId } = await setup();
    const asSteward = await grant(t, missionId, "steward", "steward", ["mission:*"]);
    const asBuilder = await grant(t, missionId, "builder", "builder", [`room:${workshopId}`]);
    const asContributor = await grant(t, missionId, "contributor", "contributor", [`room:${workshopId}`]);
    const asReviewer = await grant(t, missionId, "reviewer", "reviewer", [`room:${workshopId}`]);
    const asObserver = await grant(t, missionId, "observer", "observer", [`room:${workshopId}`]);
    const asScopedBuilder = await grant(t, missionId, "scoped-builder", "builder", [`room:${workshopId}`]);

    const ownerFracture = await asOwner.mutation(api.fractures.createFracture, createArgs(missionId, workshopId, "owner-fracture"));
    await expect(asBuilder.mutation(api.fractures.updateFracture, {
      fractureId: ownerFracture.fractureId,
      expectedVersion: 1,
      roomId: workshopId,
      linkedMoveId: null,
      title: "Builder probe",
      detail: "This must not become an edit path.",
      severity: "medium",
      idempotencyKey: "builder-update-owner",
      correlationId: "builder-update-owner",
    })).rejects.toThrow("Not found");

    const reported = await asContributor.mutation(api.fractures.createFracture, createArgs(missionId, workshopId, "contributor-fracture"));
    const reporterUpdate = await asContributor.mutation(api.fractures.updateFracture, {
      fractureId: reported.fractureId,
      expectedVersion: 1,
      roomId: workshopId,
      linkedMoveId: null,
      title: "Reporter clarified the fracture",
      detail: "The reporter can safely add the reproducible context.",
      severity: "critical",
      idempotencyKey: "reporter-update",
      correlationId: "reporter-update",
    });
    await expect(asSteward.mutation(api.fractures.transitionFracture, {
      fractureId: reported.fractureId,
      expectedVersion: reporterUpdate.currentVersion,
      nextStatus: "investigating",
      idempotencyKey: "steward-investigate",
      correlationId: "steward-investigate",
    })).resolves.toMatchObject({ currentVersion: 3 });

    expect(await asReviewer.query(api.fractures.listRoomFractures, { roomId: workshopId })).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: ownerFracture.fractureId }),
    ]));
    const ownerProjection = await asOwner.query(api.fractures.listMissionFractures, { missionId, limit: 10 });
    expect(ownerProjection.find((fracture) => fracture._id === reported.fractureId)).toMatchObject({
      reporterDisplayName: "Fracture contributor",
      canAdminister: true,
    });
    const reviewerProjection = await asReviewer.query(api.fractures.listMissionFractures, { missionId, limit: 10 });
    expect(reviewerProjection.find((fracture) => fracture._id === reported.fractureId)).toMatchObject({ canAdminister: false });
    await expect(asReviewer.mutation(api.fractures.createFracture, createArgs(missionId, workshopId, "reviewer-create"))).rejects.toThrow("Not found");
    await expect(asObserver.query(api.fractures.listRoomFractures, { roomId: workshopId })).rejects.toThrow("Not found");
    await expect(asObserver.query(api.fractures.listMissionFractures, { missionId })).rejects.toThrow("Not found");
    await expect(asObserver.mutation(api.fractures.createFracture, createArgs(missionId, workshopId, "observer-create"))).rejects.toThrow("Not found");
    await expect(asScopedBuilder.mutation(api.fractures.createFracture, createArgs(missionId, restrictedId, "restricted-probe"))).rejects.toThrow("Not found");
  });

  it("allows valid recovery and reopen transitions while rejecting stale and invalid lifecycle commands", async () => {
    const { asOwner, missionId, workshopId } = await setup();
    const created = await asOwner.mutation(api.fractures.createFracture, createArgs(missionId, workshopId, "lifecycle-create"));
    const investigating = await asOwner.mutation(api.fractures.transitionFracture, {
      fractureId: created.fractureId,
      expectedVersion: created.currentVersion,
      nextStatus: "investigating",
      idempotencyKey: "investigate",
      correlationId: "investigate",
    });
    await expect(asOwner.mutation(api.fractures.transitionFracture, {
      fractureId: created.fractureId,
      expectedVersion: created.currentVersion,
      nextStatus: "resolved",
      idempotencyKey: "stale-resolve",
      correlationId: "stale-resolve",
    })).rejects.toThrow("Fracture version conflict");
    const resolvedArgs = {
      fractureId: created.fractureId,
      expectedVersion: investigating.currentVersion,
      nextStatus: "resolved" as const,
      idempotencyKey: "resolve",
      correlationId: "resolve",
    };
    const resolved = await asOwner.mutation(api.fractures.transitionFracture, resolvedArgs);
    await expect(asOwner.mutation(api.fractures.updateFracture, {
      fractureId: created.fractureId,
      expectedVersion: resolved.currentVersion,
      roomId: workshopId,
      linkedMoveId: null,
      title: "Terminal rewrite",
      detail: "Terminal Fractures should remain stable until reopened.",
      severity: "low",
      idempotencyKey: "terminal-update",
      correlationId: "terminal-update",
    })).rejects.toThrow("Terminal Fractures cannot be updated");
    const reopened = await asOwner.mutation(api.fractures.transitionFracture, {
      fractureId: created.fractureId,
      expectedVersion: resolved.currentVersion,
      nextStatus: "open",
      idempotencyKey: "reopen",
      correlationId: "reopen",
    });
    await expect(asOwner.mutation(api.fractures.transitionFracture, {
      fractureId: created.fractureId,
      expectedVersion: reopened.currentVersion,
      nextStatus: "open",
      idempotencyKey: "invalid-open",
      correlationId: "invalid-open",
    })).rejects.toThrow("Invalid Fracture transition");
  });

  it("rejects cross-room links and fresh archived commands while preserving exact replay", async () => {
    const { asOwner, t, missionId, workshopId, restrictedId } = await setup();
    const workshopMove = await asOwner.mutation(api.moves.createMove, {
      missionId,
      roomId: workshopId,
      title: "Reproduce the session failure",
      intent: "Capture the failing restore sequence.",
      dependencyMoveIds: [],
      idempotencyKey: "workshop-move",
      correlationId: "workshop-move",
    });
    const restrictedMove = await asOwner.mutation(api.moves.createMove, {
      missionId,
      roomId: restrictedId,
      title: "Restricted move",
      intent: "This belongs to another room audience.",
      dependencyMoveIds: [],
      idempotencyKey: "restricted-move",
      correlationId: "restricted-move",
    });
    await expect(asOwner.mutation(api.fractures.createFracture, {
      ...createArgs(missionId, workshopId, "wrong-room-link"),
      linkedMoveId: restrictedMove.moveId,
    })).rejects.toThrow("Not found");
    const otherMission = await asOwner.mutation(api.missions.createPrivateMission, {
      slug: "other-fracture-kernel",
      title: "Other fracture kernel",
      summary: "A separate Mission must not supply linked Moves.",
      idempotencyKey: "other-fracture-mission",
      correlationId: "other-fracture-mission",
    });
    const otherMove = await asOwner.mutation(api.moves.createMove, {
      missionId: otherMission.missionId,
      title: "Other Mission move",
      intent: "This must remain outside the Fracture audience.",
      dependencyMoveIds: [],
      idempotencyKey: "other-fracture-move",
      correlationId: "other-fracture-move",
    });
    await expect(asOwner.mutation(api.fractures.createFracture, {
      ...createArgs(missionId, workshopId, "cross-mission-link"),
      linkedMoveId: otherMove.moveId,
    })).rejects.toThrow("Not found");
    const relocation = await asOwner.mutation(api.fractures.createFracture, {
      ...createArgs(missionId, workshopId, "relocation"),
      linkedMoveId: workshopMove.moveId,
    });
    await expect(asOwner.mutation(api.fractures.updateFracture, {
      fractureId: relocation.fractureId,
      expectedVersion: relocation.currentVersion,
      roomId: restrictedId,
      linkedMoveId: workshopMove.moveId,
      title: "Invalid relocation",
      detail: "A Move cannot be linked across room audiences.",
      severity: "high",
      idempotencyKey: "invalid-relocation",
      correlationId: "invalid-relocation",
    })).rejects.toThrow("Not found");
    const moved = await asOwner.mutation(api.fractures.updateFracture, {
      fractureId: relocation.fractureId,
      expectedVersion: relocation.currentVersion,
      roomId: restrictedId,
      linkedMoveId: restrictedMove.moveId,
      title: "Valid relocation",
      detail: "The target room and linked Move share one audience.",
      severity: "medium",
      idempotencyKey: "valid-relocation",
      correlationId: "valid-relocation",
    });
    expect(moved.currentVersion).toBe(2);
    expect(await asOwner.query(api.fractures.listRoomFractures, { roomId: workshopId })).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: relocation.fractureId }),
    ]));
    expect(await asOwner.query(api.fractures.listRoomFractures, { roomId: restrictedId })).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: relocation.fractureId, linkedMoveId: restrictedMove.moveId }),
    ]));
    await t.run(async (ctx) => ctx.db.patch(restrictedId, { state: "archived", currentVersion: 2, updatedAt: Date.now() }));
    await expect(asOwner.mutation(api.fractures.createFracture, createArgs(missionId, restrictedId, "archived-room"))).rejects.toThrow("Invalid Fracture room");

    const create = {
      ...createArgs(missionId, workshopId, "archive-replay"),
      linkedMoveId: workshopMove.moveId,
    };
    const fracture = await asOwner.mutation(api.fractures.createFracture, create);
    const update = {
      fractureId: fracture.fractureId,
      expectedVersion: fracture.currentVersion,
      roomId: workshopId,
      linkedMoveId: workshopMove.moveId,
      title: "Archive-safe update",
      detail: "This completed mutation must replay after archive.",
      severity: "medium" as const,
      idempotencyKey: "archive-update",
      correlationId: "archive-update",
    };
    const updated = await asOwner.mutation(api.fractures.updateFracture, update);
    expect(await asOwner.mutation(api.fractures.updateFracture, update)).toEqual(updated);
    await asOwner.mutation(api.missions.archivePrivateMission, {
      missionId,
      expectedVersion: 1,
      idempotencyKey: "archive-fracture-mission",
      correlationId: "archive-fracture-mission",
    });
    expect(await asOwner.mutation(api.fractures.updateFracture, update)).toEqual(updated);
    await expect(asOwner.mutation(api.fractures.transitionFracture, {
      fractureId: fracture.fractureId,
      expectedVersion: updated.currentVersion,
      nextStatus: "investigating",
      idempotencyKey: "fresh-after-archive",
      correlationId: "fresh-after-archive",
    })).rejects.toThrow("Mission is not active");
  });
});
