# Realworld Trust, Safety, Quality & Release Standard

This is the release standard for a living digital world with one to fifty human collaborators and autonomous agents. It applies to every phase and treats useful autonomy, clear consent, recoverability, and observable evidence as product features.

## 1. Control plane: identity, membership, and invitations

Convex is authoritative for identity bindings, Mission membership, role grants, visibility, and the append-only event ledger. Ably may carry short-lived presence and interaction signals only; it may never grant access or decide durable state.

### Roles and permission boundaries

| Role | May do without further approval | Requires owner approval | Never may do |
| --- | --- | --- | --- |
| Owner | Set Constitution, roles, public visibility, budgets, recovery policy | Transfer ownership; delete a Mission with retained artifacts | Bypass audit trail |
| Steward | Coordinate Moves, create Calls/Fractures, propose plans | Change Constitution, visibility, role grants, external integrations | Spend beyond envelope |
| Builder | Create/edit permitted Artifacts, claim and complete Moves | Publish public Proof, merge protected Branch, invite collaborators | Alter roles or hidden data |
| Contributor | Respond to Calls and propose Artifacts/Branches in granted scope | Claim protected Moves, publish or invite | Read private rooms/artifacts |
| Observer | View explicitly shared content | Comment, contribute, or invite | Access unpublished/private material |
| Agent | Execute only its typed tool envelope and active budget | Any external side effect, visibility change, membership/budget change, destructive operation | Self-grant access, impersonate, reveal secrets, override a human stop |

The creator is Owner. A Mission has explicit `private`, `unlisted`, or `public` visibility; default is private. Room-level and Artifact-level sharing can only narrow Mission access unless the Owner intentionally publishes a bounded public artifact. Every permission check is server-side and evaluated against the latest durable membership record.

### Invitations

- Invites are purpose-scoped: role, rooms, expiry, maximum uses, and whether the invitee can invite others.
- No public link grants Owner or Steward. Public links default to Observer or a narrowly scoped Contributor Call.
- Acceptance records the issuer, requested role, scope, expiry, and resulting membership event.
- Revocation immediately invalidates unused tokens, ends presence, cancels unstarted agent work authorized solely by that grant, and blocks further reads/writes after reconnect.
- Email/domain restrictions, rate limits, and invite abuse signals are configurable per Mission.

## 2. Agent autonomy that remains interruptible

An agent is a durable, resumable job with an identity; never an invisible background personality. Each activation receives a signed, typed envelope containing Mission/room/artifact scope, allowed tools, input references, token/cost ceiling, deadline, side-effect mode, and idempotency key.

### Autonomy levels

| Level | Allowed behavior | Human checkpoint |
| --- | --- | --- |
| Observe | Read allowed context; propose a plan | Before any write |
| Draft | Create private, versioned drafts and research | Before sharing outside its room |
| Execute | Perform reversible internal writes in scope | Before publish, merge, spend, or external action |
| Act externally | Prepare the request only | Explicit per-action approval, with final payload preview |

Defaults are Observe for a new agent and Draft for an owner-configured Steward. “Always approve” is limited to a named, narrow action class and expires. A single control is always visible in the Field and room: **pause**, **cancel**, **revoke tools**, and **require approval**. Cancellation is cooperative and then enforced at tool boundaries; it creates a terminal audit event rather than silently disappearing.

### Budgets, retries, and side effects

- Enforce per-run, daily Mission, and organization cost ceilings before model/provider calls; reserve estimated cost and reconcile actual cost.
- Limit activations, tool calls, concurrency, wall-clock time, output size, and branch depth. Detect repeated state hashes and tool cycles.
- Typed tools validate schema, authorization, and idempotency server-side. Every external action must use an idempotency key and a durable intent/outcome pair.
- Retried work reuses the original idempotency key; a resumed run starts from durable checkpoints and must not repeat confirmed side effects.
- Agents can write a concise operational trace: intent, sources, actions, artifacts, evidence, confidence, cost, and errors. Do not store or expose private chain-of-thought.

## 3. Auditability, truth, and recovery

Every meaningful transition produces a durable, immutable event with actor type/identity, effective permission, target, before/after version references, correlation ID, request origin, and outcome. Event bodies must be redacted or reference encrypted/private content rather than include secrets.

- Artifacts, Moves, Branches, merges, permissions, approvals, model/tool invocations, exports, and moderation actions are traceable from the Field to their source events.
- The user interface shows a human-readable replay, diff, and “why this changed” evidence—not hidden reasoning.
- Soft-delete first. Destructive actions require confirmation, preserve a recoverable version for a stated retention period, and emit a restoration path.
- Merge and publish are optimistic-concurrency operations: stale clients receive a conflict, never a silent overwrite.
- An Owner can export Mission data and audit history. Deletion requests use a documented retention and legal-hold policy; backups are cryptographically protected and expire on schedule.

## 4. Abuse, content safety, and prompt-injection defenses

Treat all content—Artifacts, web results, files, comments, agent outputs, tool responses, and participant names—as untrusted input. Retrieval is context, not instruction.

### Defenses

- Separate system/developer instructions, user goals, retrieved content, and tool results in the agent runtime. Retrieved text cannot alter tool policy, identity, budget, or approval requirements.
- Use allowlisted tools with minimal scopes; never expose raw credentials, browser cookies, environment variables, or broad file/network access to a model.
- Require structured tool calls; validate parameters against schemas and policy before execution. Render untrusted text safely and isolate third-party embeds.
- Scan uploads and links, restrict executable content, enforce file size/type limits, and quarantine suspicious material.
- Rate-limit signup, invitations, Calls, comments, agent activations, exports, and public publishing by account, Mission, IP/device risk, and reputation signals.
- Provide report, block, mute, quarantine, and appeal flows. Escalation actions have separate moderator roles and immutable justification events.
- Detect spam/fake Proof, reputation farming, coordinated invite abuse, impersonation, and anomalous agent spend. Reputation weights verified, attributable output rather than engagement volume.
- Run adversarial suites for instruction override, data exfiltration, confused-deputy access, malicious artifact content, cross-Mission leakage, and tool-loop cost attacks before enabling a new agent/tool class.

## 5. Privacy and data handling

Data minimization is the default: collect only account, Mission, and telemetry data necessary to operate the product. Private Mission content is excluded from discovery, model-training use, and cross-Mission retrieval unless an Owner opts in to a separately explained program.

- Encrypt data in transit and at rest; use least-privilege service identities and rotation for provider keys.
- Do not send private content to a model/provider unless the active agent envelope authorizes that source and provider route. Provider/model, purpose, and data classes are recorded in the run trace.
- Separate production, preview, and test data. Test environments use synthetic or explicitly consented fixtures; previews receive no production secrets.
- Set retention windows for presence events, logs, model traces, backups, and deleted data. Logs redact tokens, credentials, payment data, and sensitive text by default.
- Support access, export, correction, and deletion workflows appropriate to launch regions before inviting public users.

## 6. Realtime resilience and performance targets (1–50 people)

Performance is judged on a representative Mission: 50 concurrent humans, 20 active agents, 500 visible Field entities, active presence/cursors, and concurrent artifact edits. Test both healthy and degraded network paths.

| Measure | Target | Failure behavior |
| --- | --- | --- |
| Local Field input response | p95 under 50 ms | Preserve local interaction; reconcile async |
| Presence/cursor fan-out | p95 under 250 ms | Degrade to participant count/last-active markers |
| Durable mutation acknowledgement | p95 under 750 ms | Clear pending state; retry idempotently |
| Room/Field initial usable view | p75 under 2.5 s on broadband | Skeleton plus prioritized visible region |
| Reconnect after transient loss | usable under 5 s | Resubscribe, replay missed durable events, deduplicate |
| Agent status update | p95 under 1 s once emitted | Show last known state and timestamp |
| Error rate during load scenario | under 0.5% non-user-caused requests | Shed nonessential presence before durable writes |

Presence is lossy and TTL-bound. The client batches pointer updates, respects reduced motion, and stops sending when backgrounded. Durable operations use ordered version/cursor reconciliation and idempotency. Capacity alerts trigger before provider quotas or cost ceilings, with defined load shedding: animations and high-frequency cursors first, then optional discovery, never authorization/audit or confirmed writes.

## 7. Quality strategy and evidence taxonomy

The quality bar is a pyramid with a mandatory real-world top layer. “Green CI” alone is never a release claim.

1. **Static and unit:** typecheck, lint, schema validation, permission predicates, reducers, agent policy/budget logic, accessibility primitives.
2. **Integration:** Convex queries/mutations/actions, authorization matrix, event replay, idempotency, provider adapters, webhooks, rate limits, migrations, error boundaries.
3. **Contract and adversarial:** tool schemas, model-provider failure modes, prompt injection, authorization bypass attempts, malformed realtime events, cost/runaway limits.
4. **Browser interaction:** keyboard, pointer, touch, reduced motion, mobile/desktop, reconnect, collaborative edits, public/private discovery, approval and recovery journeys.
5. **Multi-user system:** at least two real isolated browser sessions for every changed collaboration/role flow; scheduled 1/10/50 participant simulations for Field and realtime paths.
6. **Release rehearsal:** preview deployment, migration/rollback, incident drill, backup restore evidence, accessibility review, and production-like smoke test.

Every ledger entry declares the strongest evidence actually collected:

| Label | Meaning |
| --- | --- |
| `A` | Automated check executed and passed |
| `S` | Source/configuration review only |
| `R` | Render/reachability observed |
| `I` | Real browser interaction completed |
| `Role` | Tested with distinct effective roles/sessions |
| `P` | Persistent state survived refresh/reconnect/readback |
| `L` | Load/failure scenario executed |

Record gaps explicitly. Preview evidence does not imply production evidence; simulations do not substitute for two real browser users.

## 8. Accessibility and inclusive operation

The spatial Field has a first-class synchronized list/tree alternative. Nothing critical depends on color, hover, drag, motion, or a high-precision pointer.

- Full keyboard operation, visible focus, logical tab order, shortcuts with discoverable alternatives, and screen-reader labels/live updates that do not flood announcements.
- Semantic zoom has accessible structural navigation; a user can create, claim, branch, approve, pause, and recover work without the canvas.
- Respect reduced-motion, contrast, font scaling, localization, time-zone, and latency needs. Presence and agent motion can be simplified without losing meaning.
- Automated axe-style checks cover changed surfaces, followed by keyboard-only and screen-reader browser checks for primary journeys before release.

## 9. Deployment, rollback, and release gates

Environments are local, preview, staging, and production with distinct credentials and allowlists. Vercel previews are tied to reviewed commits; Convex schema/data migrations are forward-compatible first and have a tested rollback/compensation plan. Feature flags and kill switches gate new realtime transports, agent tools, model routes, discovery visibility, and costly actions.

### Required gates

| Gate | Required evidence | Owner |
| --- | --- | --- |
| Code integrity | Review, typecheck, lint, unit/integration checks, dependency/secrets scan | Engineering |
| Trust | Role matrix, invite/revoke, audit trace, abuse/prompt-injection suite, data-flow review | Trust/Safety |
| Collaboration | Two-session browser journey, reconnect/conflict checks, persistent readback | Product/QA |
| Experience | Responsive visual review against approved concept, keyboard/screen-reader/reduced-motion checks | Design/QA |
| Realtime | 1/10/50 load scenario, quotas/cost alerts, degraded-mode verification | Platform |
| Recovery | Preview migration, rollback/kill-switch drill, backup restore/readback | Platform/SRE |
| Launch | Privacy/support/moderation readiness, incident owner, metrics dashboard, explicit go/no-go record | Product owner |

Production release requires all relevant gates passing or a time-bounded, named-risk exception approved by the Owner. No deployment changes paid infrastructure or exposes public access until the release record is complete.

### Incident and recovery posture

- Severity rubric, on-call/owner, customer communication path, and evidence-preserving incident log exist before public launch.
- Immediate actions: pause agents, revoke tool grants, disable public publishing/invites, or switch off ephemeral transport independently.
- Reversal order: stop harm, preserve audit evidence, restore permission boundaries, compensate durable side effects, then repair state from tested backups/event replay.
- Run quarterly failure drills once production use begins: provider outage, malformed realtime flood, compromised invite, runaway agent, failed migration, and accidental deletion.

## Phase exit criteria owned by this team

- **Foundation:** authorization, environment separation, observability, test infrastructure, and release evidence labels are present.
- **Mission kernel / Field:** real two-user role and reconnect tests; keyboard/list alternative; 1/10/50 load evidence.
- **Agent runtime:** all tools/envelopes/budgets/audit/recovery tests pass, including adversarial injection and duplicate-side-effect scenarios.
- **Discovery / world systems:** abuse controls, moderation, public/private boundaries, and anti-farming checks pass.
- **Operational maturity:** staged rollout, rollback drill, restore drill, security/privacy review, and release matrix are recorded in `BUILD_LEDGER.md`.
