import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type AuthContext = Pick<QueryCtx, "auth" | "db"> | Pick<MutationCtx, "auth" | "db">;

export type ActiveMembership = {
  _id: Id<"missionMembers">;
  missionId: Id<"missions">;
  principalId: Id<"principals">;
  role: "owner" | "steward" | "builder" | "reviewer" | "contributor" | "observer" | "agent";
  state: "active" | "revoked" | "expired";
  scope: string[];
  grantVersion: number;
};

export async function requireAuthenticatedTokenIdentifier(ctx: AuthContext): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("Unauthorized");
  }
  return identity.tokenIdentifier;
}

export async function requireExistingHumanPrincipal(ctx: AuthContext) {
  const tokenIdentifier = await requireAuthenticatedTokenIdentifier(ctx);
  const principal = await ctx.db
    .query("principals")
    .withIndex("by_token_identifier", (query) => query.eq("tokenIdentifier", tokenIdentifier))
    .unique();

  if (principal === null || principal.type !== "human" || principal.state !== "active") {
    throw new Error("Unauthorized");
  }
  return principal;
}

export async function requireActiveMembership(
  ctx: AuthContext,
  missionId: Id<"missions">,
): Promise<ActiveMembership> {
  const principal = await requireExistingHumanPrincipal(ctx);
  const membership = await ctx.db
    .query("missionMembers")
    .withIndex("by_mission_and_principal", (query) =>
      query.eq("missionId", missionId).eq("principalId", principal._id),
    )
    .unique();

  if (membership === null || membership.state !== "active") {
    throw new Error("Not found");
  }

  return membership;
}

export function requireRole(membership: ActiveMembership, allowedRoles: readonly ActiveMembership["role"][]) {
  if (!allowedRoles.includes(membership.role)) {
    throw new Error("Not found");
  }
}
