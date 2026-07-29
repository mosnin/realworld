import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/profiles.ts": () => import("../../convex/profiles"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
  "../../convex/calls.ts": () => import("../../convex/calls"),
  "../../convex/canvas.ts": () => import("../../convex/canvas"),
};

const owner = { tokenIdentifier: "https://realworld.test|participant-owner", subject: "participant-owner", issuer: "https://realworld.test", name: "Participant owner" };
const builder = { tokenIdentifier: "https://realworld.test|participant-builder", subject: "participant-builder", issuer: "https://realworld.test", name: "Participant builder" };
const reviewer = { tokenIdentifier: "https://realworld.test|participant-reviewer", subject: "participant-reviewer", issuer: "https://realworld.test", name: "Participant reviewer" };
const contributor = { tokenIdentifier: "https://realworld.test|participant-contributor", subject: "participant-contributor", issuer: "https://realworld.test", name: "Participant contributor" };
const observer = { tokenIdentifier: "https://realworld.test|participant-observer", subject: "participant-observer", issuer: "https://realworld.test", name: "Participant observer" };
const revoked = { tokenIdentifier: "https://realworld.test|participant-revoked", subject: "participant-revoked", issuer: "https://realworld.test", name: "Participant revoked" };
const expired = { tokenIdentifier: "https://realworld.test|participant-expired", subject: "participant-expired", issuer: "https://realworld.test", name: "Participant expired" };

type Identity = typeof owner;
type Role = "owner" | "steward" | "builder" | "reviewer" | "contributor" | "observer" | "agent";
type Test = TestConvex<typeof schema>;
type AuthenticatedTest = ReturnType<Test["withIdentity"]>;

async function setup(): Promise<{ t: Test; asOwner: AuthenticatedTest; missionId: Id<"missions">; roomId: Id<"rooms"> }> {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  await asOwner.mutation(api.profiles.setMine, { displayName: "Participant Owner", idempotencyKey: "call-participant-owner-profile" });
  const mission = await asOwner.mutation(api.missions.createPrivateMission, {
    slug: "call-participants",
    title: "Call participants",
    summary: "Durable contribution mechanics.",
    idempotencyKey: "participant-mission",
    correlationId: "participant-mission",
  });
  const roomId = await addRoom(t, mission.missionId, "Workshop", "workshop");
  return { t, asOwner, missionId: mission.missionId, roomId };
}

async function addRoom(t: Test, missionId: Id<"missions">, title: string, kind: "workshop" | "observatory"): Promise<Id<"rooms">> {
  return await t.run(async (ctx) => ctx.db.insert("rooms", {
    missionId,
    kind,
    title,
    accessPolicy: kind === "observatory" ? "restricted" : "mission",
    mapType: "field",
    layout: { x: kind === "workshop" ? 0 : 240, y: 0, width: 220, height: 140 },
    layoutVersion: 1,
    state: "active",
    currentVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: 1,
  }));
}

async function grant(
  t: Test,
  missionId: Id<"missions">,
  principal: Identity,
  role: Role,
  scope: string[],
  state: "active" | "revoked" | "expired" = "active",
  expiresAt?: number,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const principalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: principal.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
    await ctx.db.insert("missionMembers", { missionId, principalId, role, state, scope, grantVersion: 1, expiresAt, createdAt: now, updatedAt: now, schemaVersion: 1 });
  });
}

function callArgs(missionId: Id<"missions">, roomId: Id<"rooms">, idempotencyKey: string, maxParticipants = 2) {
  return { missionId, roomId, title: "Need a review partner", detail: "Pair on the durable permission review.", maxParticipants, idempotencyKey, correlationId: idempotencyKey };
}

describe("Call participants", () => {
  it("enforces the 1..50 capacity contract under concurrent joins", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    await expect(asOwner.mutation(api.calls.createCall, callArgs(missionId, roomId, "zero-capacity", 0))).rejects.toThrow("participant limit");
    await expect(asOwner.mutation(api.calls.createCall, callArgs(missionId, roomId, "over-capacity-limit", 51))).rejects.toThrow("participant limit");
    const call = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomId, "fifty-capacity", 50));
    const identities = Array.from({ length: 51 }, (_, index) => ({
      tokenIdentifier: `https://realworld.test|capacity-${index}`,
      subject: `capacity-${index}`,
      issuer: "https://realworld.test",
      name: `Capacity ${index}`,
    }));
    for (const identity of identities) {
      await grant(t, missionId, identity, "contributor", [`room:${roomId}`]);
    }
    const attempts = await Promise.allSettled(identities.map((identity, index) =>
      t.withIdentity(identity).mutation(api.calls.joinCall, {
        callId: call.callId,
        idempotencyKey: `capacity-join-${index}`,
        correlationId: `capacity-join-${index}`,
      })));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(50);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect((attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult).reason).toEqual(
      expect.objectContaining({ message: expect.stringContaining("capacity") }),
    );
    expect(await asOwner.query(api.calls.listCallParticipants, { callId: call.callId })).toHaveLength(50);
    expect(await asOwner.query(api.calls.listMissionCalls, { missionId })).toEqual([
      expect.objectContaining({ _id: call.callId, joinedCount: 50, maxParticipants: 50 }),
    ]);
  });

  it("projects joined capacity, supports attributable response updates, and makes duplicate joins safe", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    await grant(t, missionId, reviewer, "reviewer", [`room:${roomId}`]);
    await grant(t, missionId, contributor, "contributor", [`room:${roomId}`]);
    const call = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomId, "capacity-call"));
    const ownerJoin = await asOwner.mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "owner-join", correlationId: "owner-join" });
    expect(await asOwner.mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "owner-join", correlationId: "owner-join" })).toEqual(ownerJoin);
    const reviewerJoin = await t.withIdentity(reviewer).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "reviewer-join", correlationId: "reviewer-join" });
    expect(reviewerJoin).toMatchObject({ joinedCount: 2, maxParticipants: 2 });
    await expect(t.withIdentity(contributor).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "over-capacity", correlationId: "over-capacity" })).rejects.toThrow("capacity");
    const response = await t.withIdentity(reviewer).mutation(api.calls.respondToCall, { callId: call.callId, expectedParticipantVersion: reviewerJoin.currentVersion, response: "I can validate the permission matrix.", idempotencyKey: "reviewer-response", correlationId: "reviewer-response" });
    expect(await t.withIdentity(reviewer).mutation(api.calls.respondToCall, { callId: call.callId, expectedParticipantVersion: reviewerJoin.currentVersion, response: "I can validate the permission matrix.", idempotencyKey: "reviewer-response", correlationId: "reviewer-response" })).toEqual(response);
    const history = await asOwner.query(api.calls.listCallResponseHistory, { callId: call.callId });
    expect(history).toEqual([expect.objectContaining({
      callId: call.callId,
      role: "reviewer",
      isCurrentUser: false,
      revision: 1,
      response: "I can validate the permission matrix.",
    })]);
    expect(history[0]).not.toHaveProperty("principalId");
    expect(await t.withIdentity(reviewer).query(api.calls.listCallResponseHistory, { callId: call.callId })).toEqual([
      expect.objectContaining({ isCurrentUser: true }),
    ]);
    const projection = await asOwner.query(api.calls.listMissionCalls, { missionId });
    expect(projection).toEqual([expect.objectContaining({ _id: call.callId, joinedCount: 2, maxParticipants: 2, canAdminister: true })]);
    const participants = await asOwner.query(api.calls.listCallParticipants, { callId: call.callId });
    expect(participants).toHaveLength(2);
    expect(participants.find((participant) => participant._id === ownerJoin.participantId)).toMatchObject({ isCurrentUser: true, role: "owner" });
    expect(participants.find((participant) => participant._id === reviewerJoin.participantId)).toMatchObject({
      isCurrentUser: false,
      role: "reviewer",
      response: "I can validate the permission matrix.",
    });
    expect(await t.withIdentity(reviewer).query(api.calls.listCallParticipants, { callId: call.callId })).toEqual(
      expect.arrayContaining([expect.objectContaining({ _id: reviewerJoin.participantId, isCurrentUser: true })]),
    );
    expect(ownerJoin.participantId).not.toBe(reviewerJoin.participantId);
  });

  it("allows contribution but reserves Call administration for owner, steward, or the creator", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    await grant(t, missionId, builder, "builder", [`room:${roomId}`]);
    await grant(t, missionId, reviewer, "reviewer", [`room:${roomId}`]);
    await grant(t, missionId, contributor, "contributor", [`room:${roomId}`]);
    await grant(t, missionId, observer, "observer", [`room:${roomId}`]);
    const ownerCall = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomId, "admin-owner"));
    await expect(t.withIdentity(builder).mutation(api.calls.updateCall, { callId: ownerCall.callId, expectedVersion: 1, roomId, linkedMoveId: null, title: "No builder admin", detail: "Builders may participate but not administer another person's Call.", idempotencyKey: "builder-edit", correlationId: "builder-edit" })).rejects.toThrow("Not found");
    await expect(t.withIdentity(contributor).mutation(api.calls.transitionCall, { callId: ownerCall.callId, expectedVersion: 1, nextStatus: "accepted", idempotencyKey: "contributor-transition", correlationId: "contributor-transition" })).rejects.toThrow("Not found");
    await expect(t.withIdentity(reviewer).mutation(api.calls.transitionCall, { callId: ownerCall.callId, expectedVersion: 1, nextStatus: "accepted", idempotencyKey: "reviewer-transition", correlationId: "reviewer-transition" })).rejects.toThrow("Not found");
    await expect(t.withIdentity(observer).mutation(api.calls.joinCall, { callId: ownerCall.callId, idempotencyKey: "observer-join", correlationId: "observer-join" })).rejects.toThrow("Not found");
    await expect(t.withIdentity(observer).mutation(api.calls.respondToCall, { callId: ownerCall.callId, expectedParticipantVersion: 1, response: "No access", idempotencyKey: "observer-response", correlationId: "observer-response" })).rejects.toThrow("Not found");
    await expect(t.withIdentity(observer).query(api.calls.listCallResponseHistory, { callId: ownerCall.callId })).resolves.toEqual([]);
    const contributorCall = await t.withIdentity(contributor).mutation(api.calls.createCall, callArgs(missionId, roomId, "creator-call"));
    await expect(t.withIdentity(contributor).mutation(api.calls.updateCall, { callId: contributorCall.callId, expectedVersion: 1, roomId, linkedMoveId: null, title: "Creator can update", detail: "A contributor who created this Call can administer it in scope.", idempotencyKey: "creator-edit", correlationId: "creator-edit" })).resolves.toMatchObject({ currentVersion: 2 });
    expect(await t.withIdentity(contributor).query(api.calls.listMissionCalls, { missionId })).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: ownerCall.callId, canAdminister: false }),
      expect.objectContaining({ _id: contributorCall.callId, canAdminister: true }),
    ]));
    await expect(t.withIdentity(reviewer).mutation(api.calls.joinCall, { callId: ownerCall.callId, idempotencyKey: "reviewer-join", correlationId: "reviewer-join" })).resolves.toMatchObject({ joinedCount: 1 });
  });

  it("binds receipts to principals, protects room scope, locks a participated Call room, and freezes on archive", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const hiddenRoomId = await addRoom(t, missionId, "Restricted", "observatory");
    await grant(t, missionId, builder, "builder", [`room:${roomId}`]);
    await grant(t, missionId, revoked, "reviewer", [`room:${roomId}`], "revoked");
    await grant(t, missionId, expired, "reviewer", [`room:${roomId}`], "active", Date.now() - 1);
    const call = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomId, "shared-create-key"));
    const ownerJoin = await asOwner.mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "shared-join-key", correlationId: "owner-shared-join" });
    const builderJoin = await t.withIdentity(builder).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "shared-join-key", correlationId: "builder-shared-join" });
    expect(builderJoin.participantId).not.toBe(ownerJoin.participantId);
    await expect(t.withIdentity(revoked).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "revoked-join", correlationId: "revoked-join" })).rejects.toThrow("Not found");
    await expect(t.withIdentity(expired).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "expired-join", correlationId: "expired-join" })).rejects.toThrow("Not found");
    const hiddenCall = await asOwner.mutation(api.calls.createCall, callArgs(missionId, hiddenRoomId, "hidden-call"));
    await expect(t.withIdentity(builder).mutation(api.calls.joinCall, { callId: hiddenCall.callId, idempotencyKey: "wrong-room-join", correlationId: "wrong-room-join" })).rejects.toThrow("Not found");
    const responseArgs = { callId: call.callId, expectedParticipantVersion: builderJoin.currentVersion, response: "I can help.", idempotencyKey: "response-key", correlationId: "response-key" };
    await t.withIdentity(builder).mutation(api.calls.respondToCall, responseArgs);
    await expect(t.withIdentity(builder).mutation(api.calls.respondToCall, { ...responseArgs, response: "Changed payload" })).rejects.toThrow("Idempotency key reuse");
    const latest = (await asOwner.query(api.calls.listMissionCalls, { missionId })).find((candidate) => candidate._id === call.callId)!;
    await expect(asOwner.mutation(api.calls.updateCall, { callId: call.callId, expectedVersion: latest.currentVersion, roomId: hiddenRoomId, linkedMoveId: null, title: callArgs(missionId, roomId, "unused").title, detail: callArgs(missionId, roomId, "unused").detail, idempotencyKey: "move-participated-call", correlationId: "move-participated-call" })).rejects.toThrow("cannot change after participation");
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId, expectedVersion: 1, idempotencyKey: "archive-participants", correlationId: "archive-participants" });
    expect(await asOwner.mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "shared-join-key", correlationId: "owner-shared-join" })).toEqual(ownerJoin);
    await expect(t.withIdentity(builder).mutation(api.calls.respondToCall, { callId: call.callId, expectedParticipantVersion: builderJoin.currentVersion + 1, response: "Archived change", idempotencyKey: "post-archive-response", correlationId: "post-archive-response" })).rejects.toThrow("Mission is not active");
  });

  it("permits withdrawal, keeps it idempotent, and does not admit new participants after a terminal status", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    await grant(t, missionId, builder, "builder", [`room:${roomId}`]);
    const call = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomId, "withdraw-call", 1));
    const join = await t.withIdentity(builder).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "join-then-withdraw", correlationId: "join-then-withdraw" });
    const response = await t.withIdentity(builder).mutation(api.calls.respondToCall, { callId: call.callId, expectedParticipantVersion: join.currentVersion, response: "I can take this.", idempotencyKey: "before-withdraw-response", correlationId: "before-withdraw-response" });
    await expect(t.withIdentity(builder).mutation(api.calls.respondToCall, { callId: call.callId, expectedParticipantVersion: join.currentVersion, response: "Stale response", idempotencyKey: "stale-response", correlationId: "stale-response" })).rejects.toThrow("version conflict");
    const withdrawalArgs = { callId: call.callId, expectedParticipantVersion: response.currentVersion, idempotencyKey: "withdraw", correlationId: "withdraw" };
    const withdrawal = await t.withIdentity(builder).mutation(api.calls.withdrawCall, withdrawalArgs);
    expect(await t.withIdentity(builder).mutation(api.calls.withdrawCall, withdrawalArgs)).toEqual(withdrawal);
    expect(await asOwner.query(api.calls.listCallParticipants, { callId: call.callId })).toEqual([]);
    const rejoin = await t.withIdentity(builder).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "rejoin", correlationId: "rejoin" });
    expect(rejoin.currentVersion).toBeGreaterThan(withdrawal.currentVersion);
    expect(await t.withIdentity(builder).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "join-then-withdraw", correlationId: "join-then-withdraw" })).toEqual(join);
    const rejoinedParticipant = (await asOwner.query(api.calls.listCallParticipants, { callId: call.callId }))[0]!;
    expect(rejoinedParticipant._id).toBe(join.participantId);
    expect(rejoinedParticipant).not.toHaveProperty("response");
    const latest = (await asOwner.query(api.calls.listMissionCalls, { missionId }))[0]!;
    const accepted = await asOwner.mutation(api.calls.transitionCall, { callId: call.callId, expectedVersion: latest.currentVersion, nextStatus: "accepted", idempotencyKey: "accept-terminal", correlationId: "accept-terminal" });
    await asOwner.mutation(api.calls.transitionCall, { callId: call.callId, expectedVersion: accepted.currentVersion, nextStatus: "resolved", resolutionSummary: "The participant plan is resolved.", idempotencyKey: "resolve-terminal", correlationId: "resolve-terminal" });
    await expect(t.withIdentity(builder).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "terminal-join", correlationId: "terminal-join" })).rejects.toThrow("not accepting");
    await expect(t.withIdentity(builder).mutation(api.calls.respondToCall, { callId: call.callId, expectedParticipantVersion: rejoin.currentVersion, response: "Terminal response", idempotencyKey: "terminal-response", correlationId: "terminal-response" })).rejects.toThrow("read-only");
    await expect(t.withIdentity(builder).mutation(api.calls.withdrawCall, { callId: call.callId, expectedParticipantVersion: rejoin.currentVersion, idempotencyKey: "terminal-withdraw", correlationId: "terminal-withdraw" })).rejects.toThrow("read-only");
  });

  it("keeps response history append-only, newest-first, bounded, and room-scoped", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const hiddenRoomId = await addRoom(t, missionId, "History restricted", "observatory");
    await grant(t, missionId, builder, "builder", [`room:${roomId}`]);
    await grant(t, missionId, observer, "observer", [`room:${roomId}`]);
    const call = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomId, "history-call"));
    const join = await t.withIdentity(builder).mutation(api.calls.joinCall, { callId: call.callId, idempotencyKey: "history-join", correlationId: "history-join" });
    const firstArgs = { callId: call.callId, expectedParticipantVersion: join.currentVersion, response: "First response", idempotencyKey: "history-first", correlationId: "history-first" };
    const first = await t.withIdentity(builder).mutation(api.calls.respondToCall, firstArgs);
    expect(await t.withIdentity(builder).mutation(api.calls.respondToCall, firstArgs)).toEqual(first);
    await expect(t.withIdentity(builder).mutation(api.calls.respondToCall, { ...firstArgs, idempotencyKey: "history-stale", response: "Stale response" })).rejects.toThrow("version conflict");
    const second = await t.withIdentity(builder).mutation(api.calls.respondToCall, { callId: call.callId, expectedParticipantVersion: first.currentVersion, response: "Second response", idempotencyKey: "history-second", correlationId: "history-second" });
    expect(second.currentVersion).toBeGreaterThan(first.currentVersion);
    expect(await asOwner.query(api.calls.listCallResponseHistory, { callId: call.callId, limit: 1 })).toEqual([
      expect.objectContaining({ response: "Second response", revision: 2 }),
    ]);
    expect(await asOwner.query(api.calls.listCallResponseHistory, { callId: call.callId })).toEqual([
      expect.objectContaining({ response: "Second response", revision: 2 }),
      expect.objectContaining({ response: "First response", revision: 1 }),
    ]);
    await expect(asOwner.query(api.calls.listCallResponseHistory, { callId: call.callId, limit: 0 })).rejects.toThrow("history limit");
    await expect(asOwner.query(api.calls.listCallResponseHistory, { callId: call.callId, limit: 51 })).rejects.toThrow("history limit");
    const hiddenCall = await asOwner.mutation(api.calls.createCall, callArgs(missionId, hiddenRoomId, "hidden-history-call"));
    await expect(t.withIdentity(builder).query(api.calls.listCallResponseHistory, { callId: hiddenCall.callId })).rejects.toThrow("Not found");
    await expect(t.withIdentity(observer).mutation(api.calls.respondToCall, { callId: call.callId, expectedParticipantVersion: 1, response: "Observer probe", idempotencyKey: "history-observer", correlationId: "history-observer" })).rejects.toThrow("Not found");
  });
});
