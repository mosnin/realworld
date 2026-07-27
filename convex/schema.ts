import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const principalType = v.union(v.literal("human"), v.literal("agent"), v.literal("service"));
const principalState = v.union(v.literal("active"), v.literal("disabled"));
const membershipRole = v.union(
  v.literal("owner"),
  v.literal("steward"),
  v.literal("builder"),
  v.literal("reviewer"),
  v.literal("contributor"),
  v.literal("observer"),
  v.literal("agent"),
);
const membershipState = v.union(v.literal("active"), v.literal("revoked"), v.literal("expired"));
const missionVisibility = v.union(v.literal("private"), v.literal("unlisted"), v.literal("public"));
const missionLifecycle = v.union(
  v.literal("active"),
  v.literal("archived"),
  v.literal("pendingDeletion"),
  v.literal("deletedTombstone"),
);

export default defineSchema({
  principals: defineTable({
    type: principalType,
    state: principalState,
    tokenIdentifier: v.optional(v.string()),
    displayName: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_token_identifier", ["tokenIdentifier"])
    .index("by_type_and_state", ["type", "state"]),

  missions: defineTable({
    ownerPrincipalId: v.id("principals"),
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    visibility: missionVisibility,
    lifecycle: missionLifecycle,
    currentVersion: v.number(),
    eventSequence: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_owner_and_lifecycle", ["ownerPrincipalId", "lifecycle"])
    .index("by_visibility_and_activity", ["visibility", "updatedAt"])
    .index("by_slug", ["slug"]),

  missionMembers: defineTable({
    missionId: v.id("missions"),
    principalId: v.id("principals"),
    role: membershipRole,
    state: membershipState,
    scope: v.array(v.string()),
    grantVersion: v.number(),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_mission_and_principal", ["missionId", "principalId"])
    .index("by_principal_and_state", ["principalId", "state"])
    .index("by_mission_and_role_and_state", ["missionId", "role", "state"]),

  rooms: defineTable({
    missionId: v.id("missions"),
    kind: v.union(
      v.literal("missionCore"),
      v.literal("workshop"),
      v.literal("observatory"),
      v.literal("branchLab"),
      v.literal("reviewDeck"),
      v.literal("signalTower"),
      v.literal("surgeHall"),
    ),
    title: v.string(),
    accessPolicy: v.union(v.literal("mission"), v.literal("members"), v.literal("restricted")),
    state: v.union(v.literal("active"), v.literal("archived")),
    currentVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_mission_and_state", ["missionId", "state"])
    .index("by_mission_and_kind", ["missionId", "kind"]),

  moves: defineTable({
    missionId: v.id("missions"),
    roomId: v.optional(v.id("rooms")),
    title: v.string(),
    intent: v.string(),
    state: v.union(
      v.literal("proposed"),
      v.literal("ready"),
      v.literal("claimed"),
      v.literal("inProgress"),
      v.literal("blocked"),
      v.literal("review"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("archived"),
    ),
    assigneePrincipalId: v.optional(v.id("principals")),
    currentVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_mission_and_state", ["missionId", "state"])
    .index("by_room_and_state", ["roomId", "state"])
    .index("by_assignee_and_state", ["assigneePrincipalId", "state"]),

  missionEvents: defineTable({
    missionId: v.id("missions"),
    missionSequence: v.number(),
    type: v.union(v.literal("mission.created"), v.literal("mission.archived")),
    aggregateType: v.literal("mission"),
    aggregateId: v.id("missions"),
    actorPrincipalId: v.id("principals"),
    effectiveRole: membershipRole,
    correlationId: v.string(),
    idempotencyKey: v.string(),
    publicSummary: v.string(),
    beforeVersion: v.optional(v.number()),
    afterVersion: v.number(),
    createdAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_mission_and_sequence", ["missionId", "missionSequence"])
    .index("by_aggregate_and_sequence", ["aggregateId", "missionSequence"])
    .index("by_correlation_id", ["correlationId"])
    .index("by_idempotency_key", ["idempotencyKey"]),

  operationReceipts: defineTable({
    scope: v.string(),
    idempotencyKey: v.string(),
    commandFingerprint: v.string(),
    state: v.union(v.literal("complete")),
    missionId: v.id("missions"),
    eventId: v.id("missionEvents"),
    resultVersion: v.number(),
    correlationId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_scope_and_idempotency_key", ["scope", "idempotencyKey"])
    .index("by_expiry", ["expiresAt"]),
});
