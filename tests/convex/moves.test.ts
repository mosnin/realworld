import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
  "../../convex/canvas.ts": () => import("../../convex/canvas"),
};

const owner = { tokenIdentifier: "https://realworld.test|move-owner", subject: "move-owner", issuer: "https://realworld.test", name: "Move owner" };
const collaborator = { tokenIdentifier: "https://realworld.test|move-collaborator", subject: "move-collaborator", issuer: "https://realworld.test", name: "Move collaborator" };
const builder = { tokenIdentifier: "https://realworld.test|move-builder", subject: "move-builder", issuer: "https://realworld.test", name: "Move builder" };

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const mission = await asOwner.mutation(api.missions.createPrivateMission, { slug: "move-kernel", title: "Move kernel", summary: "Durable Moves.", idempotencyKey: "move-mission", correlationId: "move-mission" });
  const roomId = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId: mission.missionId, kind: "workshop", title: "Workshop", accessPolicy: "mission", mapType: "field", layout: { x: 0, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
  return { t, asOwner, missionId: mission.missionId, roomId };
}

function createArgs(missionId: Awaited<ReturnType<typeof setup>>["missionId"], roomId: Awaited<ReturnType<typeof setup>>["roomId"], idempotencyKey: string, title = "Ship the Move") {
  return { missionId, roomId, title, intent: "Turn shared intent into a verified result.", dependencyMoveIds: [], idempotencyKey, correlationId: idempotencyKey };
}

describe("Move kernel", () => {
  it("creates scoped Moves, records events, and replays the same command", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const args = createArgs(missionId, roomId, "create-move");
    const created = await asOwner.mutation(api.moves.createMove, args);
    expect(await asOwner.mutation(api.moves.createMove, args)).toEqual(created);
    expect(await asOwner.query(api.moves.listMissionMoves, { missionId })).toEqual([expect.objectContaining({ _id: created.moveId, state: "proposed", dependencyMoveIds: [] })]);
    await t.run(async (ctx) => {
      const events = await ctx.db.query("missionEvents").withIndex("by_mission_and_sequence", (index) => index.eq("missionId", missionId)).collect();
      expect(events.map((event) => [event.missionSequence, event.type])).toEqual([[1, "mission.created"], [2, "move.created"]]);
      expect(await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", `mission:${missionId}:createMove`).eq("idempotencyKey", "create-move")).unique()).toMatchObject({ moveId: created.moveId, eventId: created.eventId });
    });
  });

  it("filters reads by room scope and keeps non-writers read-only", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const hiddenRoomId = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId, kind: "observatory", title: "Hidden", accessPolicy: "mission", mapType: "field", layout: { x: 240, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
    const visible = await asOwner.mutation(api.moves.createMove, createArgs(missionId, roomId, "visible-move"));
    await asOwner.mutation(api.moves.createMove, createArgs(missionId, hiddenRoomId, "hidden-move", "Hidden Move"));
    await t.run(async (ctx) => {
      const now = Date.now();
      const principalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: collaborator.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await ctx.db.insert("missionMembers", { missionId, principalId, role: "reviewer", state: "active", scope: [`room:${roomId}`], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });
    const asCollaborator = t.withIdentity(collaborator);
    expect(await asCollaborator.query(api.moves.listMissionMoves, { missionId })).toEqual([expect.objectContaining({ _id: visible.moveId })]);
    await expect(asCollaborator.mutation(api.moves.transitionMove, { moveId: visible.moveId, expectedVersion: 1, nextState: "ready", idempotencyKey: "reviewer-write", correlationId: "reviewer-write" })).rejects.toThrow("Not found");
  });

  it("enforces the state machine, OCC, dependency boundaries, and archive freeze", async () => {
    const { asOwner, missionId, roomId } = await setup();
    const first = await asOwner.mutation(api.moves.createMove, createArgs(missionId, roomId, "first-move", "First"));
    const second = await asOwner.mutation(api.moves.createMove, { ...createArgs(missionId, roomId, "second-move", "Second"), dependencyMoveIds: [first.moveId] });
    await expect(asOwner.mutation(api.moves.updateMove, { moveId: first.moveId, expectedVersion: 1, title: "First", intent: "Turn shared intent into a verified result.", dependencyMoveIds: [second.moveId], idempotencyKey: "cycle", correlationId: "cycle" })).rejects.toThrow("cycle");
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: first.moveId, expectedVersion: 1, nextState: "completed", idempotencyKey: "skip", correlationId: "skip" })).rejects.toThrow("Invalid Move transition");
    const readyArgs = { moveId: first.moveId, expectedVersion: 1, nextState: "ready" as const, idempotencyKey: "ready", correlationId: "ready" };
    const ready = await asOwner.mutation(api.moves.transitionMove, readyArgs);
    await expect(asOwner.mutation(api.moves.transitionMove, { ...readyArgs, idempotencyKey: "stale" })).rejects.toThrow("Move version conflict");
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId, expectedVersion: 1, idempotencyKey: "archive-moves", correlationId: "archive-moves" });
    expect(await asOwner.mutation(api.moves.transitionMove, readyArgs)).toEqual(ready);
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: first.moveId, expectedVersion: 2, nextState: "inProgress", idempotencyKey: "frozen", correlationId: "frozen" })).rejects.toThrow("Mission is not active");
  });

  it("hides unreadable dependencies and requires completed dependencies before ready", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const hiddenRoomId = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId, kind: "observatory", title: "Hidden", accessPolicy: "mission", mapType: "field", layout: { x: 240, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
    const hidden = await asOwner.mutation(api.moves.createMove, createArgs(missionId, hiddenRoomId, "hidden-dependency"));
    await t.run(async (ctx) => {
      const now = Date.now();
      const principalId = await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier: builder.tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await ctx.db.insert("missionMembers", { missionId, principalId, role: "builder", state: "active", scope: [`room:${roomId}`], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    });
    await expect(t.withIdentity(builder).mutation(api.moves.createMove, { ...createArgs(missionId, roomId, "hidden-probe"), dependencyMoveIds: [hidden.moveId] })).rejects.toThrow("Not found");
    await expect(asOwner.mutation(api.moves.createMove, { ...createArgs(missionId, roomId, "blank-command"), idempotencyKey: "" })).rejects.toThrow("Invalid idempotency key");

    const prerequisite = await asOwner.mutation(api.moves.createMove, createArgs(missionId, roomId, "prerequisite"));
    const dependent = await asOwner.mutation(api.moves.createMove, { ...createArgs(missionId, roomId, "dependent"), dependencyMoveIds: [prerequisite.moveId] });
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: dependent.moveId, expectedVersion: 1, nextState: "ready", idempotencyKey: "dependent-too-soon", correlationId: "dependent-too-soon" })).rejects.toThrow("dependencies must be completed");
    for (const [expectedVersion, nextState] of [[1, "ready"], [2, "inProgress"], [3, "review"], [4, "completed"]] as const) {
      await asOwner.mutation(api.moves.transitionMove, { moveId: prerequisite.moveId, expectedVersion, nextState, idempotencyKey: `prerequisite-${nextState}`, correlationId: `prerequisite-${nextState}` });
    }
    await expect(asOwner.mutation(api.moves.transitionMove, { moveId: dependent.moveId, expectedVersion: 1, nextState: "ready", idempotencyKey: "dependent-ready", correlationId: "dependent-ready" })).resolves.toMatchObject({ currentVersion: 2 });
  });
});
