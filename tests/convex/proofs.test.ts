import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
  "../../convex/proofs.ts": () => import("../../convex/proofs"),
};

const owner = { tokenIdentifier: "https://realworld.test|proof-owner", subject: "proof-owner", issuer: "https://realworld.test", name: "Proof owner" };

function identity(name: string) {
  return { tokenIdentifier: `https://realworld.test|proof-${name}`, subject: `proof-${name}`, issuer: "https://realworld.test", name: `Proof ${name}` };
}

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const mission = await asOwner.mutation(api.missions.createPrivateMission, {
    slug: "proof-kernel",
    title: "Proof kernel",
    summary: "Durable verified milestones.",
    idempotencyKey: "proof-mission",
    correlationId: "proof-mission",
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
) {
  return {
    missionId,
    roomId,
    title: "Authorization restoration is verified",
    claim: "A signed-in contributor regains the scoped Workshop after reconnecting.",
    evidenceNote: "The authenticated browser journey verifies the restored room projection after reload.",
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

describe("Proof kernel", () => {
  it("creates a bounded, privacy-safe room Proof with exact replay and authoritative event history", async () => {
    const { t, asOwner, missionId, workshopId } = await setup();
    const args = createArgs(missionId, workshopId, "proof-create");
    const created = await asOwner.mutation(api.proofs.createProof, args);
    expect(await asOwner.mutation(api.proofs.createProof, args)).toEqual(created);
    await expect(asOwner.mutation(api.proofs.createProof, { ...args, claim: "Changed payload" })).rejects.toThrow("Idempotency key reuse");
    await asOwner.mutation(api.proofs.createProof, { ...createArgs(missionId, workshopId, "proof-second"), title: "Second Proof" });

    const visible = await asOwner.query(api.proofs.listMissionProofs, { missionId, limit: 1 });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ roomId: workshopId, status: "submitted", canEdit: true, canReview: true, canResubmit: false });
    expect(visible[0]).not.toHaveProperty("submitterPrincipalId");
    expect(visible[0]).not.toHaveProperty("verifierPrincipalId");
    await t.run(async (ctx) => {
      const proof = await ctx.db.get(created.proofId);
      expect(proof).toMatchObject({ roomId: workshopId, status: "submitted", submitterPrincipalId: expect.any(String), currentVersion: 1 });
      const events = await ctx.db.query("missionEvents")
        .withIndex("by_mission", (index) => index.eq("missionId", missionId))
        .collect();
      expect(events.map((event) => event.type)).toEqual(["mission.created", "proof.submitted", "proof.submitted"]);
      expect(events[1]).toMatchObject({ actorPrincipalId: proof!.submitterPrincipalId, afterVersion: 1 });
    });
  });

  it("separates submitter editing from reviewer verification and records verifier attribution", async () => {
    const { t, asOwner, missionId, workshopId, restrictedId } = await setup();
    const asBuilder = await grant(t, missionId, "builder", "builder", [`room:${workshopId}`]);
    const asReviewer = await grant(t, missionId, "reviewer", "reviewer", [`room:${workshopId}`]);
    const asObserver = await grant(t, missionId, "observer", "observer", [`room:${workshopId}`]);
    const hiddenProof = await asOwner.mutation(api.proofs.createProof, createArgs(missionId, restrictedId, "hidden-proof"));
    const submitted = await asBuilder.mutation(api.proofs.createProof, createArgs(missionId, workshopId, "builder-submit"));

    const builderView = await asBuilder.query(api.proofs.listMissionProofs, { missionId });
    expect(builderView.find((proof) => proof._id === submitted.proofId)).toMatchObject({ submitterDisplayName: "Proof builder", canEdit: true, canReview: false, canResubmit: false });
    const reviewerView = await asReviewer.query(api.proofs.listMissionProofs, { missionId });
    expect(reviewerView.find((proof) => proof._id === submitted.proofId)).toMatchObject({ canEdit: false, canReview: true });
    await expect(asObserver.query(api.proofs.listMissionProofs, { missionId })).rejects.toThrow("Not found");
    await expect(asObserver.mutation(api.proofs.createProof, createArgs(missionId, workshopId, "observer-submit"))).rejects.toThrow("Not found");
    await expect(asBuilder.query(api.proofs.listRoomProofs, { roomId: restrictedId })).rejects.toThrow("Not found");
    await expect(asBuilder.mutation(api.proofs.createProof, createArgs(missionId, restrictedId, "builder-hidden-probe"))).rejects.toThrow("Not found");
    await expect(asReviewer.mutation(api.proofs.createProof, createArgs(missionId, workshopId, "reviewer-submit"))).rejects.toThrow("Not found");
    await expect(asReviewer.mutation(api.proofs.transitionProof, {
      proofId: hiddenProof.proofId,
      expectedVersion: hiddenProof.currentVersion,
      nextStatus: "verified",
      idempotencyKey: "hidden-reviewer-verify",
      correlationId: "hidden-reviewer-verify",
    })).rejects.toThrow("Not found");

    const verifyArgs = {
      proofId: submitted.proofId,
      expectedVersion: submitted.currentVersion,
      nextStatus: "verified",
      idempotencyKey: "reviewer-verify",
      correlationId: "reviewer-verify",
    } as const;
    const verified = await asReviewer.mutation(api.proofs.transitionProof, verifyArgs);
    expect(await asReviewer.mutation(api.proofs.transitionProof, verifyArgs)).toEqual(verified);
    await expect(asBuilder.mutation(api.proofs.updateProof, {
      proofId: submitted.proofId,
      expectedVersion: verified.currentVersion,
      roomId: workshopId,
      linkedMoveId: null,
      title: "Verified rewrite",
      claim: "A verified Proof must remain immutable.",
      evidenceNote: "No rewrite should pass.",
      idempotencyKey: "builder-verified-edit",
      correlationId: "builder-verified-edit",
    })).rejects.toThrow("Verified Proofs cannot be updated");
    const verifiedView = await asOwner.query(api.proofs.listMissionProofs, { missionId });
    expect(verifiedView.find((proof) => proof._id === submitted.proofId)).toMatchObject({
      status: "verified",
      verifierDisplayName: "Proof reviewer",
      verifiedAt: expect.any(Number),
      canEdit: false,
      canReview: false,
    });

    const retry = await asBuilder.mutation(api.proofs.createProof, createArgs(missionId, workshopId, "builder-retry"));
    const rejected = await asReviewer.mutation(api.proofs.transitionProof, {
      proofId: retry.proofId,
      expectedVersion: retry.currentVersion,
      nextStatus: "rejected",
      idempotencyKey: "reviewer-reject",
      correlationId: "reviewer-reject",
    });
    const rejectedView = await asBuilder.query(api.proofs.listMissionProofs, { missionId });
    expect(rejectedView.find((proof) => proof._id === retry.proofId)).not.toHaveProperty("verifierDisplayName");
    expect(rejectedView.find((proof) => proof._id === retry.proofId)).not.toHaveProperty("verifiedAt");
    const resubmitted = await asBuilder.mutation(api.proofs.transitionProof, {
      proofId: retry.proofId,
      expectedVersion: rejected.currentVersion,
      nextStatus: "submitted",
      idempotencyKey: "builder-resubmit",
      correlationId: "builder-resubmit",
    });
    expect(resubmitted.currentVersion).toBe(3);
    const retriedView = await asBuilder.query(api.proofs.listMissionProofs, { missionId });
    expect(retriedView.find((proof) => proof._id === retry.proofId)).toMatchObject({ status: "submitted", canResubmit: false });
    expect(retriedView.find((proof) => proof._id === retry.proofId)).not.toHaveProperty("verifierDisplayName");
    expect(retriedView.find((proof) => proof._id === retry.proofId)).not.toHaveProperty("verifiedAt");
  });

  it("blocks stale, hidden-room, cross-Mission, and archived mutations while completed commands replay", async () => {
    const { t, asOwner, missionId, workshopId, restrictedId } = await setup();
    const workshopMove = await asOwner.mutation(api.moves.createMove, {
      missionId,
      roomId: workshopId,
      title: "Exercise the reconnect path",
      intent: "Record the session restoration path.",
      dependencyMoveIds: [],
      idempotencyKey: "proof-workshop-move",
      correlationId: "proof-workshop-move",
    });
    const restrictedMove = await asOwner.mutation(api.moves.createMove, {
      missionId,
      roomId: restrictedId,
      title: "Restricted evidence",
      intent: "This Move must not cross audiences.",
      dependencyMoveIds: [],
      idempotencyKey: "proof-restricted-move",
      correlationId: "proof-restricted-move",
    });
    await expect(asOwner.mutation(api.proofs.createProof, { ...createArgs(missionId, workshopId, "wrong-room-link"), linkedMoveId: restrictedMove.moveId })).rejects.toThrow("Not found");
    const otherMission = await asOwner.mutation(api.missions.createPrivateMission, {
      slug: "other-proof-kernel",
      title: "Other proof kernel",
      summary: "Cross-Mission links are not allowed.",
      idempotencyKey: "other-proof-mission",
      correlationId: "other-proof-mission",
    });
    const otherMove = await asOwner.mutation(api.moves.createMove, {
      missionId: otherMission.missionId,
      title: "Other Mission Move",
      intent: "This must remain outside the current Mission.",
      dependencyMoveIds: [],
      idempotencyKey: "other-proof-move",
      correlationId: "other-proof-move",
    });
    await expect(asOwner.mutation(api.proofs.createProof, { ...createArgs(missionId, workshopId, "cross-mission-link"), linkedMoveId: otherMove.moveId })).rejects.toThrow("Not found");

    const created = await asOwner.mutation(api.proofs.createProof, { ...createArgs(missionId, workshopId, "proof-update"), linkedMoveId: workshopMove.moveId });
    const update = {
      proofId: created.proofId,
      expectedVersion: created.currentVersion,
      roomId: workshopId,
      linkedMoveId: workshopMove.moveId,
      title: "Archive replay proof",
      claim: "The completed update can safely replay after archive.",
      evidenceNote: "Receipt is principal-bound and exact.",
      idempotencyKey: "proof-update",
      correlationId: "proof-update",
    };
    const updated = await asOwner.mutation(api.proofs.updateProof, update);
    await expect(asOwner.mutation(api.proofs.updateProof, { ...update, idempotencyKey: "stale-proof-update", expectedVersion: created.currentVersion })).rejects.toThrow("Proof version conflict");
    expect(await asOwner.mutation(api.proofs.updateProof, update)).toEqual(updated);
    await t.run(async (ctx) => ctx.db.patch(restrictedId, { state: "archived", currentVersion: 2, updatedAt: Date.now() }));
    await expect(asOwner.mutation(api.proofs.createProof, createArgs(missionId, restrictedId, "archived-room"))).rejects.toThrow("Invalid Proof room");
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId, expectedVersion: 1, idempotencyKey: "archive-proof-mission", correlationId: "archive-proof-mission" });
    expect(await asOwner.mutation(api.proofs.updateProof, update)).toEqual(updated);
    await expect(asOwner.mutation(api.proofs.transitionProof, {
      proofId: created.proofId,
      expectedVersion: updated.currentVersion,
      nextStatus: "verified",
      idempotencyKey: "fresh-after-archive",
      correlationId: "fresh-after-archive",
    })).rejects.toThrow("Mission is not active");
  });
});
