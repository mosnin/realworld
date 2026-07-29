import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/profiles.ts": () => import("../../convex/profiles"),
  "../../convex/canvas.ts": () => import("../../convex/canvas"),
};

const owner = {
  tokenIdentifier: "https://canvas-roles.test|owner",
  subject: "owner",
  issuer: "https://canvas-roles.test",
  name: "Owner",
};

function identity(name: string) {
  return {
    tokenIdentifier: `https://canvas-roles.test|${name}`,
    subject: name,
    issuer: "https://canvas-roles.test",
    name,
  };
}

function createTest() {
  return convexTest(schema, modules);
}

async function mission(t = createTest()) {
  const asOwner = t.withIdentity(owner);
  await asOwner.mutation(api.profiles.setMine, { displayName: "Canvas Owner", idempotencyKey: "canvas-owner-profile" });
  const created = await asOwner.mutation(api.missions.createPrivateMission, {
    slug: `canvas-role-${Math.random().toString(36).slice(2)}`,
    title: "Canvas role test",
    summary: "A Mission used to prove room write grants.",
    idempotencyKey: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
  });
  return { t, asOwner, missionId: created.missionId };
}

async function room(t: ReturnType<typeof createTest>, missionId: Awaited<ReturnType<typeof mission>>["missionId"], title: string) {
  return await t.run(async (ctx) => await ctx.db.insert("rooms", {
    missionId,
    kind: "workshop",
    title,
    accessPolicy: "mission",
    mapType: "field",
    layout: { x: 100, y: 200, width: 220, height: 140 },
    layoutVersion: 1,
    state: "active",
    currentVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schemaVersion: 1,
  }));
}

async function member(
  t: ReturnType<typeof createTest>,
  missionId: Awaited<ReturnType<typeof mission>>["missionId"],
  actor: ReturnType<typeof identity>,
  role: "steward" | "builder" | "reviewer" | "contributor" | "observer" | "agent",
  scope: string[],
  state: "active" | "revoked" = "active",
  expiresAt?: number,
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const principalId = await ctx.db.insert("principals", {
      type: role === "agent" ? "agent" : "human",
      state: "active",
      tokenIdentifier: actor.tokenIdentifier,
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
      ...(expiresAt === undefined ? {} : { expiresAt }),
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  });
}

const changedLayout = { x: 220, y: 330, width: 300, height: 200 };

describe("room write grants", () => {
  it("allows owner, steward, and builder Mission-wide grants to update, rename, and archive", async () => {
    const { t, asOwner, missionId } = await mission();
    const steward = identity("steward");
    const builder = identity("builder");
    await member(t, missionId, steward, "steward", ["mission:*"]);
    await member(t, missionId, builder, "builder", ["mission:*"]);

    for (const [label, actor] of [["owner", asOwner], ["steward", t.withIdentity(steward)], ["builder", t.withIdentity(builder)]] as const) {
      const layoutRoom = await room(t, missionId, `${label} layout`);
      await expect(actor.mutation(api.canvas.updateRoomLayout, { roomId: layoutRoom, expectedLayoutVersion: 1, layout: changedLayout, idempotencyKey: `${label}-layout` })).resolves.toMatchObject({ roomId: layoutRoom, layoutVersion: 2 });

      const renameRoom = await room(t, missionId, `${label} rename`);
      await expect(actor.mutation(api.canvas.renameRoom, { roomId: renameRoom, expectedVersion: 1, title: `${label} renamed`, idempotencyKey: `${label}-rename` })).resolves.toMatchObject({ roomId: renameRoom, currentVersion: 2 });

      const archiveRoom = await room(t, missionId, `${label} archive`);
      await expect(actor.mutation(api.canvas.archiveRoom, { roomId: archiveRoom, expectedVersion: 1, idempotencyKey: `${label}-archive` })).resolves.toMatchObject({ roomId: archiveRoom, currentVersion: 2 });
    }
  });

  it("denies every known-room write to reviewer, contributor, observer, agent, revoked, and expired memberships", async () => {
    const { t, missionId } = await mission();
    const denied = [
      ["reviewer", "reviewer", "active", undefined],
      ["contributor", "contributor", "active", undefined],
      ["observer", "observer", "active", undefined],
      ["agent", "agent", "active", undefined],
      ["revoked", "builder", "revoked", undefined],
      ["expired", "builder", "active", Date.now() - 1],
    ] as const;

    for (const [label, role, state, expiresAt] of denied) {
      const actorIdentity = identity(label);
      await member(t, missionId, actorIdentity, role, ["mission:*"], state, expiresAt);
      const actor = t.withIdentity(actorIdentity);
      const target = await room(t, missionId, `${label} target`);
      const expected = role === "agent" ? "Unauthorized" : "Not found";
      await expect(actor.mutation(api.canvas.updateRoomLayout, { roomId: target, expectedLayoutVersion: 1, layout: changedLayout, idempotencyKey: `${label}-layout` })).rejects.toThrow(expected);
      await expect(actor.mutation(api.canvas.renameRoom, { roomId: target, expectedVersion: 1, title: "Denied rename", idempotencyKey: `${label}-rename` })).rejects.toThrow(expected);
      await expect(actor.mutation(api.canvas.archiveRoom, { roomId: target, expectedVersion: 1, idempotencyKey: `${label}-archive` })).rejects.toThrow(expected);
    }
  });

  it("allows a scoped builder to write its granted room but returns Not found for another known room", async () => {
    const { t, missionId } = await mission();
    const allowed = await room(t, missionId, "Builder's room");
    const hidden = await room(t, missionId, "Other known room");
    const builder = identity("scoped-builder");
    await member(t, missionId, builder, "builder", [`room:${allowed}`]);
    const asBuilder = t.withIdentity(builder);

    await expect(asBuilder.mutation(api.canvas.createRoom, {
      missionId,
      title: "Unauthorized new room",
      kind: "workshop",
      layout: changedLayout,
      idempotencyKey: "scoped-create-denied",
    })).rejects.toThrow("Not found");
    await expect(asBuilder.mutation(api.canvas.updateRoomLayout, { roomId: allowed, expectedLayoutVersion: 1, layout: changedLayout, idempotencyKey: "scoped-allowed-layout" })).resolves.toMatchObject({ roomId: allowed, layoutVersion: 2 });
    await expect(asBuilder.mutation(api.canvas.updateRoomLayout, { roomId: hidden, expectedLayoutVersion: 1, layout: changedLayout, idempotencyKey: "scoped-hidden-layout" })).rejects.toThrow("Not found");
    await expect(asBuilder.mutation(api.canvas.renameRoom, { roomId: hidden, expectedVersion: 1, title: "Probe", idempotencyKey: "scoped-hidden-rename" })).rejects.toThrow("Not found");
    await expect(asBuilder.mutation(api.canvas.archiveRoom, { roomId: hidden, expectedVersion: 1, idempotencyKey: "scoped-hidden-archive" })).rejects.toThrow("Not found");
  });

  it("replays a completed room write after archive while rejecting fresh archived writes", async () => {
    const { asOwner, t, missionId } = await mission();
    const target = await room(t, missionId, "Replay room");
    const update = { roomId: target, expectedLayoutVersion: 1, layout: changedLayout, idempotencyKey: "replay-layout" };
    const completed = await asOwner.mutation(api.canvas.updateRoomLayout, update);
    await asOwner.mutation(api.missions.archivePrivateMission, { missionId, expectedVersion: 1, idempotencyKey: "archive-for-replay", correlationId: "archive-for-replay" });

    await expect(asOwner.mutation(api.canvas.updateRoomLayout, update)).resolves.toEqual(completed);
    await expect(asOwner.mutation(api.canvas.renameRoom, { roomId: target, expectedVersion: 2, title: "Frozen", idempotencyKey: "fresh-archived-rename" })).rejects.toThrow("Mission is not active");
    await expect(asOwner.mutation(api.canvas.archiveRoom, { roomId: target, expectedVersion: 2, idempotencyKey: "fresh-archived-archive" })).rejects.toThrow("Mission is not active");
  });
});
