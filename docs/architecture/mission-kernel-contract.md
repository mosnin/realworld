# Mission Kernel Contract

## Purpose and scope

The Mission Kernel is the authoritative, durable collaboration model for Realworld. It makes a Mission usable alone and consistent for up to fifty people and bounded agents. It owns all work that must survive refresh, reconnect, replay, role changes, and deployment changes.

This document is a production contract for the future Convex implementation. It deliberately specifies domain semantics, entity boundaries, read/write shapes, indexes, and acceptance criteria; it does **not** prescribe generated function names, SDK calls, provider APIs, or an editor implementation.

## Non-negotiable invariants

1. Convex is the source of truth for all entities in this contract and the append-only Mission Event Ledger.
2. Ably and browser state are ephemeral accelerators only. They cannot create authority, complete a Move, publish an Artifact, or decide membership.
3. Every durable transition has an actor, effective authorization context, correlation id, idempotency key, and immutable event record.
4. Agents are principals with a delegation chain; they never impersonate a human and may act only inside their active envelope.
5. A Mission is private by default. A subordinate object may only narrow Mission access unless an explicit, auditable publication transition makes a bounded object public.
6. Artifact versions and event records are immutable. Corrections, reversals, restoration, and merge results are new records that reference the prior state.
7. A stale client or concurrent actor gets an explicit conflict/proposal path, never a silent overwrite.
8. Archive and deletion are recoverable first. Hard deletion is a separately governed retention process, not an ordinary product mutation.

## Principals, identity, and roles

A **principal** represents a human user, a service identity, or an autonomous agent. It has a stable internal id, a type (`human`, `agent`, or `service`), a lifecycle state, and a verified external-auth binding where applicable. Authentication provider semantics remain an implementation decision; the kernel only requires a verified subject-to-principal mapping.

`memberships` bind a principal to a Mission. They contain the base role, state, grant provenance, scope, and expiry. A membership is never inferred from presence, an invitation, an event, or an artifact author id.

| Role | Default durable authority | Explicitly excluded authority |
| --- | --- | --- |
| Owner | Constitution, Mission lifecycle, visibility, membership policy, budget policy | Bypassing audit/event creation |
| Steward | Coordinate Moves, Calls, Fractures, and proposals within Mission policy | Ownership transfer, unapproved visibility/budget change |
| Builder | Create permitted Moves, drafts, and Artifact versions | Role changes, private-content disclosure |
| Reviewer | Comment, verify evidence, approve scoped proposals/Proof | Broad membership and policy changes |
| Contributor | Fulfil a granted Call or scoped Move; propose work | Unscoped read/write access |
| Observer | Read explicitly shared material | Durable edits, invitations, publishing |
| Agent | Typed actions granted by active delegation envelope | Self-grant, impersonation, unbounded external/destructive action |

Roles are a coarse starting point; every command also checks object scope, Mission Constitution, branch/room policy, ownership state, and any active capability grant. The effective authorization snapshot is persisted in the resulting event, including the relevant membership/grant version—not a mutable role label alone.

## Convex entities and index contract

All records include `_id`, `_creationTime`, `createdAt`, `updatedAt` where mutable, and `schemaVersion`. Indexes below are required initial read paths; implementation may add indexes but must not replace an indexed authorization predicate with an unbounded filter.

| Table / aggregate | Required durable fields | Required indexes / uniqueness | Notes |
| --- | --- | --- | --- |
| `principals` | type, externalSubject?, display profile, state | `by_external_subject`, `by_type_and_state` | One verified external subject maps to one active human principal. |
| `missions` | ownerPrincipalId, slug, title, summary, visibility, lifecycle, constitutionVersionId, defaultBranchId, currentVersion | `by_owner_and_lifecycle`, `by_visibility_and_activity`, `by_slug` | Lifecycle: `active`, `archived`, `pendingDeletion`, `deletedTombstone`. |
| `missionMembers` | missionId, principalId, role, state, scope, grantVersion, expiresAt?, invitedBy? | `by_mission_and_principal`, `by_principal_and_state`, `by_mission_and_role_and_state` | One active membership per Mission/principal; history is retained by state/version or a membership-history event. |
| `invites` | missionId, issuer, requested role/scope, token digest, expiry, use limit, state | `by_token_digest`, `by_mission_and_state`, `by_expiry` | Store a digest, never raw invite secrets. |
| `constitutions` / `constitutionVersions` | missionId, version, policy document/ref, approval metadata, state | `by_mission_and_version`, `by_mission_and_state` | Immutable versions; Mission points at active version. |
| `rooms` | missionId, kind, title, access policy, layout ref, state, currentVersion | `by_mission_and_state`, `by_mission_and_kind` | Rooms are durable work contexts, not realtime channels. |
| `moves` | missionId, roomId?, branchId, title, intent, state, assignee refs, dependency summary, due horizon?, currentVersion | `by_mission_and_state`, `by_room_and_state`, `by_branch_and_state`, `by_assignee_and_state` | State machine: `proposed`, `ready`, `claimed`, `inProgress`, `blocked`, `review`, `completed`, `cancelled`, `archived`. |
| `moveDependencies` | missionId, predecessorMoveId, successorMoveId, kind, state | `by_successor`, `by_predecessor`, `by_mission_and_state` | Reject cycles before commit. |
| `calls` | missionId, roomId?, relatedMoveId?, requester, requested capability, scope, state, expiry, currentVersion | `by_mission_and_state`, `by_capability_and_state`, `by_expiry` | Call creation/answering is independently auditable. |
| `fractures` | missionId, roomId?, related aggregate, severity, evidence refs, owner?, state, currentVersion | `by_mission_and_state`, `by_owner_and_state`, `by_severity_and_state` | A Fracture has a recovery path or an explicit dismissal reason. |
| `artifacts` | missionId, roomId?, branchId, kind, title, visibility, lifecycle, headVersionId, currentVersion | `by_mission_and_lifecycle`, `by_room_and_lifecycle`, `by_branch_and_lifecycle` | Metadata only; content resides in a version/reference. |
| `artifactVersions` | artifactId, missionId, parentVersionId?, author principal, content ref/hash, change summary, status, evidence refs | `by_artifact_and_creation`, `by_mission_and_creation`, `by_parent_version` | Immutable. Concurrent writes produce separate versions/proposals. |
| `branches` | missionId, parentBranchId?, source refs, question, state, owner, base event/version, merge criteria, currentVersion | `by_mission_and_state`, `by_parent_branch`, `by_owner_and_state` | State: `active`, `proposedForMerge`, `merged`, `retired`, `archived`. |
| `proofs` | missionId, branchId?, related outcome/move/artifact refs, statement, evidence refs, verifier, state, visibility | `by_mission_and_state`, `by_artifact`, `by_visibility_and_state` | Proof is a verifiable claim, not a task checkbox. |
| `missionEvents` | missionId, type, aggregate type/id, actor, effectiveAuth ref, correlation id, idempotency key, public summary, private/evidence refs, schema version | `by_mission`, `by_correlation_id`, `by_idempotency_key`; legacy sequence indexes remain during migration | Append-only. Convex creation order is the canonical stable Mission cursor; new writes never contend on a Mission counter. The event contains safe summaries and references, never secrets or private reasoning. |
| `operationReceipts` | scope, idempotency key, command digest, state, result refs, correlation id, expiry | `by_scope_and_idempotency_key`, `by_expiry` | Deduplicates client/server retries. |
| `retentionHolds` | missionId/object ref, reason, authority, started/endsAt?, state | `by_object_and_state`, `by_expiry` | Prevents automated purge where legal/security policy requires. |

### Entity relationship rules

- Every user-visible aggregate except a principal has exactly one `missionId`; no cross-Mission object reference may grant read/write access.
- A Room belongs to one Mission. Moving a durable object between rooms creates an event and preserves prior room lineage.
- A Move may reference one current Branch; Branches may contain Moves and Artifacts but cannot rewrite the source branch’s history.
- An Artifact version belongs to exactly one Artifact. A version may cite sources across the Mission only if the actor has read access; public versions may cite only publishable references.
- A Proof references immutable Artifact versions/evidence refs and its verifier’s authorization snapshot.
- A Call can be answered by a scoped, expiring membership or an existing member; answering cannot silently upgrade a role.

## Mission lifecycle, archive, restore, and deletion

### Create

Mission creation is an atomic command that creates: Mission, initial Constitution version, initial default Branch, Owner membership, and `mission.created` event. Initial rooms and Moves are optional separate commands so the event history retains whether a human or Steward proposed them.

### Archive

Only an Owner (or explicit organization policy later) may archive. Archive changes the Mission lifecycle to `archived`, records the reason, stops new invitations and new agent launches, and makes ordinary write commands reject. Existing content and audit history remain readable according to prior permission scope. Ably presence is ended as a consequence, never as the source of archive state.

### Restore

Restore requires Owner authority, an expected Mission version, and a recorded rationale. It creates `mission.restored`, returns the Mission to `active`, and does not automatically resume previously cancelled agent runs or expired invitations. A restore has a specific recovery point/reference and is idempotent.

### Deletion and retention

Deletion begins with `pendingDeletion` and a visible recovery window. The command creates a deletion request event, freezes non-recovery writes, and schedules a retention evaluation. Hard deletion/pseudonymization only runs after the recovery window, retention-hold checks, policy-required export/notification, and a separately logged purge result. Event history may retain a minimal tombstone where needed to protect integrity and prevent stale IDs from being reused; its data class and retention basis must be documented before public launch.

## Append-only Mission Event Ledger

The event ledger is an audit and replay log, not a second mutable object store. Any mutation that changes user-visible durable state appends one or more events in the same atomic transaction.

### Event envelope

Every event records:

- a unique id and immutable Convex creation cursor within the Mission;
- event type and versioned payload schema;
- Mission and aggregate reference;
- actor principal, delegated-by principal when applicable, and operation origin (`human`, `agent`, `system`);
- effective membership/capability/Constitution version reference;
- correlation id, command/request id, and idempotency key;
- before/after aggregate version refs where meaningful;
- concise safe summary, evidence references, timestamp, and outcome.

Payloads must be forward-compatible and bounded. Sensitive content is held in permission-checked objects or encrypted references. A projection/replay reader must tolerate unknown future event fields and ignore an unknown event type only when it is not required to calculate the requested projection; otherwise it stops with an explicit compatibility error.

### Ordering and projections

The kernel guarantees a deterministic Mission-local order suitable for activity replay. It does not promise a globally ordered event stream across Missions. Derived Field/activity/discovery projections are rebuildable from events and aggregate records. Projection failure is visible through lag/error telemetry and may delay a view, but does not invalidate the committed domain transition.

## Command boundary

Clients, agents, and trusted server callers submit intent commands; they never patch arbitrary documents. Each command has authenticated principal context, correlation id, idempotency key, expected version for mutable targets, and minimal typed input.

| Command group | Representative commands | Required checks |
| --- | --- | --- |
| Mission | create, update metadata, change visibility, archive, restore, request deletion | Owner/policy, expected version, visibility/publication rules |
| Constitution | propose, approve, activate version | Owner or scoped approval policy; version lineage |
| Membership | invite, accept, revoke, change role/scope | Issuer authority, token validity, no privilege escalation |
| Room | create, update policy/layout, archive | Mission authority; room cannot broaden private access |
| Move | create, claim, reassign, transition, link dependency | Scope/role, state transition, no cycle, expected version |
| Call / Fracture | open, answer/assign, resolve/dismiss | Capability/scope, evidence/reason requirements |
| Artifact | create, draft version, submit proposal, approve/publish/archive | Content scope, immutable parent, publication policy |
| Branch | create, update comparison criteria, propose merge, merge, retire | Base reference, reviewer/owner authority, stale merge conflict |
| Proof | propose, verify, publish/retract | Evidence integrity, verifier role, publication policy |

Command handlers authenticate first, load only indexed records needed for policy, validate transition and input, reserve/reuse the operation receipt, mutate the aggregate, append event(s), and store result receipt in one transaction where possible. External side effects are not performed inside the command; they are triggered after durable intent commit and return through their own guarded command path.

## Query boundary

Queries are read-only, permission-checked, indexed, paginated where data can grow, and optimized for defined client views. They never infer authorization from a request-supplied user id or an Ably connection.

Initial query families:

- `missionBySlug` / `missionSummary` returns only public, unlisted-with-access, or member-visible fields.
- `fieldSnapshot(mission, viewport/semantic level)` returns bounded Room, Move, Call, Fracture, Artifact-head, and Pulse projection records; it is not an unbounded full graph read.
- `roomContext(room)` returns room-allowed objects and a cursor-paginated activity segment.
- `activity(mission, cursor)` returns permission-redacted events in stable indexed creation order.
- `artifactHistory(artifact, cursor)` returns visible immutable versions and lineage.
- `branchComparison(branch)` returns authorized source/target references and explicit conflict state.
- `myMemberships`, `myCalls`, and `myPendingReviews` are indexed by principal and state.

Every list endpoint has a stable pagination contract and a maximum result limit. Query return shapes exclude secret fields, raw invite tokens, hidden moderation data, private agent reasoning, and unapproved draft content.

## Authorization invariants

1. The server checks current durable identity, membership, object scope, and Constitution policy for every command and query.
2. Visibility follows `private` > `unlisted` > `public` only when explicitly transitioned. Public visibility never exposes private ancestors, comments, source evidence, or activity by default.
3. Room and Artifact policy can narrow Mission access; widening requires a publication command with the required owner/reviewer authority and event.
4. Accepting an invite grants exactly its approved role/scope/expiry. Reuse, expiry, revocation, and maximum uses are enforced atomically.
5. A revoked or expired membership loses access immediately for the next durable query/command; realtime disconnect is a best-effort consequence.
6. No actor can grant a role/capability they do not possess or bypass an Owner-only action through a Call, Branch, Artifact, or agent delegation.
7. Agents use the intersection of their agent template, current delegator grant, room/object scope, Constitution, and run envelope. Revocation prevents the next tool/command step.
8. All authorization failures are non-enumerating: callers cannot discover hidden Mission, room, or Artifact existence through error detail.

## Optimistic concurrency and idempotency

Mutable aggregates have a monotonically incremented `currentVersion`. Commands that alter a user-visible mutable aggregate provide the version they were based on. If it does not match, the command returns a typed conflict response containing safe current metadata and a resolution path; it never overwrites.

Each command also carries a stable idempotency key scoped at least to Mission + principal + command family. The kernel stores a command digest with `operationReceipts`:

- same key and digest + completed result => return original result/event references;
- same key + in-progress => return pending/retry-safe status;
- same key + different digest => reject as idempotency-key misuse;
- expired receipt => only safe for a new command when the caller uses a new key and fresh expected versions.

For merges and Artifact changes, the conflict result distinguishes a duplicate retry, a clean rebase/proposal possibility, and a manual review requirement. The first implementation must prefer an explicit proposal to an automatic content merge unless the artifact type has a tested merge strategy.

## Migration contract

- Schema changes are additive first: new fields are optional or have a deterministic default that is valid for all existing records.
- New indexes are deployed and observed before traffic is routed to new query paths.
- Data backfills run in bounded, resumable batches with a checkpoint and idempotency; no unbounded collection or one-shot full-table mutation.
- Writers accept old and new record shapes during a transition window. Readers tolerate absent optional fields and emit compatible projections.
- Tightening a field/policy happens only after backfill evidence and a staging/preview migration rehearsal.
- Every migration has a forward plan, abort condition, rollback or compensating-command plan, expected duration/cost, and readback verification.
- Event payload evolution is versioned; old events are never rewritten solely to simplify new code.

## Testable acceptance criteria

The Mission Kernel phase is not complete until the following evidence exists.

| Scenario | Required evidence |
| --- | --- |
| Solo end-to-end | A signed-in Owner creates a private Mission, Constitution, Room, Move, Artifact version, and Proof; refresh/readback preserves all state and replay explains each transition. |
| Two-person consistency | Two isolated sessions observe a claimed Move and Artifact version after durable mutation, refresh/reconnect, and activity replay. |
| Role isolation | Owner, Steward, Builder, Contributor, Observer, revoked user, and agent identities each pass a positive/negative server authorization matrix for all command/query families. |
| Invite safety | Expired, revoked, exhausted, and replayed invite tokens fail; accepted invite grants only the recorded scope and emits auditable events. |
| Visibility safety | Private Mission/room/artifact/event references are non-enumerable to outsiders; a public Proof exposes only deliberately published fields. |
| Concurrency | Two stale edits to a Move, Branch merge, and Artifact head result in one success plus a typed conflict/proposal; no silent overwrite or duplicate event. |
| Idempotency | Retrying an interrupted client command with the same key produces one aggregate transition/event and returns the original receipt. |
| Branch integrity | Branch creation captures a base reference; merge validates source/target versions and preserves lineage; a stale merge cannot apply. |
| Archive/recovery | Archive blocks ordinary writes and agent launch, preserves permitted reads, and restore produces a new event without resurrecting expired grants/runs. |
| Retention/migration | A pending deletion respects a hold; a representative additive schema migration/backfill is resumable, bounded, and verified by readback. |
| Performance | Representative Field and activity queries use declared indexes, pagination, bounded shapes, and remain within the Phase 3 1/10/50 load budget. |

## High-risk decisions requiring explicit sign-off

1. **Artifact content strategy.** The kernel supports immutable versions, but the initial content type and merge algorithm must be selected before collaborative editing. Do not promise generic live rich-text/code/media merging without specific, tested conflict semantics.
2. **Mission event ordering implementation.** The required deterministic Mission-local order must be implemented without creating a global or hot Mission counter that collapses at concurrent activity; demonstrate under load before declaring the kernel scalable.
3. **Deletion policy.** Recovery window, backup retention, legal-hold behavior, and tombstone content require product/privacy decisions before public launch.
4. **Authorization authority.** Convex Auth is the recommended initial integration but is not assumed here; the chosen identity provider must support immediate server-side revocation checks and stable principal mapping.
5. **Public proof boundary.** The exact redaction and publication model for Artifact lineage/evidence must be designed before discovery uses it as a network surface.
