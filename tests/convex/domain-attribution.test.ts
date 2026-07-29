import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/proofs.ts": () => import("../../convex/proofs"),
  "../../convex/fractures.ts": () => import("../../convex/fractures"),
  "../../convex/calls.ts": () => import("../../convex/calls"),
};

function identity(name: string) {
  return {
    tokenIdentifier: `https://realworld.test|attribution-${name}`,
    subject: `attribution-${name}`,
    issuer: "https://realworld.test",
    name: `Attribution ${name}`,
  };
}

const owner = identity("owner");
const proofBuilder = identity("proof-builder");
const reviewer = identity("reviewer");
const fractureReporter = identity("fracture-reporter");
const callParticipant = identity("call-participant");
type Test = TestConvex<typeof schema>;

async function setDisplayName(t: Test, tokenIdentifier: string, displayName: string) {
  await t.run(async (ctx) => {
    const principal = await ctx.db.query("principals")
      .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", tokenIdentifier))
      .unique();
    if (!principal) throw new Error("Test setup failed");
    await ctx.db.patch(principal._id, { displayName, displayNameUpdatedAt: Date.now(), updatedAt: Date.now() });
  });
}

async function grant(
  t: Test,
  missionId: Id<"missions">,
  person: ReturnType<typeof identity>,
  role: "builder" | "reviewer" | "contributor",
  displayName: string,
  roomId: Id<"rooms">,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const principalId = await ctx.db.insert("principals", {
      type: "human",
      state: "active",
      tokenIdentifier: person.tokenIdentifier,
      displayName,
      displayNameUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
    await ctx.db.insert("missionMembers", {
      missionId,
      principalId,
      role,
      state: "active",
      scope: [`room:${roomId}`],
      grantVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  });
  return t.withIdentity(person);
}

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const mission = await asOwner.mutation(api.missions.createPrivateMission, {
    slug: "domain-attribution",
    title: "Domain attribution",
    summary: "Immutable entity attribution.",
    idempotencyKey: "domain-attribution-mission",
    correlationId: "domain-attribution-mission",
  });
  await setDisplayName(t, owner.tokenIdentifier, "Old Owner");
  const roomId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("rooms", {
      missionId: mission.missionId,
      kind: "workshop",
      title: "Workshop",
      accessPolicy: "mission",
      mapType: "field",
      layout: { x: 0, y: 0, width: 240, height: 140 },
      layoutVersion: 1,
      state: "active",
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  });
  return { t, asOwner, missionId: mission.missionId, roomId };
}

describe("domain action-time attribution", () => {
  it("keeps Proof, Fracture, and Call history stable across rename, replay, and legacy rows", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const asProofBuilder = await grant(t, missionId, proofBuilder, "builder", "Old Proof Builder", roomId);
    const asReviewer = await grant(t, missionId, reviewer, "reviewer", "Old Reviewer", roomId);
    const asReporter = await grant(t, missionId, fractureReporter, "builder", "Old Reporter", roomId);
    const asParticipant = await grant(t, missionId, callParticipant, "contributor", "Old Participant", roomId);

    const proofArgs = {
      missionId,
      roomId,
      title: "First immutable Proof",
      claim: "The first callsign must persist.",
      evidenceNote: "Action-time fields capture presentation identity.",
      idempotencyKey: "proof-old",
      correlationId: "proof-old",
    };
    const firstProof = await asProofBuilder.mutation(api.proofs.createProof, proofArgs);
    await setDisplayName(t, proofBuilder.tokenIdentifier, "New Proof Builder");
    expect(await asProofBuilder.mutation(api.proofs.createProof, proofArgs)).toEqual(firstProof);
    const secondProof = await asProofBuilder.mutation(api.proofs.createProof, {
      ...proofArgs,
      title: "Second immutable Proof",
      idempotencyKey: "proof-new",
      correlationId: "proof-new",
    });
    await asReviewer.mutation(api.proofs.transitionProof, {
      proofId: firstProof.proofId,
      expectedVersion: firstProof.currentVersion,
      nextStatus: "verified",
      idempotencyKey: "proof-old-verified",
      correlationId: "proof-old-verified",
    });
    await setDisplayName(t, reviewer.tokenIdentifier, "New Reviewer");
    await asReviewer.mutation(api.proofs.transitionProof, {
      proofId: secondProof.proofId,
      expectedVersion: secondProof.currentVersion,
      nextStatus: "verified",
      idempotencyKey: "proof-new-verified",
      correlationId: "proof-new-verified",
    });
    const proofs = await asOwner.query(api.proofs.listMissionProofs, { missionId });
    expect(proofs.find((proof) => proof._id === firstProof.proofId)).toMatchObject({
      submitterDisplayName: "Old Proof Builder",
      verifierDisplayName: "Old Reviewer",
    });
    expect(proofs.find((proof) => proof._id === secondProof.proofId)).toMatchObject({
      submitterDisplayName: "New Proof Builder",
      verifierDisplayName: "New Reviewer",
    });

    const fractureArgs = {
      missionId,
      roomId,
      title: "First immutable Fracture",
      detail: "The first reporter snapshot persists.",
      severity: "medium" as const,
      idempotencyKey: "fracture-old",
      correlationId: "fracture-old",
    };
    const firstFracture = await asReporter.mutation(api.fractures.createFracture, fractureArgs);
    await setDisplayName(t, fractureReporter.tokenIdentifier, "New Reporter");
    expect(await asReporter.mutation(api.fractures.createFracture, fractureArgs)).toEqual(firstFracture);
    const secondFracture = await asReporter.mutation(api.fractures.createFracture, {
      ...fractureArgs,
      title: "Second immutable Fracture",
      idempotencyKey: "fracture-new",
      correlationId: "fracture-new",
    });
    const fractures = await asOwner.query(api.fractures.listMissionFractures, { missionId });
    expect(fractures.find((fracture) => fracture._id === firstFracture.fractureId)).toMatchObject({ reporterDisplayName: "Old Reporter" });
    expect(fractures.find((fracture) => fracture._id === secondFracture.fractureId)).toMatchObject({ reporterDisplayName: "New Reporter" });

    const callArgs = {
      missionId,
      roomId,
      title: "Immutable Call",
      detail: "Call history must retain action-time labels.",
      maxParticipants: 3,
      idempotencyKey: "call-old-owner",
      correlationId: "call-old-owner",
    };
    const call = await asOwner.mutation(api.calls.createCall, callArgs);
    await setDisplayName(t, owner.tokenIdentifier, "New Owner");
    expect(await asOwner.mutation(api.calls.createCall, callArgs)).toEqual(call);
    const join = await asParticipant.mutation(api.calls.joinCall, {
      callId: call.callId,
      idempotencyKey: "call-old-participant-join",
      correlationId: "call-old-participant-join",
    });
    const firstResponseArgs = {
      callId: call.callId,
      expectedParticipantVersion: join.currentVersion,
      response: "My old callsign belongs to this response.",
      idempotencyKey: "call-old-participant-response",
      correlationId: "call-old-participant-response",
    };
    const firstResponse = await asParticipant.mutation(api.calls.respondToCall, firstResponseArgs);
    await setDisplayName(t, callParticipant.tokenIdentifier, "New Participant");
    expect(await asParticipant.mutation(api.calls.respondToCall, firstResponseArgs)).toEqual(firstResponse);
    await asParticipant.mutation(api.calls.respondToCall, {
      callId: call.callId,
      expectedParticipantVersion: firstResponse.currentVersion,
      response: "My new callsign belongs to this later response.",
      idempotencyKey: "call-new-participant-response",
      correlationId: "call-new-participant-response",
    });
    expect((await asOwner.query(api.calls.listMissionCalls, { missionId })).find((candidate) => candidate._id === call.callId))
      .toMatchObject({ creatorDisplayName: "Old Owner" });
    expect(await asOwner.query(api.calls.listCallParticipants, { callId: call.callId })).toEqual([
      expect.objectContaining({ displayName: "Old Participant", role: "contributor" }),
    ]);
    expect(await asOwner.query(api.calls.listCallResponseHistory, { callId: call.callId })).toEqual([
      expect.objectContaining({ displayName: "New Participant", role: "contributor", revision: 2 }),
      expect.objectContaining({ displayName: "Old Participant", role: "contributor", revision: 1 }),
    ]);

    const rejectedProof = await asProofBuilder.mutation(api.proofs.createProof, {
      ...proofArgs,
      title: "Verifier snapshots clear on resubmission",
      idempotencyKey: "proof-rejected",
      correlationId: "proof-rejected",
    });
    const rejected = await asReviewer.mutation(api.proofs.transitionProof, {
      proofId: rejectedProof.proofId,
      expectedVersion: rejectedProof.currentVersion,
      nextStatus: "rejected",
      idempotencyKey: "proof-rejected-transition",
      correlationId: "proof-rejected-transition",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(rejectedProof.proofId, {
        verifierPrincipalId: (await ctx.db.query("principals")
          .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", reviewer.tokenIdentifier))
          .unique())!._id,
        verifierDisplayNameAtAction: "Stale verifier",
        verifierTypeAtAction: "human",
        verifierRoleAtAction: "reviewer",
      });
    });
    await asProofBuilder.mutation(api.proofs.transitionProof, {
      proofId: rejectedProof.proofId,
      expectedVersion: rejected.currentVersion,
      nextStatus: "submitted",
      idempotencyKey: "proof-resubmitted",
      correlationId: "proof-resubmitted",
    });
    await t.run(async (ctx) => {
      const proof = await ctx.db.get(rejectedProof.proofId);
      expect(proof).not.toHaveProperty("verifierPrincipalId");
      expect(proof).not.toHaveProperty("verifierDisplayNameAtAction");
      expect(proof).not.toHaveProperty("verifierTypeAtAction");
      expect(proof).not.toHaveProperty("verifierRoleAtAction");
    });

    const legacyIds = await t.run(async (ctx) => {
      const now = Date.now();
      const missingPrincipalId = await ctx.db.insert("principals", {
        type: "human",
        state: "disabled",
        displayName: "Never project this legacy name",
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      const legacyProofId = await ctx.db.insert("proofs", {
        missionId,
        roomId,
        submitterPrincipalId: missingPrincipalId,
        title: "Legacy Proof",
        claim: "No mutable name fallback.",
        evidenceNote: "Legacy row.",
        status: "submitted",
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      const legacyFractureId = await ctx.db.insert("fractures", {
        missionId,
        roomId,
        reporterPrincipalId: missingPrincipalId,
        title: "Legacy Fracture",
        detail: "No mutable name fallback.",
        severity: "low",
        status: "open",
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      const legacyParticipantId = await ctx.db.insert("callParticipants", {
        callId: call.callId,
        missionId,
        principalId: missingPrincipalId,
        state: "joined",
        currentVersion: 1,
        joinedAt: now,
        updatedAt: now,
        joinEventId: call.eventId,
        schemaVersion: 1,
      });
      const legacyRevisionId = await ctx.db.insert("callResponseRevisions", {
        callId: call.callId,
        missionId,
        participantId: legacyParticipantId,
        principalId: missingPrincipalId,
        revision: 99,
        response: "Legacy response retains generic attribution.",
        eventId: call.eventId,
        createdAt: now,
        schemaVersion: 1,
      });
      const legacyCallId = await ctx.db.insert("calls", {
        missionId,
        roomId,
        creatorPrincipalId: missingPrincipalId,
        title: "Legacy Call",
        detail: "No mutable creator fallback.",
        maxParticipants: 1,
        joinedCount: 0,
        status: "open",
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      await ctx.db.delete(missingPrincipalId);
      return { legacyProofId, legacyFractureId, legacyParticipantId, legacyRevisionId, legacyCallId };
    });
    expect((await asOwner.query(api.proofs.listMissionProofs, { missionId })).find((proof) => proof._id === legacyIds.legacyProofId))
      .toMatchObject({ submitterDisplayName: "collaborator" });
    expect((await asOwner.query(api.fractures.listMissionFractures, { missionId })).find((fracture) => fracture._id === legacyIds.legacyFractureId))
      .toMatchObject({ reporterDisplayName: "collaborator" });
    expect((await asOwner.query(api.calls.listCallParticipants, { callId: call.callId })).find((participant) => participant._id === legacyIds.legacyParticipantId))
      .toMatchObject({ displayName: "collaborator" });
    expect((await asOwner.query(api.calls.listCallResponseHistory, { callId: call.callId })).find((revision) => revision._id === legacyIds.legacyRevisionId))
      .toMatchObject({ displayName: "collaborator" });
    const legacyCall = (await asOwner.query(api.calls.listMissionCalls, { missionId })).find((candidate) => candidate._id === legacyIds.legacyCallId);
    expect(legacyCall).toMatchObject({ creatorDisplayName: "collaborator" });
    expect(legacyCall).not.toHaveProperty("creatorPrincipalId");
  });
});
