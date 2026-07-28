import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
};

const owner = { tokenIdentifier: "https://realworld.test|dependency-owner", subject: "dependency-owner", issuer: "https://realworld.test", name: "Dependency owner" };
const scopedBuilder = { tokenIdentifier: "https://realworld.test|dependency-builder", subject: "dependency-builder", issuer: "https://realworld.test", name: "Scoped builder" };

async function setup(slug = "dependency-graph") {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const created = await asOwner.mutation(api.missions.createPrivateMission, { slug, title: "Dependency graph", summary: "Adversarial dependency graph tests.", idempotencyKey: `${slug}-mission`, correlationId: `${slug}-mission` });
  const roomId = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId: created.missionId, kind: "workshop", title: "Visible", accessPolicy: "mission", mapType: "field", layout: { x: 0, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
  const hiddenRoomId = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId: created.missionId, kind: "observatory", title: "Hidden", accessPolicy: "mission", mapType: "field", layout: { x: 240, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
  return { t, asOwner, missionId: created.missionId, roomId, hiddenRoomId };
}

function moveArgs(missionId: Awaited<ReturnType<typeof setup>>["missionId"], roomId: Awaited<ReturnType<typeof setup>>["roomId"], key: string, dependencies: string[] = []) {
  return { missionId, roomId, title: key, intent: `${key} intent`, dependencyMoveIds: dependencies as never[], idempotencyKey: key, correlationId: key };
}

async function completeMove(asOwner: Awaited<ReturnType<typeof setup>>["asOwner"], moveId: string) {
  for (const [expectedVersion, nextState] of [[1, "ready"], [2, "inProgress"], [3, "review"], [4, "completed"]] as const) {
    await asOwner.mutation(api.moves.transitionMove, { moveId: moveId as never, expectedVersion, nextState, idempotencyKey: `${moveId}-${nextState}`, correlationId: `${moveId}-${nextState}` });
  }
}

describe("adversarial Move dependencies", () => {
  it("rejects self and three-node cycles without advancing versions", async () => {
    const { asOwner, missionId, roomId } = await setup();
    const a = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "cycle-a"));
    const b = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "cycle-b", [a.moveId]));
    const c = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "cycle-c", [b.moveId]));
    await expect(asOwner.mutation(api.moves.updateMove, { moveId: a.moveId, expectedVersion: 1, title: "cycle-a", intent: "cycle-a intent", dependencyMoveIds: [a.moveId], idempotencyKey: "self", correlationId: "self" })).rejects.toThrow("itself");
    await expect(asOwner.mutation(api.moves.updateMove, { moveId: a.moveId, expectedVersion: 1, title: "cycle-a", intent: "cycle-a intent", dependencyMoveIds: [c.moveId], idempotencyKey: "three-cycle", correlationId: "three-cycle" })).rejects.toThrow("cycle");
    expect((await asOwner.query(api.moves.listMissionMoves, { missionId })).find((move) => move._id === a.moveId)).toMatchObject({ currentVersion: 1, dependencyMoveIds: [] });
  });

  it("does not reveal hidden-room dependencies to a scoped builder", async () => {
    const { t, asOwner, missionId, roomId, hiddenRoomId } = await setup();
    const visible = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "visible"));
    const hidden = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, hiddenRoomId, "hidden"));
    await t.run(async (ctx) => {
      const now = Date.now();
      const principalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: scopedBuilder.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await ctx.db.insert("missionMembers", { missionId, principalId, role: "builder", state: "active", scope: [`room:${roomId}`], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });
    const actor = t.withIdentity(scopedBuilder);
    expect((await actor.query(api.moves.listMissionMoves, { missionId })).map((move) => move._id)).toEqual([visible.moveId]);
    await expect(actor.mutation(api.moves.createMove, { ...moveArgs(missionId, roomId, "hidden-probe", [hidden.moveId]) })).rejects.toThrow("Not found");
  });

  it("requires completed dependencies, including cancelled and archived edge states", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const completed = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "completed"));
    await completeMove(asOwner, completed.moveId);
    const allowed = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "allowed", [completed.moveId]));
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: allowed.moveId, expectedVersion: 1, nextState: "ready", idempotencyKey: "allowed-ready", correlationId: "allowed-ready" })).resolves.toMatchObject({ currentVersion: 2 });

    const cancelled = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "cancelled"));
    await asOwner.mutation(api.moves.transitionMove, { moveId: cancelled.moveId, expectedVersion: 1, nextState: "cancelled", idempotencyKey: "cancel", correlationId: "cancel" });
    const blocked = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "blocked-by-cancel", [cancelled.moveId]));
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: blocked.moveId, expectedVersion: 1, nextState: "ready", idempotencyKey: "cancelled-ready", correlationId: "cancelled-ready" })).rejects.toThrow("dependencies must be completed");

    const archivedId = await t.run(async (ctx) => ctx.db.insert("moves", { missionId, roomId, title: "Archived dependency", intent: "Archived", dependencyMoveIds: [], state: "archived", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
    const archivedDependent = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "blocked-by-archive", [archivedId]));
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: archivedDependent.moveId, expectedVersion: 1, nextState: "ready", idempotencyKey: "archived-ready", correlationId: "archived-ready" })).rejects.toThrow("dependencies must be completed");
  });

  it("keeps cross-Mission dependency probes, stale OCC, and archived replay boundaries closed", async () => {
    const { asOwner, missionId, roomId } = await setup();
    const local = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomId, "local"));
    const other = await asOwner.mutation(api.missions.createPrivateMission, { slug: "dependency-other", title: "Other", summary: "Other Mission.", idempotencyKey: "other-mission", correlationId: "other-mission" });
    const foreign = await asOwner.mutation(api.moves.createMove, moveArgs(other.missionId, undefined as never, "foreign"));
    await expect(asOwner.mutation(api.moves.updateMove, { moveId: local.moveId, expectedVersion: 1, title: "local", intent: "local intent", dependencyMoveIds: [foreign.moveId], idempotencyKey: "cross-mission", correlationId: "cross-mission" })).rejects.toThrow("Not found");

    const readyArgs = { moveId: local.moveId, expectedVersion: 1, nextState: "ready" as const, idempotencyKey: "ready", correlationId: "ready" };
    const ready = await asOwner.mutation(api.moves.transitionMove, readyArgs);
    await expect(asOwner.mutation(api.moves.transitionMove, { ...readyArgs, idempotencyKey: "stale" })).rejects.toThrow("Move version conflict");
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId, expectedVersion: 1, idempotencyKey: "archive", correlationId: "archive" });
    expect(await asOwner.mutation(api.moves.transitionMove, readyArgs)).toEqual(ready);
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: local.moveId, expectedVersion: ready.currentVersion, nextState: "inProgress", idempotencyKey: "fresh-after-archive", correlationId: "fresh-after-archive" })).rejects.toThrow("Mission is not active");
  });
});
