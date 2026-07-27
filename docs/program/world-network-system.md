# Realworld World & Network System

## Product decision

Realworld is a **shared work world**, not a project-management app wearing a game skin. A Mission is a living place where people and autonomous agents make a concrete digital outcome together. The interface should feel as immediate as a collaborative document and as legible as a cooperative game: you can see where work is happening, enter it, help, and leave behind an attributable result.

The primary interaction surface is a Mission Field: a spatial map with a **Mission Core** in the middle, purpose-built Rooms around it, visible participants, live work paths, and an always-available readable alternative (list, timeline, and activity feed). Rooms are semantic locations, not chat channels or decorative cards. Entering one changes what a participant can do.

## The definitive loop

1. **Arrive with an intention.** A person writes a desired outcome, a deadline or horizon, boundaries, and what “done” means. They can start privately; an empty room must still feel useful.
2. **The Steward makes the world inhabitable.** The Mission’s lead agent proposes the smallest useful room layout, first Moves, initial Artifacts, risks, and one decision that needs a human. It does not silently start expensive or irreversible work.
3. **Choose a place to work.** A human enters a Room, claims or joins a Move, opens an Artifact, answers a Call, or starts a Branch. Presence changes from “online” to a meaningful activity state: exploring, shaping, building, reviewing, or waiting for a decision.
4. **Work becomes visible motion.** Durable progress changes the Field: paths illuminate, a Room becomes active, an Artifact appears, a Fracture surfaces, or a Proof lands. Ephemeral signals—cursors, gaze, typing, voice, selections, and agent status—make it feel live but never become the record of truth.
5. **The group resolves uncertainty.** A blocked or ambiguous Move creates a Call. Anyone with the relevant capability can answer without permanently joining the Mission. Genuine disagreement creates a Branch with a clear question, bounded scope, and later comparison/merge path.
6. **Artifacts and evidence compound.** Every useful output is versioned, attributable, linked to its Move and source evidence, and reusable. Completion is a Proof, not a checkmark: it explains what changed and why it is credible.
7. **The Mission changes state.** The Field synthesizes the new situation, recommends the next high-leverage Move, and changes the world enough to make progress emotionally palpable without rewarding busywork.
8. **Momentum recruits the right people.** A Mission invites through a specific, legible need—“review this decision,” “test this branch,” “bring visual design”—rather than generic social prompts. Each contribution carries durable lineage and reputation.

The loop must work with one person and a Steward, then get more capable—not noisier—as people and agents arrive.

## Rooms as a map

The initial Mission Field has a small, intentional room vocabulary. A Mission may not need every room; the Steward starts with three to five and adds a room only when a real work mode needs separation.

| Room | What happens there | Primary objects | What a visitor can do |
| --- | --- | --- | --- |
| **Mission Core** | Intent, Constitution, outcomes, state of play | Outcome, decision, next Move, Pulse | Reframe the Mission, make decisions, see the map |
| **Workshop** | Production of the main Artifact | Artifact, Move, collaborators, agents | Co-create, claim work, inspect provenance |
| **Observatory** | Research, synthesis, verification | Evidence, questions, source notes | Investigate, challenge confidence, create a brief |
| **Branch Lab** | Alternative approaches and experiments | Branches, diffs, comparison criteria | Fork, compare, merge, retire an approach |
| **Review Deck** | Critique, approvals, and Proof | Proposal, comments, Proof | Review asynchronously, request changes, approve evidence |
| **Signal Tower** | Calls, invitations, dependencies, and connected Missions | Call, capability, external Mission link | Ask for help, answer a Call, invite or connect |
| **Surge Hall** | Time-boxed, focused collaboration | Surge, focus queue, shared timer | Join a live session, pair with an agent, finish a bounded push |

The map is a practical navigation model:

- At world scale, it answers: *what is this Mission trying to become, where is energy, and what needs me?*
- At room scale, it answers: *what can I make or decide here right now?*
- At artifact scale, it answers: *who changed this, with which agent, on what evidence, and what is next?*

Rooms must never become mandatory ceremony. A solo founder can work entirely from Mission Core + Workshop. A 50-person Mission gains rooms because parallel work needs spatial boundaries, not because the product is trying to look like an MMO.

## Roles and autonomy

### Humans

- **Steward:** sets the Constitution, access, budget, irreversible-action policy, and final accountability.
- **Builder:** creates Moves and Artifacts; may invite collaborators into their work.
- **Reviewer:** verifies evidence, approves Proof, and resolves merge decisions.
- **Contributor:** joins a bounded Move or answers a Call; earns attribution without broad Mission control.
- **Visitor:** can explore public context and take explicitly permitted actions.

### Agents

- **Steward agent:** proposes structure, maintains Mission memory, surfaces decisions, and schedules bounded work.
- **Specialist agents:** are created for specific capabilities (research, implementation, design critique, QA) and receive only the tools, context, budget, and permissions for that scope.
- **Ambient agents:** may monitor, summarize, and prepare drafts; they cannot claim completion, spend meaningfully, publish externally, merge a Branch, or modify the Constitution without a policy-authorized human approval.

Every agent action is attributable to an agent identity plus its authorizing human, one Mission and Room, a budget, a permission envelope, an input/evidence set, and an outcome. The UI presents operational status, actions, evidence, and confidence—not private reasoning.

## Fun without gamification theater

Realworld should create the emotional texture of a good co-op game—shared situational awareness, rescue moments, surprise, mastery, and visible transformation—without points, streaks, loot boxes, fake scarcity, or engagement traps.

| Desired feeling | Product mechanic | Anti-pattern to reject |
| --- | --- | --- |
| “We are making this together.” | Live presence, visible paths, shared Surge, human-agent handoffs | Activity feeds that reward noise |
| “I know where I matter.” | Specific Calls, role-aware entry points, capability matching | Generic notifications and @everyone requests |
| “We saved a hard situation.” | Fractures with severity, evidence, owner, and a recovery path | Red badges with no clear action |
| “We discovered a better idea.” | Branches, compare mode, merge evidence | Permanent fork clutter or winner-take-all voting |
| “The world changed because of us.” | Proof transforms the Field and unlocks the next meaningful work | Confetti for trivial clicks |
| “I am getting better.” | Portable reputation tied to verified contributions and reusable Artifacts | XP, leaderboards, or shallow daily streaks |

Surge is the main ritual: a clear, voluntary, time-boxed session with a shared goal, lightweight social presence, and an observable before/after. It should feel closer to a well-run creative sprint than a meeting. A user can enter and leave with no penalty; agents continue only within their explicit envelopes.

## Solo to fifty: operating model

| Scale | Default shape | What must stay easy | What changes |
| --- | --- | --- | --- |
| **1 human + agents** | Mission Core + Workshop; one active outcome | Start, make, decide, return after absence | Steward agent does setup and creates a calm re-entry brief |
| **2–5 collaborators** | Add Review Deck and occasional Surge | Shared editing, ownership clarity, async review | Presence and direct handoffs become prominent |
| **6–15 collaborators** | Add Observatory, Branch Lab, Signal Tower | Discover current work without meetings | Room-level permissions, Calls, dependency paths, summaries |
| **16–50 collaborators** | Multiple room clusters, mission-wide Pulse, delegation | Enter a useful context in under a minute | Semantic zoom, attention management, scoped notifications, moderation and rate controls |

At every scale, the default view must show only the current Mission state, not the maximum possible interface. Semantic zoom and progressive disclosure prevent a 50-person Field from making a two-person Mission feel like an enterprise dashboard.

## First-session contract

The first session must earn the right to invite someone.

1. A new user creates or joins a Mission from an outcome, an invitation, a public Call, or an Artifact lineage link.
2. In less than two minutes, they see a plain-language answer to: what is being made, what changed recently, what is uncertain, and one action that is safe and useful.
3. The Steward proposes a compact map and the first three Moves, clearly labeling assumptions and waiting for confirmation where needed.
4. The user completes a real, small contribution: accept a proposed structure, create an Artifact, answer a Call, review evidence, or run a bounded agent task.
5. Realworld records the contribution, makes its effect visible in the Field, and offers one specific invitation or Call only if a complementary contribution would materially improve the Mission.
6. On return, the user receives a re-entry brief: changes since last visit, unresolved Fractures, current Surge state, agent actions, and the highest-leverage next Move.

The first session fails if it ends with an empty board, a generic chatbot exchange, an uncontrolled agent run, or a social invite unconnected to real work.

## Network effects designed around output

### Contribution graph

Missions, people, agents, Artifacts, Proof, Calls, Branches, and capabilities form a permission-aware graph. It creates useful discovery without exposing private work:

- A public Proof can reveal a reusable Artifact and the verified capabilities that produced it.
- A Call reaches contributors with relevant demonstrated capability, not an indiscriminate audience.
- An answered Call builds portable reputation for both the contributor and the Mission that made the request legible.
- A Mission can depend on, fork, sponsor, or reference another Mission, preserving lineage and attribution.
- Agents can bring approved reusable playbooks from prior Missions, but never private data or unconsented context.

### Invitation loop

1. A Fracture or opportunity becomes a specific Call.
2. The Call exposes context, scope, expected time, permission, reward (attribution or sponsorship), and a safe first action.
3. A qualified contributor makes a bounded contribution without losing control of their identity or schedule.
4. The resulting Proof demonstrates the value of joining and produces a new, attributable discovery surface.
5. Better capability matching improves the next Call.

This avoids the classic network-effect failure mode: accumulating people before creating reasons to collaborate.

## Non-negotiable realtime rules

- Convex is authoritative for Missions, memberships, permissions, Moves, Artifacts, Calls, Branches, Proof, budgets, and event history.
- Ably may carry ephemeral presence, cursors, selections, room occupancy, typing, transient audio state, and low-latency signals. It must not own durable workflow state.
- A client reconnect must recover from Convex state without trusting missed ephemeral messages.
- The Field updates optimistically only for authorized actions and must visibly reconcile conflicts rather than silently overwriting another person.
- Presence is intentionally lossy and privacy-aware; it describes a participant’s selected work context, not continuous surveillance.

## Measurable quality gates

The following gates turn the product promise into release criteria. They are targets until the instrumentation plan establishes baselines; no phase is “done” merely because a UI exists.

| Area | Gate | Evidence required |
| --- | --- | --- |
| Solo utility | A first-time solo user produces an attributable Artifact and Proof within 20 minutes using a guided Mission | Moderated usability recording, persistent-state readback |
| Shared clarity | Two collaborators can identify the same current next Move and its owner after concurrent edits | Browser interaction test, Convex event/history assertion |
| Re-entry | Returning participants can find changes, one Fracture, and one next Move in under 60 seconds | Instrumented usability task, render and interaction checks |
| Call conversion | A qualified external contributor can make a bounded contribution without a meeting or elevated role | Role/permission test, end-to-end browser flow |
| Agent containment | 100% of agent actions have a mission, room, authority, budget, tool log, and durable outcome | Automated audit query, adversarial integration test |
| No duplicate side effects | Interrupted/resumed agent workflows cause zero duplicate externally visible changes | Idempotency/recovery test suite |
| Field performance | At 50 simulated humans and active agents, p95 durable update-to-render is under 500 ms; presence signal p95 is under 250 ms on the supported reference network | Load test, browser performance trace, service telemetry |
| Accessibility | Keyboard-only and reduced-motion users complete the core create, join, move, review, and proof flows | Automated a11y + manual browser interaction evidence |
| Noise control | At least 90% of notifications in moderated tests map to a user-visible decision, Call, Fracture, or direct collaboration event | Event taxonomy audit, qualitative test notes |
| Network integrity | Reputation requires attributable Artifact, accepted contribution, or verified Proof; spam/fake-work paths are rejected | Abuse tests, source review, moderation audit |

## Phase 0 acceptance decision

This system is ready to guide implementation when the selected visual direction demonstrates the same truths: a Mission Core, purposeful Rooms, live participants and agent activity, Calls and Fractures as actionable places, and visible Artifacts/Proof—not a conventional dashboard with a map illustration. The approved visual must be revised if it cannot make room entry, shared work, and the “what needs me?” question immediately clear.
