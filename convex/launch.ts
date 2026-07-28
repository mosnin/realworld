import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import { requireAuthenticatedTokenIdentifier } from "./lib/auth";
import { isMissionTemplateKey, missionTemplates } from "./lib/mission_templates";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const roomTitles = { missionCore: "Mission Core", workshop: "Workshop", observatory: "Observatory", branchLab: "Branch Lab", reviewDeck: "Review Deck", signalTower: "Signal Tower", surgeHall: "Surge Hall" } as const;

export const createMissionFromTemplate = mutation({
  args: { templateKey: v.string(), slug: v.string(), title: v.string(), idempotencyKey: v.string(), correlationId: v.string() },
  returns: v.object({ missionId: v.id("missions"), eventId: v.id("missionEvents"), currentVersion: v.number() }),
  handler: async (ctx, args) => {
    if (!isMissionTemplateKey(args.templateKey) || !slugPattern.test(args.slug) || args.slug.length > 80 || args.title.trim().length === 0 || args.title.trim().length > 160) throw new Error("Invalid Mission launch");
    const tokenIdentifier = await requireAuthenticatedTokenIdentifier(ctx);
    const scope = `principal:${tokenIdentifier}:launchMission`;
    const fingerprint = JSON.stringify({ command: "createMissionFromTemplate", templateKey: args.templateKey, slug: args.slug, title: args.title.trim() });
    const prior = await ctx.db.query("operationReceipts").withIndex("by_scope_and_idempotency_key", q => q.eq("scope", scope).eq("idempotencyKey", args.idempotencyKey)).unique();
    if (prior !== null) { if (prior.commandFingerprint !== fingerprint) throw new Error("Idempotency key reuse with a different command"); return { missionId: prior.missionId, eventId: prior.eventId, currentVersion: prior.resultVersion }; }
    if (await ctx.db.query("missions").withIndex("by_slug", q => q.eq("slug", args.slug)).unique()) throw new Error("Mission could not be created with that slug");
    const now = Date.now();
    const existing = await ctx.db.query("principals").withIndex("by_token_identifier", q => q.eq("tokenIdentifier", tokenIdentifier)).unique();
    if (existing !== null && (existing.type !== "human" || existing.state !== "active")) throw new Error("Unauthorized");
    const principalId = existing?._id ?? await ctx.db.insert("principals", { type: "human", state: "active", tokenIdentifier, createdAt: now, updatedAt: now, schemaVersion: 1 });
    const template = missionTemplates[args.templateKey];
    const missionId = await ctx.db.insert("missions", { ownerPrincipalId: principalId, slug: args.slug, title: args.title.trim(), summary: template.summary, visibility: "private", lifecycle: "active", currentVersion: 1, templateKey: args.templateKey, createdAt: now, updatedAt: now, schemaVersion: 1 });
    await ctx.db.insert("missionMembers", { missionId, principalId, role: "owner", state: "active", scope: ["mission:*"], grantVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    let workshopId: Id<"rooms"> | undefined;
    for (const [index, kind] of template.rooms.entries()) { const id = await ctx.db.insert("rooms", { missionId, kind, title: roomTitles[kind], accessPolicy: "mission", mapType: "field", layout: { x: 160 + (index % 3) * 260, y: 180 + Math.floor(index / 3) * 190, width: 220, height: 140 }, layoutVersion: 1, state: "active", currentVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 }); if (kind === "workshop") workshopId = id; }
    for (const title of template.moves) await ctx.db.insert("moves", { missionId, roomId: workshopId, title, intent: title, state: "proposed", currentVersion: 1, createdAt: now, updatedAt: now, schemaVersion: 1 });
    const eventId = await ctx.db.insert("missionEvents", { missionId, type: "mission.created", aggregateType: "mission", aggregateId: missionId, actorPrincipalId: principalId, effectiveRole: "owner", correlationId: args.correlationId, idempotencyKey: args.idempotencyKey, publicSummary: `Mission launched from ${args.templateKey}`, afterVersion: 1, createdAt: now, schemaVersion: 1 });
    await ctx.db.insert("operationReceipts", { scope, idempotencyKey: args.idempotencyKey, commandFingerprint: fingerprint, state: "complete", missionId, eventId, resultVersion: 1, correlationId: args.correlationId, createdAt: now, expiresAt: now + 30 * 86400000, schemaVersion: 1 });
    return { missionId, eventId, currentVersion: 1 };
  },
});
