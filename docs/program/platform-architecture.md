# Realworld platform and agent architecture

## Decision summary

Realworld is a **durable collaboration system with a live performance layer**.

- **Next.js on Vercel** renders the application, provides trusted web entry points, and never owns mission truth.
- **Convex** owns authoritative user-visible state, authorization, the append-only Mission Event Ledger, durable workflow checkpoints, and reactive reads.
- **Ably** carries only short-lived, high-frequency signals such as cursor positions, viewport, hover/selection, typing, audio-room state, and optimistic visual effects. It is disposable by design.
- The **agent control plane** creates, schedules, pauses, resumes, and audits agent runs. It is durable in Convex. An individual model call is an external action, never a durable process.
- The **OpenAI Agents SDK** is the preferred orchestration/trace/evaluation interface for agents that use OpenAI models and compatible providers. An explicit provider adapter isolates the OpenRouter + DeepSeek path so it can be verified and replaced without changing Mission semantics.

This keeps the Field exciting and fast while preserving the ability to replay why a Move, Artifact, Proof, or Fracture exists.

## System boundaries

```text
Browser
  Next.js UI ── durable reads/writes ──> Convex
      │                                  │
      └── ephemeral presence/cursors ──> Ably
                                         │
Vercel route handlers / trusted workers ─┼─> provider adapters -> OpenAI / OpenRouter
                                         │
                                         └─> durable events, checkpoints, artifacts
```

### Next.js and Vercel

Own the application shell, server-rendered route protection, static assets, UI composition, and narrowly scoped server endpoints where a browser must exchange a session for a short-lived third-party token. Do not use Vercel functions as the job queue, agent memory store, or source of authorization truth: their lifecycle is intentionally short and deployment-bound.

The browser reads authoritative state reactively from Convex. It writes intent through guarded Convex mutations. Vercel deployment previews use isolated Convex deployments and Ably environments; production credentials are never copied into preview deployments.

### Convex: the world ledger

Convex is the authoritative system of record. It owns:

- Missions, Constitutions, outcomes, Memberships, invitations, visibility, and permission policy references.
- Moves, dependencies, Calls, Fractures, Branches, Proof, and Artifact metadata/version lineage.
- `missionEvents`: immutable domain events used for audit, activity Pulse, replay, notifications, and derived projections.
- Agent definitions, delegation grants, run intents, checkpoints, tool-call receipts, approvals, cost accounting, and model/provider receipts.
- Read projections optimized for the Field, activity feed, room list, and discovery surfaces.

Every domain mutation performs authorization, validates its state transition, writes the aggregate change, and appends one or more immutable events in the same transaction. Event payloads store references, concise public summaries, evidence pointers, and hashes where useful; they do **not** store private model reasoning or raw provider credentials.

Events are append-only to application roles. Correction happens through a new superseding event, never mutation of history. Projection updates must be idempotent and recoverable by replay from a per-projector cursor.

### Ably: the live nervous system

Ably channel names are namespaced by environment, Mission, and room, for example `prod:mission:{missionId}:room:{roomId}:presence`. It may carry:

- presence join/leave/heartbeat;
- participant and agent cursor/viewport/focus;
- lightweight selection, drag ghost, typing, attention ping, and temporary animation signals;
- Surge readiness, countdown, and co-presence reactions;
- streamed **public operational** agent status (for example, `researching`, `awaiting_approval`, `artifact_ready`) keyed to a durable run id.

It may not carry durable edits, permission decisions, Artifact contents, approvals, authoritative membership, or final run outcome. A reconnect always rehydrates from Convex, then resubscribes to Ably. Messages have a schema version, sender id, monotonic client sequence, expiry/TTL, and size limit. The UI treats missing, late, duplicate, or out-of-order ephemeral messages as normal.

## Core durable models

Use small normalized aggregates with indexes for every read path; Field responses are purpose-built projections rather than an unbounded graph query.

| Aggregate | Essential fields | Notes |
| --- | --- | --- |
| `missions` | owner, visibility, lifecycle, constitution version, active branch | Root security and discovery boundary. |
| `memberships` | mission, principal, role, capability grants, state | One active membership per principal/Mission. |
| `rooms` | mission, kind, layout, access policy, active branch | A room is a spatial context, not a separate mission. |
| `moves` | mission, branch, owner/assignee, state, dependencies, version | State machine transition only. |
| `artifacts` / `artifactVersions` | scope, author, content pointer, lineage, status | Store blobs in managed storage; version metadata stays durable. |
| `missionEvents` | mission, aggregate ref, actor, type, idempotency key, public summary, evidence refs | Ordered per Mission by the immutable Convex creation cursor; legacy numeric sequences are read-only migration data. |
| `agentRuns` / `runSteps` | run intent, state, lease, checkpoint, budget, trace, provider receipt | A run is resumable and auditable. |
| `approvalRequests` | action digest, capability, approver, expiry, decision | Approval is a durable state transition. |
| `operationReceipts` | idempotency key, status, result/event refs, expiry | Deduplicates tool and client retries. |

**Identity.** A principal is a human user, service identity, or agent identity. Agents never impersonate a human: `actorPrincipalId`, `delegatedByPrincipalId`, and `runId` are all retained. Convex Auth is the initial recommended authentication path, with a thin local user profile keyed by the authenticated token identifier. If an alternative identity provider is selected, its verified subject maps to that same principal model.

**Authorization.** Roles give broad Mission access; capability grants constrain exact actions (for example `artifact.propose`, `move.claim`, `research.fetch`, `branch.create`). An agent gets the intersection of its template capabilities, its current delegation grant, the Mission Constitution, room/artifact policy, and its remaining budget. Revoking a membership or grant invalidates outstanding run leases before the next tool step.

## Mission event and state-transition contract

The command path is always:

1. Client or agent submits an intent with a stable idempotency key.
2. Convex loads authorization and current aggregate version.
3. A deterministic transition validator either rejects, creates an approval request, or commits a new state/version plus event(s).
4. Reactive projections update the UI; Ably may decorate the transition with an immediate ephemeral effect.
5. Any external side effect is scheduled only after the durable intent/event has committed.
6. The side effect records a receipt and submits its result through another guarded transition.

Use optimistic concurrency for normal aggregate updates. Mission events append independently and use the `by_mission` index, whose final Convex `_creationTime` field provides a stable order cursor without a shared Mission counter. Legacy `eventSequence` and `missionSequence` values remain optional migration data and are never written by new commands. This removes the Mission-row hot write point; real browser, network, and Ably load still require separate fifty-participant evidence.

## Agent runtime

### Roles

- **Steward:** Mission-scoped coordinator. It proposes next Moves, synthesizes status, exposes Fractures, and asks for authorization; it does not silently acquire broad powers.
- **Specialist:** Dynamically created for a bounded role (researcher, designer, builder, reviewer). It has an explicit task contract, tool allowlist, output schema, time/token/spend ceiling, and expiry.
- **Supervisor:** Deterministic control-plane logic, not a conversational persona. It enforces leases, budgets, retries, policy checks, and escalation.

### Lifecycle

```text
proposed -> queued -> leased -> running -> waiting_for_approval
                 |        |              |
                 v        v              v
              cancelled  paused <---- resume
                            |
                            v
              succeeded / failed / expired / budget_exhausted
```

1. A human or agent creates a durable `agentRun` with immutable intent, inputs/evidence references, provider preference, and budget envelope.
2. A scheduler claims it with a short lease. Lease renewal is conditional on run version and stopped on cancellation/revocation.
3. Each model invocation and tool execution is a checkpointed step. Before a side effect, the runtime obtains or reuses an `operationReceipt` keyed by `runId + stepId + operation`.
4. The run emits concise, safe status events. It persists structured observations, action summaries, evidence references, and output—not private chain-of-thought.
5. A high-impact action transitions to `waiting_for_approval`; approval includes a human-readable diff/effect summary and expires.
6. Completion creates or proposes versioned Artifacts/Move transitions through the same command path as humans.

Long-running work is a sequence of resumable activations. It can run in Convex actions/workflows or a narrowly scoped worker entry point, but the durable run state remains in Convex. No resident agent process is required for correctness.

### Provider and model adapter

Define a provider-neutral contract:

```ts
type ModelRunRequest = {
  runId: string; modelPolicy: string; messages: unknown[];
  tools: ToolDefinition[]; responseSchema?: unknown;
  maxOutputTokens: number; timeoutMs: number;
};
type ModelRunResult = {
  finish: "completed" | "tool_call" | "refused" | "failed";
  output: unknown; toolCalls: ToolCall[]; usage?: Usage;
  providerRequestId?: string; rawReceiptRef?: string;
};
```

The first adapter targets the OpenAI Agents SDK control-plane features (agent definition, tool schema, guardrails, tracing, eval harness) where compatible. A separate OpenRouter adapter selects an explicitly allowlisted DeepSeek model and validates: streaming behavior, function/tool calling, JSON/schema reliability, rate limits, usage accounting, and failure semantics. Until that verification is complete, DeepSeek is a **candidate provider**, not a guaranteed production routing path.

Provider selection is policy-based, not prompt-based: task class, sensitivity, availability, model capability, per-Mission budget, and user choice. Fallbacks only occur where tool/result semantics are compatible. Preserve provider/model/version and normalized usage on every run step so behavior can be replayed and audited.

## Concurrency, idempotency, and recovery

- Client mutations carry a request id; retried commands return the original receipt rather than duplicate events.
- Tool calls use a deterministic operation key and a durable `started`/`completed` receipt. If a worker dies after the side effect but before completion, reconciliation reads the provider/tool result by idempotency key where supported; otherwise it escalates rather than blindly retrying.
- A run lease makes at most one worker active per step. Expired leases are reclaimed only after a fencing-token/version check.
- Artifact writes are immutable versions. A stale update becomes a proposal or conflict, never silent overwrite.
- Presence is intentionally lossy; time out inactive entries client-side and never infer durable membership or completion from it.
- Failed projectors and notifications resume from cursor/checkpoint. They must tolerate duplicated events.

## Cost and abuse controls

Budget is enforced before each step at four levels: user, Mission, organization/workspace (when introduced), and global service. The ledger tracks estimated and provider-reported tokens/cost, tool costs, elapsed time, retry count, and model chosen.

- Default agents start with low per-run spend, max steps, max tool calls, and a wall-clock deadline.
- Higher-cost models/tools require an explicit Constitution policy or approval.
- Circuit breakers pause a provider/model after elevated errors, latency, malformed tool calls, or budget variance.
- Rate limits protect login, invitations, public Calls, agent launch, tool execution, and expensive reads.
- Public discovery is separated from execution authority; reputation never grants write power by itself.
- Prompt/tool inputs are treated as untrusted data. Tools use typed schemas, narrow capability checks, allowlisted egress, and output size limits.

## Observability and privacy

Every request/run gets a correlation id propagated through Vercel, Convex, Ably status events, and provider calls. Structured telemetry includes latency, error class, state transition, queue delay, lease outcome, provider/model, usage, budget decision, tool name, and safe event references.

Dashboards: Field realtime health, durable mutation failures, run queue/lease age, provider error/rate-limit rates, P50/P95 latency, token/spend burn, approval aging, and event projection lag. Alerts page the operator on abandoned leases, repeated duplicate-side-effect hazards, runaway spend, and failed event projections.

Keep prompt content, Artifact content, and provider raw responses out of broad logs. Store only the minimum needed for debugging under access control and retention policy. Never display private reasoning. User-visible agent histories show actions, concise rationale, evidence, confidence, outputs, and approvals.

Secrets live only in platform-managed environment configuration: Vercel for web runtime, Convex environment variables for Convex actions, and any dedicated worker environment if one is later introduced. They are separated by environment and provider, rotated, redacted from logs, and unavailable to browser bundles. No credential appears in source, events, Artifacts, or support exports.

## Failure modes and intended behavior

| Failure | User-visible behavior | Recovery |
| --- | --- | --- |
| Ably outage or lost messages | Field loses live decorations; durable work remains visible | Reconnect with backoff and rehydrate from Convex. |
| Convex mutation conflict | Clear retry/conflict state; no duplicate Move/Artifact | Idempotent receipt or explicit merge/proposal. |
| Agent worker stops | Run shows paused/recovering, never fake progress | Lease expires; next activation resumes checkpoint. |
| Provider timeout/rate limit | Status shows provider delay; no hidden retry storm | Bounded retry with jitter, then compatible fallback or human escalation. |
| Tool side effect ambiguous | Run is held for reconciliation | Read tool receipt/idempotency result; escalate if unknowable. |
| Budget exhausted | Agent pauses with remaining work visible | Human increases budget or closes/reassigns Move. |
| Permission revoked mid-run | Next tool attempt is denied | Lease invalidated; prior output retained as attributable draft. |
| Bad deployment | Preview catches it; production rollback restores UI | Schema changes are additive/migrated; event ledger remains intact. |

## Testing and delivery gates

### Automated suites

- Unit: transition validators, capability intersection, budget evaluator, provider normalization, idempotency keys, projection reducer.
- Integration: Convex authorization matrix; concurrent Move/Artifact mutation; run pause/resume; duplicate webhook/tool receipt; failed projector replay.
- Contract: provider adapters against recorded fixtures plus a controlled live DeepSeek tool-call smoke test before enabling production traffic.
- Browser: two signed-in browsers show durable changes; disconnect/reconnect; room entry; presence does not override durable state; approval and cancel paths.
- Load/chaos: fifty simulated people plus bounded agents; Ably loss/reorder; provider 429/5xx; lease expiry; Convex latency; budget breaker.
- Accessibility/security: keyboard-only Field alternative, reduced motion, screen-reader activity updates, tenant/visibility isolation, secret scanning, permission regression tests.

### Staged delivery

1. **Foundation:** authentication, environment isolation, typed schema/index plan, event envelope, observability skeleton, CI and preview gates.
2. **Solo Mission:** one human can create a Mission, Moves, Artifact versions, and replay activity with no Ably or autonomous execution dependency.
3. **Two-person live room:** add Ably presence/cursors and concurrent edit conflict paths; prove refresh/reconnect safety.
4. **Guarded Steward:** one bounded agent proposes a Move or Artifact draft with budgets, receipts, approval, cancellation, and resume.
5. **Provider qualification:** test the OpenRouter DeepSeek adapter under real tool calls, structured output, cost reporting, and outage behavior; keep feature-flagged until it meets the contract.
6. **1–50 scale:** Field projections, load test, role matrix, rate limits, operational dashboards, incident/rollback rehearsal.
7. **Network/public launch:** public Proof/Calls only after abuse, moderation, reputation, privacy, export, and deletion controls pass release gates.

## Open decisions to close before implementation

1. Which exact DeepSeek model and OpenRouter endpoint meet the tool-calling/structured-output contract? This requires a live qualification suite, not assumption.
2. Which agent-runtime operations are executed inside Convex actions/workflows versus a separately deployed worker? Decide from measured action limits, SDK/provider runtime compatibility, and tracing needs.
3. Is Convex Auth the confirmed initial user-auth choice? It is recommended for the first vertical slice, but the provider decision must be explicit.
4. What is the first Artifact content model (rich text, structured research, code workspace, or all via versioned generic blobs)? Start with one end-to-end type rather than a universal editor.
5. What are the concrete latency budgets for Field projection, durable mutation acknowledgement, cursor movement, and agent status? Set them before the fifty-participant load test.
