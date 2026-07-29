import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/profiles.ts": () => import("../../convex/profiles"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
};

const owner = { tokenIdentifier: "https://realworld.test|move-role-owner", subject: "move-role-owner", issuer: "https://realworld.test", name: "Owner" };
const identity = (name: string) => ({ tokenIdentifier: `https://realworld.test|move-role-${name}`, subject: name, issuer: "https://realworld.test", name });

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  await asOwner.mutation(api.profiles.setMine, { displayName: "Move Role Owner", idempotencyKey: "move-role-owner-profile" });
  const mission = await asOwner.mutation(api.missions.createPrivateMission, { slug: "move-roles", title: "Move roles", summary: "A Move role matrix.", idempotencyKey: "move-role-mission", correlationId: "move-role-mission" });
  const roomId = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId: mission.missionId, kind: "workshop", title: "Workshop", accessPolicy: "mission", mapType: "field", layout: { x: 0, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
  const hiddenRoomId = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId: mission.missionId, kind: "observatory", title: "Hidden", accessPolicy: "mission", mapType: "field", layout: { x: 240, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
  return { t, asOwner, missionId: mission.missionId, roomId, hiddenRoomId };
}

function createArgs(missionId: Awaited<ReturnType<typeof setup>>["missionId"], roomId: Awaited<ReturnType<typeof setup>>["roomId"] | undefined, idempotencyKey: string, title = "Move") {
  return { missionId, roomId, title, intent: "Ship the next durable result.", dependencyMoveIds: [], idempotencyKey, correlationId: idempotencyKey };
}

async function addMember(t: Awaited<ReturnType<typeof setup>>["t"], missionId: Awaited<ReturnType<typeof setup>>["missionId"], name: string, role: "steward" | "builder" | "reviewer" | "contributor" | "observer" | "agent", scope: string[], state: "active" | "revoked" | "expired" = "active", type: "human" | "agent" = "human", expiresAt?: number) {
  const memberIdentity = identity(name);
  await t.run(async (ctx) => {
    const now = Date.now();
    const principalId = await ctx.db.insert("principals", { type, state: "active", tokenIdentifier: memberIdentity.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
    await ctx.db.insert("missionMembers", { missionId, principalId, role, state, scope, grantVersion: 1, ...(expiresAt === undefined ? {} : { expiresAt }), createdAt: now, updatedAt: now, schemaVersion: 1 });
  });
  return t.withIdentity(memberIdentity);
}

describe("Move authorization and transition trust matrix", () => {
  it("allows owner, steward, and builder to complete one valid Move path", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const asSteward = await addMember(t, missionId, "steward", "steward", ["mission:*"]);
    const asBuilder = await addMember(t, missionId, "builder", "builder", ["mission:*"]);
    const created = await asOwner.mutation(api.moves.createMove, createArgs(missionId, roomId, "owner-create"));
    const updated = await asSteward.mutation(api.moves.updateMove, { moveId: created.moveId, expectedVersion: 1, title: "Steward updated", intent: "Steward owns the details.", dependencyMoveIds: [], idempotencyKey: "steward-update", correlationId: "steward-update" });
    const ready = await asBuilder.mutation(api.moves.transitionMove, { moveId: created.moveId, expectedVersion: updated.currentVersion, nextState: "ready", idempotencyKey: "builder-ready", correlationId: "builder-ready" });
    const progressing = await asOwner.mutation(api.moves.transitionMove, { moveId: created.moveId, expectedVersion: ready.currentVersion, nextState: "inProgress", idempotencyKey: "owner-progress", correlationId: "owner-progress" });
    const review = await asSteward.mutation(api.moves.transitionMove, { moveId: created.moveId, expectedVersion: progressing.currentVersion, nextState: "review", idempotencyKey: "steward-review", correlationId: "steward-review" });
    await expect(asBuilder.mutation(api.moves.transitionMove, { moveId: created.moveId, expectedVersion: review.currentVersion, nextState: "completed", idempotencyKey: "builder-complete", correlationId: "builder-complete" })).resolves.toMatchObject({ currentVersion: 6 });
  });

  it("denies every non-writing or inactive principal", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const move = await asOwner.mutation(api.moves.createMove, createArgs(missionId, roomId, "role-target"));
    const denied = await Promise.all([
      addMember(t, missionId, "reviewer", "reviewer", [`room:${roomId}`]),
      addMember(t, missionId, "contributor", "contributor", [`room:${roomId}`]),
      addMember(t, missionId, "observer", "observer", [`room:${roomId}`]),
      addMember(t, missionId, "agent", "agent", ["mission:*"], "active", "agent"),
      addMember(t, missionId, "revoked", "builder", [`room:${roomId}`], "revoked"),
      addMember(t, missionId, "expired", "builder", [`room:${roomId}`], "active", "human", Date.now() - 1),
    ]);
    for (const actor of denied) {
      await expect(actor.mutation(api.moves.createMove, createArgs(missionId, roomId, `denied-${crypto.randomUUID()}`))).rejects.toThrow();
      await expect(actor.mutation(api.moves.updateMove, { moveId: move.moveId, expectedVersion: 1, title: "No", intent: "No", dependencyMoveIds: [], idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() })).rejects.toThrow();
      await expect(actor.mutation(api.moves.transitionMove, { moveId: move.moveId, expectedVersion: 1, nextState: "ready", idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() })).rejects.toThrow();
    }
  });

  it("contains room-scoped builders and mission-read observers", async () => {
    const { t, asOwner, missionId, roomId, hiddenRoomId } = await setup();
    const visible = await asOwner.mutation(api.moves.createMove, createArgs(missionId, roomId, "visible"));
    const hidden = await asOwner.mutation(api.moves.createMove, createArgs(missionId, hiddenRoomId, "hidden"));
    const roomless = await asOwner.mutation(api.moves.createMove, createArgs(missionId, undefined, "roomless"));
    const asScopedBuilder = await addMember(t, missionId, "scoped-builder", "builder", [`room:${roomId}`]);
    const asMissionReader = await addMember(t, missionId, "mission-reader", "observer", ["mission:read"]);
    expect((await asScopedBuilder.query(api.moves.listMissionMoves, { missionId })).map((move) => move._id)).toEqual([visible.moveId]);
    expect((await asMissionReader.query(api.moves.listMissionMoves, { missionId })).map((move) => move._id)).toEqual([roomless.moveId]);
    await expect(asScopedBuilder.mutation(api.moves.createMove, createArgs(missionId, hiddenRoomId, "hidden-target"))).rejects.toThrow("Not found");
    await expect(asScopedBuilder.mutation(api.moves.updateMove, { moveId: hidden.moveId, expectedVersion: 1, title: "Probe", intent: "Probe", dependencyMoveIds: [], idempotencyKey: "hidden-update", correlationId: "hidden-update" })).rejects.toThrow("Not found");
    await expect(asScopedBuilder.mutation(api.moves.createMove, { ...createArgs(missionId, roomId, "hidden-dependency"), dependencyMoveIds: [hidden.moveId] })).rejects.toThrow("Not found");
  });

  it("rejects cross-Mission, self, cyclic, incomplete, and stale commands while replay stays safe after archive", async () => {
    const { asOwner, missionId, roomId } = await setup();
    const first = await asOwner.mutation(api.moves.createMove, createArgs(missionId, roomId, "first"));
    const dependent = await asOwner.mutation(api.moves.createMove, { ...createArgs(missionId, roomId, "dependent"), dependencyMoveIds: [first.moveId] });
    await expect(asOwner.mutation(api.moves.updateMove, { moveId: first.moveId, expectedVersion: 1, title: "First", intent: "First", dependencyMoveIds: [first.moveId], idempotencyKey: "self", correlationId: "self" })).rejects.toThrow("itself");
    await expect(asOwner.mutation(api.moves.updateMove, { moveId: first.moveId, expectedVersion: 1, title: "First", intent: "First", dependencyMoveIds: [dependent.moveId], idempotencyKey: "cycle", correlationId: "cycle" })).rejects.toThrow("cycle");
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: dependent.moveId, expectedVersion: 1, nextState: "ready", idempotencyKey: "incomplete", correlationId: "incomplete" })).rejects.toThrow("dependencies must be completed");
    const readyArgs = { moveId: first.moveId, expectedVersion: 1, nextState: "ready" as const, idempotencyKey: "replay-ready", correlationId: "replay-ready" };
    const ready = await asOwner.mutation(api.moves.transitionMove, readyArgs);
    await expect(asOwner.mutation(api.moves.transitionMove, { ...readyArgs, idempotencyKey: "stale-ready" })).rejects.toThrow("Move version conflict");

    const other = await asOwner.mutation(api.missions.createPrivateMission, { slug: "other-move-roles", title: "Other", summary: "Other Mission.", idempotencyKey: "other-mission", correlationId: "other-mission" });
    const otherMove = await asOwner.mutation(api.moves.createMove, createArgs(other.missionId, undefined, "other-move"));
    await expect(asOwner.mutation(api.moves.updateMove, { moveId: first.moveId, expectedVersion: ready.currentVersion, title: "First", intent: "First", dependencyMoveIds: [otherMove.moveId], idempotencyKey: "cross-mission", correlationId: "cross-mission" })).rejects.toThrow("Not found");

    await asOwner.mutation(api.missions.archivePrivateMission, { missionId, expectedVersion: 1, idempotencyKey: "archive", correlationId: "archive" });
    expect(await asOwner.mutation(api.moves.transitionMove, readyArgs)).toEqual(ready);
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: first.moveId, expectedVersion: ready.currentVersion, nextState: "inProgress", idempotencyKey: "fresh-archive", correlationId: "fresh-archive" })).rejects.toThrow("Mission is not active");
  });
});
