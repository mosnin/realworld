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
- Multi-Mission and Constitution CI gate: commit `f8cfba2`; GitHub Actions run `30322672825` passed install, lint, typecheck, 27 automated tests, Convex validation, production build, thirteen authenticated Chromium journeys, and foundation evidence on 2026-07-27. Evidence includes durable Constitution/outcomes with OCC and replay, exact room-scope write grants, stable Mission selection, in-world second-Mission launch, reload persistence, and archive/switch isolation.
- Constitution UI, Move kernel, and fifty-participant simulation CI gate: commit `3e20870`; GitHub Actions run `30323307089` passed install, lint, typecheck, 32 automated tests, Convex validation, production build, fourteen authenticated Chromium journeys, and foundation evidence on 2026-07-27. Evidence includes an owner Constitution lifecycle with two intentional saves and archive/restore persistence; scoped Move list/create/update/dependencies/transitions with OCC, receipts, event ordering, and archive freeze; plus 50 concurrent local Convex reads and eight isolated layout updates. The 50-participant check is deterministic local authorization/concurrency evidence, not browser, network, Ably, or production load evidence.
- Authenticated Move-board release gate: commits `4ec39a6`, `d9630ec`, `38d032d`, and `1b9f89b`; GitHub Actions run `30324498552` passed install, lint, typecheck, 36 automated tests, 35 Convex-focused tests, Convex validation, production build, fifteen authenticated Chromium journeys, and foundation evidence on 2026-07-27. The selected Mission exposes room-scoped Move creation, title and intent editing, dependency selection, valid lifecycle transitions, pointer and keyboard activation, reactive state, and reload persistence. The final interaction fix raises the Move dialog above world chrome and proves lower-card pointer controls without forced clicks.
- Call-kernel and adversarial dependency release gate: commits `cb1c49d` and `cf60ea0`; GitHub Actions run `30324958122` passed install, lint, typecheck, 44 automated tests, 43 Convex-focused tests, Convex validation, production build, fifteen authenticated Chromium journeys, and foundation evidence on 2026-07-27. The durable Call slice supports scoped list/create/update/status transitions, optional visible Move linkage, active-room and active-Mission validation, authoritative Mission events, OCC, archive freeze, and replay-safe receipts. Move dependency coverage now includes self and multi-node cycles, hidden-room probing, cross-Mission references, terminal dependency states, stale writes, and post-archive replay.
- Room-anchored Call interaction release gate: commits `a1a4152`, `1724ef9`, `50e29b4`, `ea817b2`, `b59539d`, and `b645c76`; GitHub Actions run `30326053820` passed install, lint, typecheck, 46 automated tests, 45 Convex-focused tests, Convex validation, production build, sixteen authenticated Chromium journeys, and foundation evidence on 2026-07-27. The inert Call fixture is replaced by reactive beacons anchored to durable Rooms, a portaled accessible composer/details surface, same-room Move linkage, edit and lifecycle controls, pointer and keyboard paths, reload persistence, terminal and archived read-only details, and a visible mobile close control. Local in-app browser checks at desktop and 390×844 compared the beacon, focused dialog, hierarchy, palette, container model, responsive behavior, and interaction states to the approved Living Atlas Call motif; no app console errors were observed.
- Durable Call-participation release gate: commit `ee026b6`; GitHub Actions run `30326912024` passed install, lint, typecheck, 51 automated tests, 50 Convex-focused tests, Convex validation, production build, sixteen authenticated Chromium journeys, and foundation evidence on 2026-07-27. Calls now have a Convex-authoritative 1–50 participant contract, atomic joined counts, per-principal join/withdraw/response records, attributable versioned responses, stable principal-bound replay receipts, owner/steward/creator administration boundaries, reviewer/contributor participation, observer denial, room-history locks, terminal and archive freezes, rejoin cleanup, and a concurrent 51-attempt capacity test that admits exactly 50. This is durable kernel evidence, not a participant UI, two-browser collaboration, Ably, network, or production-load claim.
- Reactive Call-participation canvas release gate: commits `734b5dc` and `a907a9a`; GitHub Actions run `30327851754` passed install, lint, typecheck, 51 automated tests, 50 Convex-focused tests, Convex validation, production build, seventeen authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. Calls now expose capacity, a privacy-safe participant roster, Join, Withdraw, and versioned response controls in the spatial canvas. A real owner/contributor browser pair observes capacity and response changes reactively without reload, preserves rejoin ability across reload, and retains participant history after owner resolution. Keyboard focus is trapped and restored without refocusing the editor during async transitions. Local in-app browser checks at desktop and 390×844 compared room anchoring, hierarchy, palette, focused-container behavior, capacity state, and responsive layout to the approved Living Atlas Call motif; no app console warnings or errors were observed. This is local ephemeral Convex and hosted ephemeral-CI evidence, not cloud preview, Ably, real-network, or production-load evidence.
- Durable Fracture recovery release gate: commit `6db184f`; GitHub Actions run `30328926086` passed install, lint, typecheck, 55 automated tests, 54 Convex-focused tests, Convex validation, production build, eighteen authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. The inert Fracture fixture is replaced by room-anchored, reactive Fractures with severity, reporter attribution, optional same-room Move linkage, edit and lifecycle controls, OCC, replay-safe receipts, Mission events, archive freeze, role and room-scope enforcement, terminal history, and reopen recovery. Mission Momentum now derives its active-Fracture count from Convex. A stale browser-local Mission selection is validated against the signed-in user's actual Mission list before restoration, preventing cross-account selection traps. Local in-app browser checks at the approved 1488×1057 reference size and 390×844 verified the spatial beacon, focused dialog, close control, scrollable mobile layout, palette, hierarchy, and zero client console warnings or errors. This is local ephemeral Convex and hosted ephemeral-CI evidence, not cloud preview, Ably, real-network, or production-load evidence.
- Durable Proof verification release gate: commit `f5132c7`; GitHub Actions run `30329956746` passed install, lint, typecheck, 58 automated tests, 57 Convex-focused tests, Convex validation, production build, nineteen authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. The inert Proof fixture is replaced by room-anchored, reactive Proofs with attributable claims and evidence notes, optional same-room Move linkage, submitter editing, reviewer verification/rejection, explicit resubmission, verified immutability, OCC, replay-safe receipts, Mission events, archive freeze, bounded privacy-safe projections, and role/room-scope enforcement. Focused adversarial checks cover reviewer and observer creation denial, hidden-room list/create/review probes, cross-room and cross-Mission linkage, stale writes, verified terminal state, verifier attribution, rejected attribution clearing, archived rooms, and post-archive replay/freeze. The browser journey creates a Workshop Move, submits and edits its Proof, drives reject/resubmit/verify by keyboard, reloads verified history, and confirms archived read-only behavior. Local in-app browser checks at the approved 1488×1057 reference size and 390×844 verified the spatial beacon, focused verification surface, close control, readable evidence hierarchy, responsive scroll behavior, and zero client console warnings or errors. The Living Atlas concept remains the structural direction rather than a claim of pixel-identical final art; cloud preview, Ably, real-network, and production-load evidence remain open.
- Durable Mission activity Pulse release gate: commit `b2892b6`; GitHub Actions run `30331021509` passed install, lint, typecheck, 60 automated tests, 59 Convex-focused tests, Convex validation, production build, twenty authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. Pulse is now a bounded, newest-first read model over the authoritative Mission event ledger with immutable event-time room scope, privacy-safe actor display attribution and type, role context, room title, archived-history readability, exact-room filtering, and deny-by-default Mission and room scope. Legacy room-family events without immutable room scope fail closed. The fixed Living Atlas route replaces the fabricated `25 people in world` rail and decorative static waveform with expandable durable activity, explicit loading/empty states, keyboard activation, and a clear boundary that Pulse is not live presence. The browser journey creates a real Workshop Move, opens Pulse by keyboard, verifies actor and room context, reloads the history, archives the Mission, and confirms the event remains readable. Local in-app browser review confirmed the compact route and responsive world composition with no client warnings or errors; the automated phone journey covers 390×844 behavior. This is local ephemeral Convex and hosted ephemeral-CI evidence, not Ably presence, cloud-preview collaboration, real-network, or production-load evidence.
- Durable Call coordination-history release gate: commit `bdeff2f`; GitHub Actions run `30331844498` passed install, lint, typecheck, 62 automated tests, 61 Convex-focused tests, Convex validation, production build, twenty authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. Calls now support optional durable deadlines, spatial due/overdue state, append-only event-linked response revisions, a bounded newest-first privacy-safe history projection, required immutable resolution summaries, and resolved timestamps. Replay does not duplicate history; stale writes, invalid deadlines and bounds, hidden-room and observer probes, cancellation-summary misuse, terminal mutation, and archive freeze are covered. A real owner/contributor browser pair creates a deadline-bearing Workshop Call, records multiple response revisions reactively, resolves only after a keyboard-entered summary, reloads the durable history, and confirms archived read-only persistence. This is local ephemeral Convex and hosted ephemeral-CI evidence, not Ably presence, cloud-preview collaboration, real-network, or production-load evidence.
- Contention-free Mission event-ordering release gate: commit `9aed3d6`; GitHub Actions run `30332687393` passed install, lint, typecheck, 63 automated tests, 62 Convex-focused tests, Convex validation, production build, twenty authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. Every active Mission event producer now appends independently without reading, incrementing, or patching a shared Mission counter. Canonical Mission ordering uses Convex's `by_mission` index and immutable `_creationTime` tie-breaker; legacy `eventSequence`, `missionSequence`, and sequence indexes remain optional read-only migration data. Pulse no longer exposes the retired counter, keeps deterministic newest-first ordering, scopes every event carrying `roomId`, and fails closed for known legacy room-family events missing immutable room scope. A regression runs fifty concurrent same-Mission Move writes, proves distinct event records and replay uniqueness without a counter update, verifies stable repeated Pulse order including identical application timestamps, and retains room, archive, observer, and cross-Mission defenses. This is local concurrency and hosted ephemeral-CI evidence, not real browser, network, Ably, cloud-database, or production load evidence.
- Guarded Ably TokenRequest release gate: commit `f77bace`; GitHub Actions run `30333620252` passed install, lint, typecheck, 67 automated tests, Convex validation, production build, twenty authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. A Convex action now derives identity from Convex Auth, revalidates the active human Mission membership and exact room scope server-side, and signs five-minute, environment-namespaced Ably TokenRequests with least-privilege capabilities and grant-version-rotating pseudonymous client ids. Unknown, disabled, revoked, expired, anomalous agent-role, hidden/wrong/archived room, archived Mission, missing/malformed key, missing environment, and production requests fail closed. Production issuance is unconditionally disabled. Tests use a synthetic local signing key; no Ably application, real credential, provider request, connection, presence session, network recovery, or load evidence exists.
- Provider-independent realtime room-session release gate: commit `7682d77`; GitHub Actions run `30334992465` passed install, lint, typecheck, 80 automated tests, Convex validation, production build, twenty authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. The offline kernel owns one ephemeral Mission/room scope, refreshes before token expiry, clears transient state on authorization-version and scope changes, rejects stale epochs/sequences, duplicate, malformed, future-issued, expired, over-TTL, oversized, cyclic, and cross-scope messages inbound and outbound, expires accepted signals on injected-clock visibility deadlines, isolates same-principal tabs, bounds jittered reconnect attempts, detaches on authorization failure, and safely ignores stale in-flight scope completions. It has no Convex writes, Ably connection, environment access, or UI integration.
- Strict realtime protocol and development Ably-adapter release gate: commit `0235a00`; GitHub Actions run `30336280506` passed install, lint, typecheck, 88 automated tests, Convex validation, production build, twenty authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. Fifteen public signal kinds now have strict bounded payload schemas and exact world, presence, interaction, Surge, or subscribe-only agent-status routing. Unknown kinds, extra fields, malformed generic envelopes, expired/future/over-TTL messages, oversized payloads, wrong scope/family, overbroad capabilities, duplicate operations, missing presence identity, and agent-status publication fail closed at both the session and exported adapter boundaries. The adapter is lazy, development/test/preview-only, waits for readiness, handles presence enter/update/leave, preserves startup failures, and performs idempotent unsubscribe/detach/close cleanup. All adapter tests use an injected fake client and clock: no Ably credential, provider request, real connection, live presence, token exchange, environment-secret read, Convex write, browser integration, or production-enable claim exists.
- Realtime signal-governance and privacy-telemetry release gate: commit `b94716f`; GitHub Actions run `30337692341` passed install, lint, typecheck, 97 automated tests, Convex validation, production build, twenty authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. Every public signal kind has a conservative token-bucket budget with bounded bursts, deterministic refill/retry behavior, authenticated-client aggregation, scope/kind isolation, hard bucket cardinality, and LRU idle eviction. Provider-authenticated inbound identities and TokenRequest-bound outbound identities must match their envelopes; rotating client-instance ids cannot reset a budget. Rate denials remain nonfatal flow control rather than connection failures. Receiver message-id and sender-stream caches are hard-bounded with TTL recovery and sequence cleanup. Disabled-by-default telemetry rebuilds only allowlisted classifications and bounded measurements, strips payloads, identifiers, scopes, tokens, capabilities, and provider error text, and cannot break product flow even with a hostile getter or failing sink. This remains deterministic fake-clock/fake-client evidence: no credentialed Ably request, connection, presence session, browser integration, provider telemetry sink, network recovery, or load/fan-out claim exists.
- Browser lifecycle and visibility-policy release gate: commit `cdc1cc2`; GitHub Actions run `30338939551` passed install, lint, typecheck, 104 automated tests, 66 Convex-focused tests, Convex validation, production build, twenty authenticated Chromium journeys without retry, and foundation evidence on 2026-07-28. A pure browser-origin publication policy now denies every offline signal, browser-origin agent status, non-lifecycle presence exits, and fine cursor/selection/viewport/typing/drag/attention signals while hidden or unfocused. Hidden presence is denied by default and, when explicitly enabled, permits only an away/coarse heartbeat. The injected lifecycle composition is disabled by default and unconditionally disabled in production; it touches no DOM, token provider, transport, or Ably client during construction. Explicit non-production use serializes online/offline stop and restart edges, re-reads injected visibility/focus context before every publish, preserves offline teardown during an immediate reconnect, rolls back partial listener attachment, and keeps hidden/blurred sessions connected only so the policy may govern coarse presence. This is provider-free injected-source/fake-session evidence: no DOM adapter, feature-flag wiring, Ably application, credential, provider connection, live token refresh/revocation, real background tab, network recovery, or load claim exists.
- Provider-free DOM lifecycle and strict feature-flag release gate: commit `6ce6ba8`; GitHub Actions run `30340669786` passed install, lint, typecheck, 112 automated tests, 66 Convex-focused tests, Convex validation, production build, 22 Chromium journeys with one explicit skip, and foundation evidence on 2026-07-28. The DOM source maps real window online/offline/focus/blur events and document visibility changes into the existing lifecycle contract without reading browser globals during import. The composition seam requires the exact raw value `enabled`, is unavailable in production, validates the source before session construction, catches hostile getters and factories, and invokes zero source or session factories while disabled or malformed. A test-only verification route returns 404 outside the test environment and drives an injected fake disposable session without Ably, Convex, token, transport, or provider imports. Hosted Chromium proves default-disabled zero construction, explicit opt-in, and a real offline stop/online restart cycle. Actual background-tab visibility/focus behavior remains unverified: headless Chromium did not expose a hidden first page, so that case is recorded as one skip rather than a pass.
- Inert authenticated-shell realtime seam release gate: commit `9777184`; GitHub Actions run `30341533824` passed install, lint, typecheck, 116 automated tests, 66 Convex-focused tests, Convex validation, production build, 22 Chromium journeys with one explicit background-visibility skip, and foundation evidence on 2026-07-28. The authenticated Mission World now mounts a null-rendering lifecycle boundary only beneath the Convex `Authenticated` gate. It requires both the exact development environment and exact raw `enabled` flag, remains disabled for preview, test, production, missing, and malformed configuration, and returns before composition unless a future authenticated room integration supplies a session factory. Product wiring supplies no factory, so it constructs no DOM source, room session, provider client, token request, transport, UI, or durable state. Focused tests prove default and malformed zero-construction behavior, missing-session failure, exact opt-in composition, start/cleanup ownership, and that the shell does not invoke the future session factory itself. This is an integration seam only, not live presence or provider evidence.
- Durable realtime room-readiness release gate: commit `567a7af`; GitHub Actions run `30342954314` passed install, lint, typecheck, 118 automated tests, 67 Convex-focused tests, Convex validation, production build, 22 Chromium journeys with one explicit background-visibility skip, and foundation evidence on 2026-07-28. A narrow read-only Convex projection now derives realtime readiness from the authenticated active human principal, active private Mission, active exact room, non-agent membership, grant version, and server-owned Mission or room scope. Missing, wrong, archived, revoked, expired, agent-role, and unscoped states fail closed. The authenticated shell additionally requires exact expected Mission and room ids plus the current positive membership grant version before composition, and scope or grant changes dispose the old lifecycle before replacement, including an in-flight start. Product wiring still supplies no session factory, so this release creates no provider connection, TokenRequest, transport, durable write, presence UI, or live-collaboration claim. The local authenticated browser suite could not start because the configured local Convex Auth endpoint was unavailable; browser evidence comes from the successful ephemeral-Convex hosted run, not that failed local attempt.
- Observability, error boundaries, structured logs, and environment validation: shell error boundaries and safe environment-name validation started in commit `a9679c0`

Evidence boundary:

- The current Mission World and Workshop still use fixture content for occupants, room active/agent counts, room activity snippets, and artifacts. Room identity, titles, lifecycle, coordinates, Moves, Calls, Fractures, Proofs, and Pulse history are now durable Convex state; presentation preferences and layout lock intentionally remain personal and browser-local.
- The authenticated Mission title, membership role, invitation issuance, invitation acceptance, room lifecycle, layout persistence, scoped visibility, cross-browser reactive movement, and concurrent conflict recovery are real local Convex evidence. They do not prove cloud deployment, Ably presence, exhaustive role coverage, agent runtime, disaster recovery, load, or production readiness.
- Calls now have a durable owner-operated lifecycle, deadlines, participant controls, append-only response history, resolution summaries, and a real two-context reactive collaboration journey against ephemeral Convex. Ably presence, cloud-preview collaboration, and real network/load behavior are not implemented or claimed.
- Fractures now have a durable owner/reporter-operated lifecycle and room-anchored canvas controls against ephemeral Convex. Cloud-preview collaboration, Ably presence, and real network/load behavior are not implemented or claimed.
- Proofs now have a durable submit/edit/reject/resubmit/verify lifecycle and room-anchored canvas controls against ephemeral Convex. Independent reviewer collaboration, cloud-preview collaboration, Ably presence, and real network/load behavior are not implemented or claimed.
- Pulse now exposes attributable, room-scoped durable Mission history and survives reload and Mission archive against ephemeral Convex. It is not Ably presence, a live occupant count, exhaustive legacy-event migration, cloud-preview collaboration, or real network/load evidence.
- The guarded Ably issuer has local synthetic-signature and hosted-CI authorization evidence only. It does not establish an Ably runtime connection. Revocation of an already issued non-production token is bounded by its five-minute TTL; a live disconnect/re-authentication path remains a production gate.
- The provider-independent room-session kernel, development-only Ably adapter, signal governor, privacy telemetry, browser lifecycle policy, and provider-free DOM source have deterministic fake-clock/fake-client evidence plus real Chromium offline/online lifecycle evidence. Strict schemas, authenticated identity binding, exact capability-family routing, local rate governance, bounded receiver caches, privacy-safe disabled telemetry, strict zero-construction feature gating, hidden/focus publication gating, and ordered offline teardown now fail closed. No provider connectivity, forced provider disconnect, real background-tab behavior, live token refresh, enabled telemetry sink, multi-browser provider recovery, or load/fan-out behavior is claimed.
- Overall production capability remains below one percent until the same flows pass against the connected cloud backend and current preview.
- Twenty-two browser journeys pass and one background-visibility case is explicitly skipped in GitHub Actions run `30342954314` against an ephemeral Convex deployment. The authenticated Mission evidence remains intact, and the provider-free lifecycle diagnostic additionally proves default-disabled zero construction, explicit test opt-in, and a real Chromium offline stop/online restart cycle. The diagnostic route is 404 outside the test environment, uses an injected fake session, and keeps the Ably/provider path unconstructed. A local in-app browser attempt also kept the first tab visible after opening a second tab, so genuine background-tab visibility/focus behavior remains unavailable and is not claimed.

Exit gates:

- Signed-in user reaches a responsive authenticated shell
- Preview deployment is reproducible
- Authorization boundaries have automated coverage
- CI and production build pass

Current gate status:

- CI and production build: passed in GitHub Actions run `30342954314`
- Signed-in responsive shell: passed with local ephemeral Convex Auth
- Authorization and transient-state boundaries: 118 automated tests pass locally and in hosted CI across Mission, guarded realtime token issuance, strict signal schemas, authenticated realtime identity, publish budgets, privacy-safe telemetry, bounded receiver caches, browser visibility/focus policy, strict DOM lifecycle feature gating, durable room-readiness authorization, scope and grant-version disposal, ordered offline/online lifecycle composition, the development-only Ably adapter, offline room-session lifecycle, contention-free event ordering, Constitution, Move, Call administration, participation and response history, Fracture recovery, Proof verification, Pulse history, membership, invitation, room scopes, lifecycle, expiry, dependencies, capacity, OCC, and idempotency behavior
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
