import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

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
  ...authTables,

  principals: defineTable({
    type: principalType,
    state: principalState,
    tokenIdentifier: v.optional(v.string()),
    displayName: v.optional(v.string()),
    // The authoritative server timestamp for the self-service callsign cooldown.
    // Omission means this principal predates the profile kernel and may set once.
    displayNameUpdatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_token_identifier", ["tokenIdentifier"])
    .index("by_type_and_state", ["type", "state"]),

  // Profile writes intentionally have their own receipt surface. Mission
  // operation receipts require Mission/event attribution and must never be
  // manufactured by a self-profile update.
  profileReceipts: defineTable({
    principalId: v.id("principals"),
    idempotencyKey: v.string(),
    commandFingerprint: v.string(),
    resultDisplayName: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_principal_and_idempotency_key", ["principalId", "idempotencyKey"])
    .index("by_expiry", ["expiresAt"]),

  missions: defineTable({
    ownerPrincipalId: v.id("principals"),
    slug: v.string(),
    title: v.string(),
    summary: v.string(),
    constitution: v.optional(v.string()),
    desiredOutcomes: v.optional(v.array(v.string())),
    visibility: missionVisibility,
    lifecycle: missionLifecycle,
    currentVersion: v.number(),
    // Legacy-only compatibility field. New Mission documents and event writes
    // omit it; canonical event ordering lives on the event index itself.
    eventSequence: v.optional(v.number()),
    templateKey: v.optional(v.union(v.literal("companySprint"), v.literal("classroomProject"), v.literal("contentProduction"), v.literal("openChallenge"))),
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
    mapType: v.union(v.literal("field"), v.literal("canvas")),
    layout: v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() }),
    layoutVersion: v.number(),
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
    dependencyMoveIds: v.optional(v.array(v.id("moves"))),
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

  calls: defineTable({
    missionId: v.id("missions"),
    roomId: v.optional(v.id("rooms")),
    linkedMoveId: v.optional(v.id("moves")),
    creatorPrincipalId: v.id("principals"),
    title: v.string(),
    detail: v.string(),
    // Optional for a safe rollout over existing Calls; callers treat omission as 50.
    maxParticipants: v.optional(v.number()),
    joinedCount: v.optional(v.number()),
    // Optional during rollout; `resolved` Calls always persist both resolution fields.
    deadlineAt: v.optional(v.number()),
    resolutionSummary: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    status: v.union(
      v.literal("open"),
      v.literal("accepted"),
      v.literal("resolved"),
      v.literal("cancelled"),
    ),
    currentVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_mission", ["missionId"])
    .index("by_mission_and_status", ["missionId", "status"])
    .index("by_room_and_status", ["roomId", "status"])
    .index("by_creator_and_status", ["creatorPrincipalId", "status"]),

  callParticipants: defineTable({
    callId: v.id("calls"),
    missionId: v.id("missions"),
    principalId: v.id("principals"),
    state: v.union(v.literal("joined"), v.literal("withdrawn")),
    response: v.optional(v.string()),
    currentVersion: v.number(),
    joinedAt: v.number(),
    updatedAt: v.number(),
    joinEventId: v.id("missionEvents"),
    withdrawEventId: v.optional(v.id("missionEvents")),
    responseEventId: v.optional(v.id("missionEvents")),
    schemaVersion: v.number(),
  })
    .index("by_call_and_principal", ["callId", "principalId"])
    .index("by_call_and_state", ["callId", "state"])
    .index("by_principal_and_state", ["principalId", "state"]),

  // Deliberately append-only. The current response on callParticipants is a
  // convenience projection; this table is the durable, attributable history.
  callResponseRevisions: defineTable({
    callId: v.id("calls"),
    missionId: v.id("missions"),
    participantId: v.id("callParticipants"),
    principalId: v.id("principals"),
    revision: v.number(),
    response: v.string(),
    eventId: v.id("missionEvents"),
    createdAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_call", ["callId"])
    .index("by_participant", ["participantId"]),

  fractures: defineTable({
    missionId: v.id("missions"),
    roomId: v.id("rooms"),
    linkedMoveId: v.optional(v.id("moves")),
    reporterPrincipalId: v.id("principals"),
    title: v.string(),
    detail: v.string(),
    severity: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical")),
    status: v.union(v.literal("open"), v.literal("investigating"), v.literal("resolved"), v.literal("dismissed")),
    currentVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_mission_and_status", ["missionId", "status"])
    .index("by_room_and_status", ["roomId", "status"])
    .index("by_reporter_and_status", ["reporterPrincipalId", "status"]),

  proofs: defineTable({
    missionId: v.id("missions"),
    roomId: v.id("rooms"),
    linkedMoveId: v.optional(v.id("moves")),
    submitterPrincipalId: v.id("principals"),
    title: v.string(),
    claim: v.string(),
    evidenceNote: v.string(),
    status: v.union(v.literal("submitted"), v.literal("verified"), v.literal("rejected")),
    verifierPrincipalId: v.optional(v.id("principals")),
    verifiedAt: v.optional(v.number()),
    currentVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_mission_and_status", ["missionId", "status"])
    .index("by_room_and_status", ["roomId", "status"])
    .index("by_submitter_and_status", ["submitterPrincipalId", "status"]),

  missionEvents: defineTable({
    missionId: v.id("missions"),
    // Legacy sequence is present on pre-cutover rows only.
    missionSequence: v.optional(v.number()),
    roomId: v.optional(v.id("rooms")),
    type: v.union(v.literal("mission.created"), v.literal("mission.updated"), v.literal("mission.constitutionUpdated"), v.literal("mission.archived"), v.literal("mission.restored"), v.literal("membership.invited"), v.literal("membership.joined"), v.literal("invite.revoked"), v.literal("room.created"), v.literal("room.renamed"), v.literal("room.archived"), v.literal("room.layoutUpdated"), v.literal("move.created"), v.literal("move.updated"), v.literal("move.transitioned"), v.literal("call.created"), v.literal("call.updated"), v.literal("call.transitioned"), v.literal("call.participantJoined"), v.literal("call.participantWithdrawn"), v.literal("call.responseUpdated"), v.literal("fracture.created"), v.literal("fracture.updated"), v.literal("fracture.transitioned"), v.literal("proof.submitted"), v.literal("proof.updated"), v.literal("proof.verified"), v.literal("proof.rejected"), v.literal("proof.resubmitted")),
    aggregateType: v.literal("mission"),
    aggregateId: v.id("missions"),
    actorPrincipalId: v.id("principals"),
    // Immutable presentation snapshot. Legacy rows intentionally omit it and
    // projections must never recover a value from the mutable principal.
    actorDisplayNameAtAction: v.optional(v.string()),
    actorTypeAtAction: v.optional(principalType),
    effectiveRole: membershipRole,
    correlationId: v.string(),
    idempotencyKey: v.string(),
    publicSummary: v.string(),
    beforeVersion: v.optional(v.number()),
    afterVersion: v.number(),
    createdAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_mission", ["missionId"])
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
    roomId: v.optional(v.id("rooms")),
    moveId: v.optional(v.id("moves")),
    callId: v.optional(v.id("calls")),
    fractureId: v.optional(v.id("fractures")),
    proofId: v.optional(v.id("proofs")),
    participantId: v.optional(v.id("callParticipants")),
    resultVersion: v.number(),
    resultJoinedCount: v.optional(v.number()),
    resultMaxParticipants: v.optional(v.number()),
    correlationId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_scope_and_idempotency_key", ["scope", "idempotencyKey"])
    .index("by_expiry", ["expiresAt"]),

  invites: defineTable({
    missionId: v.id("missions"),
    issuerPrincipalId: v.id("principals"),
    tokenHash: v.string(),
    role: v.union(v.literal("builder"), v.literal("reviewer"), v.literal("contributor"), v.literal("observer")),
    roomIds: v.array(v.id("rooms")),
    expiresAt: v.number(),
    maxUses: v.number(),
    uses: v.number(),
    state: v.union(v.literal("active"), v.literal("revoked"), v.literal("expired"), v.literal("exhausted")),
    createdAt: v.number(),
    updatedAt: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_mission_and_state", ["missionId", "state"])
    .index("by_expiry", ["expiresAt"]),
});
