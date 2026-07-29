import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Captures a human callsign at the durable write boundary. Missing/legacy
 * callsigns remain absent rather than being derived from private identity data.
 */
export async function humanAttributionAtAction(
  ctx: Pick<MutationCtx, "db">,
  principalId: Id<"principals">,
) {
  const principal = await ctx.db.get(principalId);
  if (principal === null || principal.type !== "human" || principal.state !== "active") return undefined;
  return {
    actorTypeAtAction: "human" as const,
    ...(principal.displayName === undefined ? {} : { actorDisplayNameAtAction: principal.displayName }),
  };
}
