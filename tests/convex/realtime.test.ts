import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/realtime.ts": () => import("../../convex/realtime"),
  "../../convex/realtime_authorization.ts": () => import("../../convex/realtime_authorization"),
};

const owner = { tokenIdentifier: "https://realworld.test|realtime-owner", subject: "realtime-owner", issuer: "https://realworld.test", name: "Realtime owner" };
const observer = { tokenIdentifier: "https://realworld.test|realtime-observer", subject: "realtime-observer", issuer: "https://realworld.test", name: "Realtime observer" };
const builder = { tokenIdentifier: "https://realworld.test|realtime-builder", subject: "realtime-builder", issuer: "https://realworld.test", name: "Realtime builder" };
const steward = { tokenIdentifier: "https://realworld.test|realtime-steward", subject: "realtime-steward", issuer: "https://realworld.test", name: "Realtime steward" };
const reviewer = { tokenIdentifier: "https://realworld.test|realtime-reviewer", subject: "realtime-reviewer", issuer: "https://realworld.test", name: "Realtime reviewer" };
const contributor = { tokenIdentifier: "https://realworld.test|realtime-contributor", subject: "realtime-contributor", issuer: "https://realworld.test", name: "Realtime contributor" };
const unknown = { tokenIdentifier: "https://realworld.test|realtime-unknown", subject: "realtime-unknown", issuer: "https://realworld.test", name: "Realtime unknown" };

const syntheticAblyKey = "test.00000000000000000000000000000000:synthetic-signing-material-for-tests-only";

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(owner);
  const mission = await asOwner.mutation(api.missions.createPrivateMission, {
    slug: "realtime-kernel",
    title: "Realtime kernel",
    summary: "Guarded ephemeral credentials.",
    idempotencyKey: "realtime-mission",
    correlationId: "realtime-mission",
  });
  const [workshopId, hiddenRoomId] = await t.run(async (ctx) => {
    const now = Date.now();
    const createRoom = (title: string, kind: "workshop" | "observatory") => ctx.db.insert("rooms", {
      missionId: mission.missionId,
      kind,
      title,
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
    return await Promise.all([createRoom("Workshop", "workshop"), createRoom("Hidden room", "observatory")]);
  });
  return { t, asOwner, missionId: mission.missionId, workshopId, hiddenRoomId };
}

async function grant(
  t: Awaited<ReturnType<typeof setup>>["t"],
  missionId: Awaited<ReturnType<typeof setup>>["missionId"],
  identity: typeof observer,
  role: "builder" | "steward" | "reviewer" | "observer" | "contributor" | "agent",
  scope: string[],
  state: "active" | "revoked" | "expired" = "active",
  principalState: "active" | "disabled" = "active",
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const principalId = await ctx.db.insert("principals", {
      type: "human",
      state: principalState,
      tokenIdentifier: identity.tokenIdentifier,
      displayName: identity.name,
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
      createdAt: now,
      updatedAt: now,
      ...(state === "expired" ? { expiresAt: now - 1 } : {}),
      schemaVersion: 1,
    });
  });
  return t.withIdentity(identity);
}

async function withRealtimeEnv<T>(
  values: { environment?: string; key?: string; productionGuard?: string },
  work: () => Promise<T>,
) {
  const previous = {
    environment: process.env.REALWORLD_APP_ENV,
    key: process.env.ABLY_API_KEY,
    productionGuard: process.env.REALWORLD_ENABLE_PRODUCTION_ABLY,
  };
  const set = (name: "REALWORLD_APP_ENV" | "ABLY_API_KEY" | "REALWORLD_ENABLE_PRODUCTION_ABLY", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set("REALWORLD_APP_ENV", values.environment);
  set("ABLY_API_KEY", values.key);
  set("REALWORLD_ENABLE_PRODUCTION_ABLY", values.productionGuard);
  try {
    return await work();
  } finally {
    set("REALWORLD_APP_ENV", previous.environment);
    set("ABLY_API_KEY", previous.key);
    set("REALWORLD_ENABLE_PRODUCTION_ABLY", previous.productionGuard);
  }
}

describe("guarded Ably token issuer", () => {
  it("issues an exact room namespace with least-privilege writer and observer capabilities", async () => {
    const { t, asOwner, missionId, workshopId } = await setup();
    const asObserver = await grant(t, missionId, observer, "observer", [`room:${workshopId}`]);
    const args = { missionId, roomId: workshopId };

    const issued = await withRealtimeEnv({ environment: "preview", key: syntheticAblyKey }, () => asOwner.action(api.realtime.issueTokenRequest, args));
    const ownerPrincipalId = await t.run(async (ctx) => {
      const mission = await ctx.db.get(missionId);
      if (!mission) throw new Error("Test setup failed");
      return mission.ownerPrincipalId;
    });
    const prefix = `rw:preview:mission:${missionId}`;
    const channels = {
      world: `${prefix}:world`,
      presence: `${prefix}:room:${workshopId}:presence`,
      interaction: `${prefix}:room:${workshopId}:interaction`,
      surge: `${prefix}:room:${workshopId}:surge`,
      agentStatus: `${prefix}:room:${workshopId}:agent-status`,
    };
    const writerCapability = JSON.parse(issued.tokenRequest.capability) as Record<string, string[]>;
    expect(issued.environment).toBe("preview");
    expect(issued.authorizationVersion).toBe(1);
    expect(issued.tokenRequest.ttl).toBe(5 * 60 * 1000);
    expect(issued.expiresAt).toBe(issued.tokenRequest.timestamp + issued.tokenRequest.ttl);
    expect(issued.tokenRequest.clientId).toMatch(/^rw_[A-Za-z0-9_-]+$/);
    expect(issued.tokenRequest.clientId).not.toContain(ownerPrincipalId);
    expect(issued.tokenRequest.capability).not.toContain(ownerPrincipalId);
    expect(JSON.stringify(issued)).not.toContain(syntheticAblyKey);
    expect(JSON.stringify(issued)).not.toContain("synthetic-signing-material-for-tests-only");
    expect(issued.tokenRequest.mac).toMatch(/^[A-Za-z0-9+/=_-]+$/);
    expect(writerCapability).toEqual({
      [channels.world]: ["publish", "subscribe"],
      [channels.presence]: ["presence", "subscribe"],
      [channels.interaction]: ["publish", "subscribe"],
      [channels.surge]: ["publish", "subscribe"],
      [channels.agentStatus]: ["subscribe"],
    });
    expect(Object.keys(writerCapability).every((channel) => channel.startsWith(prefix))).toBe(true);
    expect(issued.tokenRequest.capability).not.toMatch(/\*|history|stats|metadata/);

    const observerIssued = await withRealtimeEnv({ environment: "preview", key: syntheticAblyKey }, () => asObserver.action(api.realtime.issueTokenRequest, args));
    const observerCapability = JSON.parse(observerIssued.tokenRequest.capability) as Record<string, string[]>;
    expect(observerCapability).toEqual({
      [channels.world]: ["subscribe"],
      [channels.presence]: ["subscribe"],
      [channels.surge]: ["subscribe"],
      [channels.agentStatus]: ["subscribe"],
    });
    expect(observerCapability).not.toHaveProperty(channels.interaction);

    const writerIdentities: Array<[typeof steward, "steward" | "reviewer" | "contributor"]> = [
      [steward, "steward"],
      [reviewer, "reviewer"],
      [contributor, "contributor"],
    ];
    const writerActions = await withRealtimeEnv({ environment: "preview", key: syntheticAblyKey }, () => Promise.all(writerIdentities.map(async ([identity, role]) => {
      const member = await grant(t, missionId, identity, role, [`room:${workshopId}`]);
      return member.action(api.realtime.issueTokenRequest, args);
    })));
    for (const writerIssued of writerActions) {
      const writer = JSON.parse(writerIssued.tokenRequest.capability) as Record<string, string[]>;
      expect(writer[channels.world]).toEqual(["publish", "subscribe"]);
      expect(writer[channels.presence]).toEqual(["presence", "subscribe"]);
      expect(writer[channels.agentStatus]).toEqual(["subscribe"]);
    }

    await t.run(async (ctx) => {
      const mission = await ctx.db.get(missionId);
      if (!mission) throw new Error("Test setup failed");
      const membership = await ctx.db
        .query("missionMembers")
        .withIndex("by_mission_and_principal", (index) => index.eq("missionId", missionId).eq("principalId", mission.ownerPrincipalId))
        .unique();
      if (!membership) throw new Error("Test setup failed");
      await ctx.db.patch(membership._id, { grantVersion: 2, updatedAt: Date.now() });
    });
    const rotated = await withRealtimeEnv({ environment: "preview", key: syntheticAblyKey }, () => asOwner.action(api.realtime.issueTokenRequest, args));
    expect(rotated.authorizationVersion).toBe(2);
    expect(rotated.tokenRequest.clientId).not.toBe(issued.tokenRequest.clientId);
  });

  it("rejects missing, disabled, revoked, expired, hidden, wrong-room, archived, and unauthenticated requests", async () => {
    const { t, asOwner, missionId, workshopId, hiddenRoomId } = await setup();
    const asBuilder = await grant(t, missionId, builder, "builder", [`room:${workshopId}`]);
    const revokedIdentity = { ...unknown, tokenIdentifier: "https://realworld.test|realtime-revoked" };
    const expiredIdentity = { ...unknown, tokenIdentifier: "https://realworld.test|realtime-expired" };
    const disabledIdentity = { ...unknown, tokenIdentifier: "https://realworld.test|realtime-disabled" };
    const anomalousAgentIdentity = { ...unknown, tokenIdentifier: "https://realworld.test|realtime-agent-role" };
    const asRevoked = await grant(t, missionId, revokedIdentity, "contributor", [`room:${workshopId}`], "revoked");
    const asExpired = await grant(t, missionId, expiredIdentity, "contributor", [`room:${workshopId}`], "expired");
    const asDisabled = await grant(t, missionId, disabledIdentity, "contributor", [`room:${workshopId}`], "active", "disabled");
    const asAnomalousAgent = await grant(t, missionId, anomalousAgentIdentity, "agent", [`room:${workshopId}`]);
    const args = { missionId, roomId: workshopId };

    await expect(t.action(api.realtime.issueTokenRequest, args)).rejects.toThrow("Unauthorized");
    await expect(t.withIdentity(unknown).action(api.realtime.issueTokenRequest, args)).rejects.toThrow("Unauthorized");
    await expect(asRevoked.action(api.realtime.issueTokenRequest, args)).rejects.toThrow("Not found");
    await expect(asExpired.action(api.realtime.issueTokenRequest, args)).rejects.toThrow("Not found");
    await expect(asDisabled.action(api.realtime.issueTokenRequest, args)).rejects.toThrow("Unauthorized");
    await expect(asAnomalousAgent.action(api.realtime.issueTokenRequest, args)).rejects.toThrow("Not found");
    await expect(asBuilder.action(api.realtime.issueTokenRequest, { missionId, roomId: hiddenRoomId })).rejects.toThrow("Not found");

    const otherMission = await asOwner.mutation(api.missions.createPrivateMission, {
      slug: "other-realtime-kernel",
      title: "Other realtime kernel",
      summary: "A separate Mission remains private.",
      idempotencyKey: "other-realtime-mission",
      correlationId: "other-realtime-mission",
    });
    await expect(asOwner.action(api.realtime.issueTokenRequest, { missionId: otherMission.missionId, roomId: workshopId })).rejects.toThrow("Not found");

    await t.run(async (ctx) => {
      await ctx.db.patch(workshopId, { state: "archived", updatedAt: Date.now() });
    });
    await expect(asOwner.action(api.realtime.issueTokenRequest, args)).rejects.toThrow("Not found");

    await asOwner.mutation(api.missions.archivePrivateMission, {
      missionId,
      expectedVersion: 1,
      idempotencyKey: "archive-realtime-mission",
      correlationId: "archive-realtime-mission",
    });
    await expect(asOwner.action(api.realtime.issueTokenRequest, args)).rejects.toThrow("Not found");
  });

  it("fails closed for environment and key configuration before signing", async () => {
    const { asOwner, missionId, workshopId } = await setup();
    const args = { missionId, roomId: workshopId };

    await expect(withRealtimeEnv({}, () => asOwner.action(api.realtime.issueTokenRequest, args))).rejects.toThrow("REALWORLD_APP_ENV");
    await expect(withRealtimeEnv({ environment: "preview" }, () => asOwner.action(api.realtime.issueTokenRequest, args))).rejects.toThrow("not configured");
    await expect(withRealtimeEnv({ environment: "production", key: syntheticAblyKey }, () => asOwner.action(api.realtime.issueTokenRequest, args))).rejects.toThrow("disabled in production");
    await expect(withRealtimeEnv({ environment: "production", key: syntheticAblyKey, productionGuard: "true" }, () => asOwner.action(api.realtime.issueTokenRequest, args))).rejects.toThrow("not enabled for production");
    await expect(withRealtimeEnv({ environment: "preview", key: "malformed" }, () => asOwner.action(api.realtime.issueTokenRequest, args))).rejects.toThrow();
  });

  it("accepts exact room and Mission scopes at the authorization boundary", async () => {
    const { t, missionId, workshopId } = await setup();
    const asBuilder = await grant(t, missionId, builder, "builder", [`room:${workshopId}`]);
    const authorization = await asBuilder.query(internal.realtime_authorization.authorizeRealtimeTokenRequest, {
      tokenIdentifier: builder.tokenIdentifier,
      missionId,
      roomId: workshopId,
    });
    expect(authorization.role).toBe("builder");
  });
});
