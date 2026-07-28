# Realworld Build Ledger

This ledger is the durable project-management source of truth. A phase is complete only when its exit gates are satisfied and evidence is recorded here.

## Phase 0 — Constitution and visual language

Status: complete

Deliverables:

- Product constitution and product language
- Network-effect and fun-system specification: `docs/program/world-network-system.md`
- Architecture boundaries and initial decision record: `docs/program/platform-architecture.md`
- Trust, quality, and release contract: `docs/program/trust-quality-release.md`
- Three complete visual directions for the primary Mission Field
- Selected direction translated into design tokens and interaction rules

Completion evidence:

- Founder direction confirmed in-product as a Living Atlas hybrid made of navigable, customizable rooms rather than a fixed dashboard.
- Solo-to-fifty, network, game-system, realtime ownership, agent-autonomy, trust, and release contracts are recorded in `docs/program/`.
- Customizable-canvas implementation commit `ddfacd3` translates the direction into direct manipulation, keyboard movement, zoom/fit, layout locking, room lifecycle controls, saved preferences, an accessible list alternative, and a deliberate icon system.

Design gate:

- Selected base: Living Atlas
- Proposed production revision: `design/concepts/living-atlas-realtime-hybrid.png`
- Proposed world-map extension: `design/concepts/mission-world-map.png`
- Revision intent: Google Docs-level live presence and co-editing clarity combined with cooperative-game immediacy, shared momentum, Surge focus, tactile manipulation, and meaningful environmental feedback
- Approval: confirmed through the founder's Living Atlas hybrid, room-map, and customizable-canvas direction

Exit gates:

- The solo-to-50-person loop is specified
- Durable and ephemeral realtime ownership is unambiguous
- Agent autonomy, budgets, permissions, and interruption are specified
- One visual direction is explicitly approved

## Phase 1 — Production foundation

Status: in progress

Deliverables:

- Next.js application foundation: commit `a9679c0`
- Production-quality customizable-canvas design system: commit `ddfacd3`; lint, typecheck, and production build passed locally
- Convex schema, indexes, guarded Mission functions, and private-alpha password authentication: local deployment push passed on 2026-07-27
- Durable Mission launch templates, scoped hashed invitations, and Convex-authoritative versioned room layouts: commits `8c7d594` and `dcdc19c`; local Convex push, Convex typecheck, and nine focused authorization/idempotency/concurrency tests passed
- Authenticated reactive Mission projection and stabilized launch flow: commits `51c86cf` and `23b6172`; new accounts reach the template launcher, create a durable Mission, and render its title and membership role
- Secure owner invitation and acceptance flow: commits `04f0483`, `c2543b4`, and `eec1dae`; raw tokens remain client-held, Convex stores token hashes, working roles and room scopes are enforced, and a second authenticated browser context retains contributor membership after reload
- Durable customizable Mission canvas: commits `04c9e66` and `2149261`; room query, create, rename, archive, and OCC layout updates are Mission-scoped Convex state with corrected room events and atomic Mission event sequencing, while density, accent, zoom, pan, and layout lock remain per-person presentation preferences
- Scoped reactive collaboration proof: commits `e90d1ee` and `92f1893`; room discovery is deny-by-default outside durable membership scope, and a second authenticated browser observes an authorized Workshop move without reload and retains it after reload
- Concurrent recovery and role-boundary proof: commits `44d944b` and `e350642`; the automated matrix covers nine actor states across Mission, invitation, and room boundaries, while a real owner/builder race surfaces an OCC conflict, converges both open clients to Convex authority, and survives reload
- Local browser authentication evidence: synthetic account creation, sign-out, sign-in, and protected Mission World restoration passed on 2026-07-27
- Cloud Convex deployment and cloud authentication remain unverified; password auth is a private-alpha bridge, not the final passkey decision
- Vercel preview: `https://realworld-4r7u1kand-mosnins-projects.vercel.app` built successfully from commit `f7d4230`; GitHub repository connected
- Test, lint, typecheck, accessibility, and browser-test infrastructure: foundation passing locally in commit `a9679c0`
- Truthful authenticated CI gate: commit `6d66216`; GitHub Actions run `30318024140` passed install, lint, typecheck, unit tests, Convex tests, production build, seven authenticated Chromium journeys, and foundation evidence on 2026-07-27
- Durable two-participant CI gate: commit `63101ad`; GitHub Actions run `30318560377` passed install, lint, typecheck, 13 Vitest tests, Convex validation, production build, eight authenticated Chromium journeys, and foundation evidence on 2026-07-27
- Durable canvas and mobile CI gate: commit `a6c70c4`; GitHub Actions run `30319454840` passed install, lint, typecheck, 14 Vitest tests, Convex validation, production build, nine authenticated Chromium journeys, and foundation evidence on 2026-07-27
- Scoped reactive canvas CI gate: commit `77e8b8e`; GitHub Actions run `30320163658` passed install, lint, typecheck, 15 Vitest tests, Convex validation, production build, nine authenticated Chromium journeys with live scoped cross-context movement, and foundation evidence on 2026-07-27
- Conflict-recovery and role-matrix CI gate: commit `1a120e2`; GitHub Actions run `30320832450` passed install, lint, typecheck, 16 Vitest tests, Convex validation, production build, ten authenticated Chromium journeys with concurrent OCC convergence, and foundation evidence on 2026-07-27
- Mission lifecycle and reconnect CI gate: commit `916ca42`; GitHub Actions run `30321896429` passed install, lint, typecheck, 21 automated tests, Convex validation, production build, twelve authenticated Chromium journeys, and foundation evidence on 2026-07-27. Evidence includes owner edit/archive/restore, an explicit archived read-only world, mutation freeze, membership expiry, replay-safe idempotency, mobile interaction, and true offline-to-online convergence.
- Local multi-Mission and Constitution gate: commits `90f4d11`, `4b4810c`, `6792212`, `2c1d1f8`, `5a64c28`, and `01e9383`; lint, typecheck, 27 automated tests, Convex validation, production build, and thirteen authenticated Chromium journeys passed on 2026-07-27. Evidence includes durable Constitution/outcomes with OCC and replay, exact room-scope write grants, stable Mission selection, in-world second-Mission launch, reload persistence, and archive/switch isolation. Hosted CI confirmation is pending.
- Observability, error boundaries, structured logs, and environment validation: shell error boundaries and safe environment-name validation started in commit `a9679c0`

Evidence boundary:

- The current Mission World and Workshop still use fixture content for occupants, activity, and artifacts. Room identity, titles, lifecycle, and coordinates are now durable Convex state; presentation preferences and layout lock intentionally remain personal and browser-local.
- The authenticated Mission title, membership role, invitation issuance, invitation acceptance, room lifecycle, layout persistence, scoped visibility, cross-browser reactive movement, and concurrent conflict recovery are real local Convex evidence. They do not prove cloud deployment, Ably presence, exhaustive role coverage, agent runtime, disaster recovery, load, or production readiness.
- Overall production capability remains below one percent until the same flows pass against the connected cloud backend and current preview.
- Thirteen browser journeys pass locally against an ephemeral Convex deployment with real private-alpha account creation, including real multi-Mission creation/selection/reload/archive, mobile room entry, durable Mission lifecycle, archived read-only controls, deny-by-default scoped discovery, live two-context movement, a concurrent owner/builder OCC race with visible recovery, and a true browser disconnect/reconnect cycle. The prior twelve-journey slice passes GitHub Actions run `30321896429`; hosted confirmation of the new slice is pending.

Exit gates:

- Signed-in user reaches a responsive authenticated shell
- Preview deployment is reproducible
- Authorization boundaries have automated coverage
- CI and production build pass

Current gate status:

- CI and production build: passed in GitHub Actions run `30321896429`
- Signed-in responsive shell: passed with local ephemeral Convex Auth
- Authorization boundaries: twenty-seven automated tests pass across Mission, Constitution, membership, invitation, room scopes, lifecycle, expiry, and idempotency behavior
- Reproducible current preview and connected cloud Convex state: still open

## Phase 2 — Mission kernel

Status: pending

Deliverables:

- Create, edit, archive, and restore Missions
- Mission Constitution and desired outcomes
- Memberships, roles, invitations, and visibility
- Event ledger and replayable state transitions
- Moves, dependencies, Calls, Fractures, Proof, and activity Pulse

Exit gates:

- One user can manage a real Mission end to end
- Two users observe consistent shared state
- State history survives refresh, reconnect, and concurrent edits

## Phase 3 — Living Field

Status: pending

Deliverables:

- Spatial Mission Field with semantic zoom
- Direct manipulation, keyboard navigation, and accessible list alternative
- Presence, cursors, selections, focus, and Surge mode
- Branch creation, comparison, and merge interaction
- Performance budgets for fifty concurrent humans and active agents

Exit gates:

- Primary Field workflow passes desktop and mobile interaction checks
- Fifty simulated participants remain within performance budgets
- Reduced-motion and keyboard-only experiences remain complete

## Phase 4 — Agent runtime

Status: pending

Deliverables:

- Steward and dynamically created specialist agents
- OpenRouter model adapter with a verified DeepSeek tool-calling route
- Typed tools, permission envelopes, budgets, retries, and idempotency
- Durable resumable workflows and human approval interruptions
- Operational status streaming without private chain-of-thought

Exit gates:

- Agents create real versioned Artifacts
- Interrupted runs resume without duplicate side effects
- Every action is attributable, bounded, and replayable
- Cost and runaway-loop controls have adversarial tests

## Phase 5 — Artifact studio

Status: pending

Deliverables:

- Collaborative documents, structured research, code, and media artifacts
- Versioning, comments, proposals, diffs, and merge workflows
- Artifact relationships and reusable capability extraction
- Search and context retrieval across Mission memory

Exit gates:

- A mixed human-agent team completes and publishes a substantive digital project
- Artifact lineage and permissions remain intact across branches

## Phase 6 — Discovery and network

Status: pending

Deliverables:

- Public Mission and Proof discovery
- Join, contribute, follow, sponsor, fork, and connect flows
- Calls marketplace based on specific needs and capabilities
- Participant, agent, and Mission reputation grounded in verified contribution
- Notifications, digests, and re-entry experiences

Exit gates:

- A new user can find and make a useful contribution without prior relationships
- Growth loops resist spam, fake work, and reputation farming

## Phase 7 — Fun and world systems

Status: pending

Deliverables:

- Momentum, scarcity, surprise, stakes, and shared rituals
- Surge experiences and live collaborative events
- Seasonal world events that create meaningful cross-Mission opportunities
- Progression based on demonstrated capability, not engagement bait

Exit gates:

- Repeated moderated playtests show voluntary return and invitation behavior
- Fun systems improve output instead of distracting from it

## Phase 8 — Operational maturity

Status: pending

Deliverables:

- Security review, abuse controls, moderation, privacy, export, and deletion
- Load, failure, recovery, and disaster-recovery testing
- Cost dashboards, quotas, rate limits, and provider fallbacks
- Production readiness and staged public rollout

Exit gates:

- Release matrix passes automated, source, render, interaction, role, and persistent-state evidence
- Rollback, incident response, and data recovery are rehearsed
