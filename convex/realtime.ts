"use node";

import Ably from "ably";
import { createHmac } from "node:crypto";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

const tokenTtlMs = 5 * 60 * 1000;
const realtimeEnvironment = v.union(
  v.literal("development"),
  v.literal("test"),
  v.literal("preview"),
);
const tokenRequest = v.object({
  keyName: v.string(),
  ttl: v.number(),
  timestamp: v.number(),
  nonce: v.string(),
  capability: v.string(),
  clientId: v.string(),
  mac: v.string(),
});
type RealtimeEnvironment = "development" | "test" | "preview";
type RealtimeAuthorization = {
  principalId: Id<"principals">;
  role: "owner" | "steward" | "builder" | "reviewer" | "contributor" | "observer";
  grantVersion: number;
};
type IssuedTokenRequest = {
  environment: RealtimeEnvironment;
  authorizationVersion: number;
  expiresAt: number;
  tokenRequest: {
    keyName: string;
    ttl: number;
    timestamp: number;
    nonce: string;
    capability: string;
    clientId: string;
    mac: string;
  };
};

function currentEnvironment(): RealtimeEnvironment {
  const value = process.env.REALWORLD_APP_ENV;
  if (value === "development" || value === "test" || value === "preview") return value;
  if (value === "production") {
    if (process.env.REALWORLD_ENABLE_PRODUCTION_ABLY !== "true") {
      throw new Error("Realtime token issuance is disabled in production without an explicit enable guard");
    }
    throw new Error("Realtime token issuance is not enabled for production in this release");
  }
  throw new Error("Realtime token issuance requires REALWORLD_APP_ENV to be development, test, or preview");
}

function requireRealtimeKey() {
  const key = process.env.ABLY_API_KEY;
  if (!key) throw new Error("Realtime token issuance is not configured");
  return key;
}

function scopedChannels(environment: RealtimeEnvironment, missionId: string, roomId: string) {
  const prefix = `rw:${environment}:mission:${missionId}`;
  return {
    world: `${prefix}:world`,
    presence: `${prefix}:room:${roomId}:presence`,
    interaction: `${prefix}:room:${roomId}:interaction`,
    surge: `${prefix}:room:${roomId}:surge`,
    agentStatus: `${prefix}:room:${roomId}:agent-status`,
  };
}

function capabilities(
  role: RealtimeAuthorization["role"],
  channels: ReturnType<typeof scopedChannels>,
) {
  if (role === "observer") {
    return {
      [channels.world]: ["subscribe"],
      [channels.presence]: ["subscribe"],
      [channels.surge]: ["subscribe"],
      [channels.agentStatus]: ["subscribe"],
    };
  }
  return {
    [channels.world]: ["publish", "subscribe"],
    [channels.presence]: ["presence", "subscribe"],
    [channels.interaction]: ["publish", "subscribe"],
    [channels.surge]: ["publish", "subscribe"],
    // Agent status is an agent-owned projection; humans can observe only.
    [channels.agentStatus]: ["subscribe"],
  };
}

function pseudonymousClientId(apiKey: string, missionId: string, principalId: string, grantVersion: number) {
  const digest = createHmac("sha256", apiKey)
    .update(`realworld-realtime-client:${missionId}:${principalId}:${grantVersion}`)
    .digest("base64url");
  return `rw_${digest}`;
}

/** Issues a short-lived, room-scoped Ably TokenRequest; it never writes durable state. */
export const issueTokenRequest = action({
  args: { missionId: v.id("missions"), roomId: v.id("rooms") },
  returns: v.object({
    environment: realtimeEnvironment,
    authorizationVersion: v.number(),
    expiresAt: v.number(),
    tokenRequest,
  }),
  handler: async (ctx, args): Promise<IssuedTokenRequest> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    const authorization: RealtimeAuthorization = await ctx.runQuery(internal.realtime_authorization.authorizeRealtimeTokenRequest, {
      tokenIdentifier: identity.tokenIdentifier,
      missionId: args.missionId,
      roomId: args.roomId,
    });
    const environment = currentEnvironment();
    const apiKey = requireRealtimeKey();
    const clientId = pseudonymousClientId(apiKey, args.missionId, authorization.principalId, authorization.grantVersion);
    const capability: string = JSON.stringify(capabilities(authorization.role, scopedChannels(environment, args.missionId, args.roomId)));
    const ably = new Ably.Rest({ key: apiKey });
    const request = await ably.auth.createTokenRequest({ clientId, capability, ttl: tokenTtlMs });
    const ttl = request.ttl ?? tokenTtlMs;
    return {
      environment,
      authorizationVersion: authorization.grantVersion,
      expiresAt: request.timestamp + ttl,
      tokenRequest: {
        keyName: request.keyName,
        ttl,
        timestamp: request.timestamp,
        nonce: request.nonce,
        capability: request.capability,
        clientId: request.clientId ?? clientId,
        mac: request.mac,
      },
    };
  },
});
