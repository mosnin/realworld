import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
  "../../convex/calls.ts": () => import("../../convex/calls"),
};
const owner = { tokenIdentifier: "https://realworld.test|call-integrity-owner", subject: "call-integrity-owner", issuer: "https://realworld.test", name: "Call integrity owner" };

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const mission = await asOwner.mutation(api.missions.createPrivateMission, { slug: "call-integrity", title: "Call integrity", summary: "Call integrity checks.", idempotencyKey: "integrity-mission", correlationId: "integrity-mission" });
  const roomA = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId: mission.missionId, kind: "workshop", title: "A", accessPolicy: "mission", mapType: "field", layout: { x: 0, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
  const roomB = await t.run(async (ctx) => ctx.db.insert("rooms", { missionId: mission.missionId, kind: "observatory", title: "B", accessPolicy: "mission", mapType: "field", layout: { x: 240, y: 0, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1 }));
  return { t, asOwner, missionId: mission.missionId, roomA, roomB };
}

function moveArgs(missionId: Awaited<ReturnType<typeof setup>>["missionId"], roomId: Awaited<ReturnType<typeof setup>>["roomA"] | undefined, key: string) {
  return { missionId, roomId, title: key, intent: `${key} intent`, dependencyMoveIds: [], idempotencyKey: key, correlationId: key };
}

function callArgs(missionId: Awaited<ReturnType<typeof setup>>["missionId"], roomId: Awaited<ReturnType<typeof setup>>["roomA"] | undefined, key: string, linkedMoveId?: string) {
  return { missionId, roomId, ...(linkedMoveId === undefined ? {} : { linkedMoveId: linkedMoveId as never }), title: key, detail: `${key} detail`, idempotencyKey: key, correlationId: key };
}

describe("Call integrity boundaries", () => {
  it("requires a linked Move to share the Call room audience on create and room changes", async () => {
    const { asOwner, missionId, roomA, roomB } = await setup();
    const moveA = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomA, "move-a"));
    const moveB = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, roomB, "move-b"));
    const missionMove = await asOwner.mutation(api.moves.createMove, moveArgs(missionId, undefined, "mission-move"));

    await expect(asOwner.mutation(api.calls.createCall, callArgs(missionId, roomA, "cross-room", moveB.moveId))).rejects.toThrow("Not found");
    await expect(asOwner.mutation(api.calls.createCall, callArgs(missionId, undefined, "roomless-mismatch", moveA.moveId))).rejects.toThrow("Not found");
    await expect(asOwner.mutation(api.calls.createCall, callArgs(missionId, roomA, "room-mismatch", missionMove.moveId))).rejects.toThrow("Not found");
    const call = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomA, "same-room", moveA.moveId));
    await expect(asOwner.mutation(api.calls.updateCall, { callId: call.callId, expectedVersion: 1, roomId: roomB, linkedMoveId: moveA.moveId, title: "same-room", detail: "moved", idempotencyKey: "bad-room-change", correlationId: "bad-room-change" })).rejects.toThrow("Not found");
    await expect(asOwner.mutation(api.calls.updateCall, { callId: call.callId, expectedVersion: 1, roomId: roomB, linkedMoveId: moveB.moveId, title: "same-room", detail: "moved", idempotencyKey: "good-room-change", correlationId: "good-room-change" })).resolves.toMatchObject({ currentVersion: 2 });
  });

  it("keeps terminal Calls immutable while preserving exact replay before and after archive", async () => {
    const { asOwner, missionId, roomA } = await setup();
    const call = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomA, "terminal-call"));
    const updateArgs = { callId: call.callId, expectedVersion: 1, roomId: roomA, linkedMoveId: null, title: "Terminal call", detail: "Updated before terminal state.", idempotencyKey: "initial-update", correlationId: "initial-update" };
    const updated = await asOwner.mutation(api.calls.updateCall, updateArgs);
    await asOwner.mutation(api.calls.transitionCall, { callId: call.callId, expectedVersion: updated.currentVersion, nextStatus: "cancelled", idempotencyKey: "cancel-call", correlationId: "cancel-call" });
    expect(await asOwner.mutation(api.calls.updateCall, updateArgs)).toEqual(updated);
    await expect(asOwner.mutation(api.calls.updateCall, { ...updateArgs, expectedVersion: 3, title: "Attempted terminal rewrite", idempotencyKey: "terminal-rewrite", correlationId: "terminal-rewrite" })).rejects.toThrow("Terminal Calls cannot be updated");

    const replayCall = await asOwner.mutation(api.calls.createCall, callArgs(missionId, roomA, "archive-replay"));
    const replayArgs = { callId: replayCall.callId, expectedVersion: 1, roomId: roomA, linkedMoveId: null, title: "Archive replay", detail: "A completed command.", idempotencyKey: "archive-update", correlationId: "archive-update" };
    const replayed = await asOwner.mutation(api.calls.updateCall, replayArgs);
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId, expectedVersion: 1, idempotencyKey: "archive-mission", correlationId: "archive-mission" });
    expect(await asOwner.mutation(api.calls.updateCall, replayArgs)).toEqual(replayed);
    await expect(asOwner.mutation(api.calls.updateCall, { ...replayArgs, expectedVersion: replayed.currentVersion, title: "Fresh archived update", idempotencyKey: "fresh-archive-update", correlationId: "fresh-archive-update" })).rejects.toThrow("Mission is not active");
  });
});
