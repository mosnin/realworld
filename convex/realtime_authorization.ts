import { v } from "convex/values";

import { internalQuery } from "./_generated/server";
import { isActiveMembership } from "./lib/auth";

const browserRealtimeRole = v.union(
  v.literal("owner"),
  v.literal("steward"),
  v.literal("builder"),
  v.literal("reviewer"),
  v.literal("contributor"),
  v.literal("observer"),
);

/**
 * Server-only authorization boundary for ephemeral realtime credentials.
 * The public action derives tokenIdentifier from Convex Auth; this query never
 * accepts a browser-provided role, scope, or client identity.
 */
export const authorizeRealtimeTokenRequest = internalQuery({
  args: {
    tokenIdentifier: v.string(),
    missionId: v.id("missions"),
    roomId: v.id("rooms"),
  },
  returns: v.object({
    principalId: v.id("principals"),
    role: browserRealtimeRole,
    grantVersion: v.number(),
  }),
  handler: async (ctx, args) => {
    const [principal, mission, room] = await Promise.all([
      ctx.db
        .query("principals")
        .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", args.tokenIdentifier))
        .unique(),
      ctx.db.get(args.missionId),
      ctx.db.get(args.roomId),
    ]);
    if (!principal || principal.type !== "human" || principal.state !== "active") throw new Error("Unauthorized");
    if (!mission || mission.lifecycle !== "active") throw new Error("Not found");
    if (!room || room.missionId !== mission._id || room.state !== "active") throw new Error("Not found");
    const membership = await ctx.db
      .query("missionMembers")
      .withIndex("by_mission_and_principal", (index) =>
        index.eq("missionId", mission._id).eq("principalId", principal._id))
      .unique();
    if (!membership || !isActiveMembership(membership)) throw new Error("Not found");
    if (membership.role === "agent") throw new Error("Not found");
    if (!membership.scope.includes("mission:*") && !membership.scope.includes(`room:${room._id}`)) {
      throw new Error("Not found");
    }
    return { principalId: principal._id, role: membership.role, grantVersion: membership.grantVersion };
  },
});
