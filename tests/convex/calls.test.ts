import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/moves.ts": () => import("../../convex/moves"),
  "../../convex/calls.ts": () => import("../../convex/calls"),
  "../../convex/canvas.ts": () => import("../../convex/canvas"),
};

const owner = { tokenIdentifier: "https://realworld.test|call-owner", subject: "call-owner", issuer: "https://realworld.test", name: "Call owner" };
const builder = { tokenIdentifier: "https://realworld.test|call-builder", subject: "call-builder", issuer: "https://realworld.test", name: "Call builder" };
const reviewer = { tokenIdentifier: "https://realworld.test|call-reviewer", subject: "call-reviewer", issuer: "https://realworld.test", name: "Call reviewer" };
const revoked = { tokenIdentifier: "https://realworld.test|call-revoked", subject: "call-revoked", issuer: "https://realworld.test", name: "Call revoked" };
const expired = { tokenIdentifier: "https://realworld.test|call-expired", subject: "call-expired", issuer: "https://realworld.test", name: "Call expired" };

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const mission = await asOwner.mutation(api.missions.createPrivateMission, {
    slug: "call-kernel",
    title: "Call kernel",
    summary: "Durable requests for help.",
    idempotencyKey: "call-mission",
    correlationId: "call-mission",
  });
  const roomId = await t.run(async (ctx) => ctx.db.insert("rooms", {
    missionId: mission.missionId,
    kind: "workshop",
    title: "Workshop",
    accessPolicy: "mission",
    mapType: "field",
    layout: { x: 0, y: 0, width: 220, height: 140 },
    layoutVersion: 1,
    state: "active",
    currentVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: 1,
  }));
  return { t, asOwner, missionId: mission.missionId, roomId };
}

function createArgs(
  missionId: Awaited<ReturnType<typeof setup>>["missionId"],
  roomId: Awaited<ReturnType<typeof setup>>["roomId"],
  idempotencyKey: string,
  title = "Need a product decision",
) {
  return {
    missionId,
    roomId,
    title,
    detail: "Please help choose the next durable work slice.",
    idempotencyKey,
    correlationId: idempotencyKey,
  };
}

async function grant(
  t: Awaited<ReturnType<typeof setup>>["t"],
  missionId: Awaited<ReturnType<typeof setup>>["missionId"],
  principal: typeof builder,
  role: "builder" | "reviewer",
  scope: string[],
  state: "active" | "revoked" | "expired" = "active",
  expiresAt?: number,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const principalId = await ctx.db.insert("principals", {
      type: "human",
      state: "active",
      tokenIdentifier: principal.tokenIdentifier,
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
      grantVersion: 1,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  });
}

describe("Call kernel", () => {
  it("creates a room-scoped Call, records a Mission event, and replays safely", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const linkedMove = await asOwner.mutation(api.moves.createMove, {
      missionId,
      roomId,
      title: "Clarify launch decision",
      intent: "Create the decision record.",
      dependencyMoveIds: [],
      idempotencyKey: "call-linked-move",
      correlationId: "call-linked-move",
    });
    const args = { ...createArgs(missionId, roomId, "create-call"), linkedMoveId: linkedMove.moveId };
    const created = await asOwner.mutation(api.calls.createCall, args);
    expect(await asOwner.mutation(api.calls.createCall, args)).toEqual(created);
    expect(await asOwner.query(api.calls.listMissionCalls, { missionId })).toEqual([
      expect.objectContaining({ _id: created.callId, linkedMoveId: linkedMove.moveId, status: "open" }),
    ]);
    await t.run(async (ctx) => {
      const events = await ctx.db.query("missionEvents")
        .withIndex("by_mission", (index) => index.eq("missionId", missionId))
        .collect();
      expect(events.map((event) => event.type)).toEqual(["mission.created", "move.created", "call.created"]);
      expect(events.every((event) => event.missionSequence === undefined)).toBe(true);
      expect(await ctx.db.query("operationReceipts")
        .withIndex("by_scope_and_idempotency_key", (index) => index.eq("scope", `mission:${missionId}:principal:${events[2]!.actorPrincipalId}:createCall`).eq("idempotencyKey", "create-call"))
        .unique()).toMatchObject({ callId: created.callId, eventId: created.eventId });
    });
  });

  it("enforces active room scope and keeps reviewers read-only", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const hiddenRoomId = await t.run(async (ctx) => ctx.db.insert("rooms", {
      missionId,
      kind: "observatory",
      title: "Restricted",
      accessPolicy: "restricted",
      mapType: "field",
      layout: { x: 240, y: 0, width: 220, height: 140 },
      layoutVersion: 1,
      state: "active",
      currentVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      schemaVersion: 1,
    }));
    const visible = await asOwner.mutation(api.calls.createCall, createArgs(missionId, roomId, "visible-call"));
    await asOwner.mutation(api.calls.createCall, createArgs(missionId, hiddenRoomId, "hidden-call", "Private help"));
    await grant(t, missionId, builder, "builder", [`room:${roomId}`]);
    await grant(t, missionId, reviewer, "reviewer", [`room:${roomId}`]);

    const asBuilder = t.withIdentity(builder);
    const asReviewer = t.withIdentity(reviewer);
    expect(await asBuilder.query(api.calls.listMissionCalls, { missionId })).toEqual([
      expect.objectContaining({ _id: visible.callId }),
    ]);
    await expect(asBuilder.mutation(api.calls.createCall, createArgs(missionId, hiddenRoomId, "out-of-scope"))).rejects.toThrow("Not found");
    expect(await asReviewer.query(api.calls.listMissionCalls, { missionId })).toEqual([
      expect.objectContaining({ _id: visible.callId }),
    ]);
    await expect(asReviewer.mutation(api.calls.transitionCall, {
      callId: visible.callId,
      expectedVersion: 1,
      nextStatus: "accepted",
      idempotencyKey: "reviewer-write",
      correlationId: "reviewer-write",
    })).rejects.toThrow("Not found");
  });

  it("enforces lifecycle, OCC, linked Move visibility, and the archive freeze", async () => {
    const { t, asOwner, missionId, roomId } = await setup();
    const call = await asOwner.mutation(api.calls.createCall, createArgs(missionId, roomId, "lifecycle-call"));
    await expect(asOwner.mutation(api.calls.transitionCall, {
      callId: call.callId,
      expectedVersion: 1,
      nextStatus: "resolved",
      idempotencyKey: "skip-resolution",
      correlationId: "skip-resolution",
    })).rejects.toThrow("Invalid Call transition");
    const acceptedArgs = {
      callId: call.callId,
      expectedVersion: 1,
      nextStatus: "accepted" as const,
      idempotencyKey: "accept-call",
      correlationId: "accept-call",
    };
    const accepted = await asOwner.mutation(api.calls.transitionCall, acceptedArgs);
    expect(await asOwner.mutation(api.calls.transitionCall, acceptedArgs)).toEqual(accepted);
    await expect(asOwner.mutation(api.calls.transitionCall, {
      ...acceptedArgs,
      idempotencyKey: "stale-call",
    })).rejects.toThrow("Call version conflict");
    const updateArgs = {
      callId: call.callId,
      expectedVersion: 2,
      roomId,
      linkedMoveId: null,
      title: "Need the launch decision",
      detail: "Please choose the next durable work slice before the review.",
      idempotencyKey: "update-call",
      correlationId: "update-call",
    };
    const updated = await asOwner.mutation(api.calls.updateCall, updateArgs);
    expect(await asOwner.mutation(api.calls.updateCall, updateArgs)).toEqual(updated);

    const hiddenRoomId = await t.run(async (ctx) => ctx.db.insert("rooms", {
      missionId,
      kind: "observatory",
      title: "Hidden",
      accessPolicy: "restricted",
      mapType: "field",
      layout: { x: 240, y: 0, width: 220, height: 140 },
      layoutVersion: 1,
      state: "active",
      currentVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      schemaVersion: 1,
    }));
    const hiddenMove = await asOwner.mutation(api.moves.createMove, {
      missionId,
      roomId: hiddenRoomId,
      title: "Restricted Move",
      intent: "Keep this private.",
      dependencyMoveIds: [],
      idempotencyKey: "hidden-call-move",
      correlationId: "hidden-call-move",
    });
    await grant(t, missionId, builder, "builder", [`room:${roomId}`]);
    await expect(t.withIdentity(builder).mutation(api.calls.createCall, {
      ...createArgs(missionId, roomId, "hidden-link"),
      linkedMoveId: hiddenMove.moveId,
    })).rejects.toThrow("Not found");

    await asOwner.mutation(api.missions.archivePrivateMission, {
      missionId,
      expectedVersion: 1,
      idempotencyKey: "archive-calls",
      correlationId: "archive-calls",
    });
    await expect(asOwner.mutation(api.calls.transitionCall, {
      callId: call.callId,
      expectedVersion: 3,
      nextStatus: "resolved",
      idempotencyKey: "frozen-call",
      correlationId: "frozen-call",
    })).rejects.toThrow("Mission is not active");
  });

  it("persists valid deadlines and an immutable resolution record", async () => {
    const { asOwner, missionId, roomId } = await setup();
    await expect(asOwner.mutation(api.calls.createCall, {
      ...createArgs(missionId, roomId, "expired-deadline"),
      deadlineAt: Date.now() - 1,
    })).rejects.toThrow("Invalid Call deadline");
    const deadlineAt = Date.now() + 60_000;
    const call = await asOwner.mutation(api.calls.createCall, {
      ...createArgs(missionId, roomId, "deadline-call"),
      deadlineAt,
    });
    expect(await asOwner.query(api.calls.listMissionCalls, { missionId })).toEqual([
      expect.objectContaining({ _id: call.callId, deadlineAt }),
    ]);
    const revisedDeadlineAt = Date.now() + 120_000;
    const updated = await asOwner.mutation(api.calls.updateCall, {
      callId: call.callId,
      expectedVersion: call.currentVersion,
      roomId,
      linkedMoveId: null,
      title: "Need a product decision",
      detail: "Please help choose the next durable work slice.",
      deadlineAt: revisedDeadlineAt,
      idempotencyKey: "revise-deadline",
      correlationId: "revise-deadline",
    });
    const accepted = await asOwner.mutation(api.calls.transitionCall, {
      callId: call.callId,
      expectedVersion: updated.currentVersion,
      nextStatus: "accepted",
      resolutionSummary: null,
      idempotencyKey: "deadline-accept",
      correlationId: "deadline-accept",
    });
    await expect(asOwner.mutation(api.calls.transitionCall, {
      callId: call.callId,
      expectedVersion: accepted.currentVersion,
      nextStatus: "resolved",
      resolutionSummary: "   ",
      idempotencyKey: "empty-resolution",
      correlationId: "empty-resolution",
    })).rejects.toThrow("Invalid Call resolution summary");
    const resolvedArgs = {
      callId: call.callId,
      expectedVersion: accepted.currentVersion,
      nextStatus: "resolved" as const,
      resolutionSummary: "Ship the reviewed decision record.",
      idempotencyKey: "resolve-deadline-call",
      correlationId: "resolve-deadline-call",
    };
    const resolved = await asOwner.mutation(api.calls.transitionCall, resolvedArgs);
    expect(await asOwner.mutation(api.calls.transitionCall, resolvedArgs)).toEqual(resolved);
    const resolvedCall = (await asOwner.query(api.calls.listMissionCalls, { missionId }))[0]!;
    expect(resolvedCall).toMatchObject({
      _id: call.callId,
      deadlineAt: revisedDeadlineAt,
      status: "resolved",
      resolutionSummary: "Ship the reviewed decision record.",
      resolvedAt: expect.any(Number),
    });
    await expect(asOwner.mutation(api.calls.updateCall, {
      callId: call.callId,
      expectedVersion: resolved.currentVersion,
      roomId,
      linkedMoveId: null,
      title: "Attempted terminal rewrite",
      detail: "Terminal calls retain their immutable resolution record.",
      deadlineAt: null,
      idempotencyKey: "terminal-deadline-rewrite",
      correlationId: "terminal-deadline-rewrite",
    })).rejects.toThrow("Terminal Calls");

    const cancelled = await asOwner.mutation(api.calls.createCall, {
      ...createArgs(missionId, roomId, "cancelled-without-summary"),
      deadlineAt: null,
    });
    await expect(asOwner.mutation(api.calls.transitionCall, {
      callId: cancelled.callId,
      expectedVersion: cancelled.currentVersion,
      nextStatus: "cancelled",
      resolutionSummary: "This cannot be stored on a cancellation.",
      idempotencyKey: "cancel-with-summary",
      correlationId: "cancel-with-summary",
    })).rejects.toThrow("Only resolved Calls");
    await asOwner.mutation(api.calls.transitionCall, {
      callId: cancelled.callId,
      expectedVersion: cancelled.currentVersion,
      nextStatus: "cancelled",
      resolutionSummary: null,
      idempotencyKey: "cancel-without-summary",
      correlationId: "cancel-without-summary",
    });
    expect((await asOwner.query(api.calls.listMissionCalls, { missionId })).find((item) => item._id === cancelled.callId))
      .not.toHaveProperty("resolutionSummary");
  });

  it("rejects revoked and expired memberships before they can create Calls", async () => {
    const { t, missionId, roomId } = await setup();
    await grant(t, missionId, revoked, "builder", [`room:${roomId}`], "revoked");
    await grant(t, missionId, expired, "builder", [`room:${roomId}`], "active", Date.now() - 1);
    await expect(t.withIdentity(revoked).mutation(api.calls.createCall, createArgs(missionId, roomId, "revoked-call"))).rejects.toThrow("Not found");
    await expect(t.withIdentity(expired).mutation(api.calls.createCall, createArgs(missionId, roomId, "expired-call"))).rejects.toThrow("Not found");
  });
});
