# Mission World Experience Specification

## Design thesis

Realworld should feel like entering a productive place that is already in motion. It borrows the clarity of Google Docs—who is here, what changed, where a collaborator is working, and what is safe to touch—and the situational awareness of a cooperative game—spatial roles, visible paths, timely Calls, moments of shared recovery. It must never turn work into a costume party of levels, loot, or engagement bait.

The selected visual language is **Living Atlas, revised as Mission World**: a pale, high-legibility spatial atlas; a Mission Core; luminous but restrained Rooms; live human and agent presence; a persistent Pulse; and an inspector that turns an interesting signal into an immediate useful action. The world map is a navigation surface, not a decorative dashboard.

## Primary surfaces

| Surface | Job to be done | Default question answered |
| --- | --- | --- |
| **Mission World** | Orient, choose a room, find live work and needs | “What is happening, and where can I help?” |
| **Room** | Perform a work mode with collaborators and agents | “What can we make or decide here now?” |
| **Artifact** | Create, review, version, and attribute actual output | “What changed, why, and what comes next?” |
| **Inspector** | Explain any selected object without leaving context | “What is this and what actions are safe?” |
| **Pulse rail** | Give lightweight live awareness and re-entry | “Who is active and what changed while I was away?” |

The main desktop route opens in Mission World. A first-time, one-person Mission opens in Mission Core with Workshop visible as the recommended next Room, not in a blank-world state.

## Mission World map

### Composition

The Mission Core sits in the visual center and represents the shared outcome, Mission status, current best Move, and collective momentum. Purposeful Rooms orbit it as spatial destinations. Each Room has a unique silhouette, semantic color, an entrance affordance, one current purpose, and a concise presence summary. A dotted/luminous route communicates an active relationship, handoff, dependency, or a participant travelling between Rooms.

The map retains the high-key Living Atlas look: white/porcelain ground, faint contour lines, blue as the default active system color, and rooms given modest semantic accents. It must use flat, vector-renderable layers in the actual product; illustrative 3D architecture in the concept image is inspiration for depth and identity, not a rendering requirement.

### Map anatomy

1. **Top bar** — Mission switcher; Mission World / Field / Missions / Surge navigation; compact Momentum and Fracture count; Surge state; create/join action; search; notifications; identity.
2. **Mission summary** — title, outcome, short Constitution excerpt, activity/presence summary, current Pulse. It collapses to a single compact chip at narrower widths.
3. **Mission Core** — outcome, % evidence-backed progress when meaningful, current Move, compact participant cluster, and open Core action.
4. **Room landmarks** — name, one-line work mode, active human/agent count, live mini-avatar cluster, room state, entry target.
5. **Active paths** — animated only when a meaningful state changes or a handoff is in progress. Colors inherit from source/target room unless an exception state needs semantic emphasis.
6. **People and agents** — circular identity tokens travelling or settled near their current Room. Human tokens use portrait/initial + an online/focus state; agents use a distinctive glyph and a type label in the inspector.
7. **World events** — Call, Fracture, Proof, new Artifact, and Branch appear as map-resident events tethered to the affected Room—not as disconnected toasts.
8. **Inspector** — right-side, non-modal panel for the selected Room/object, with state, people, relevant Artifacts, and a single clear action.
9. **Pulse rail** — persistent lower strip: quiet, horizontally navigable live presence and noteworthy state changes. It remains a context indicator, never a firehose.

### Room taxonomy and visual identity

| Room | Accent | Landmark metaphor | Map state shown | Default entry action |
| --- | --- | --- | --- | --- |
| Mission Core | Electric blue | Beacon / commons | Current outcome, progress, decision need | Open Mission brief |
| Workshop | Azure | Workbench / studio | Active Artifacts, current Move, builders | Open working Artifact |
| Research Observatory | Teal | Observatory / archive | Questions, evidence confidence, researchers | Explore evidence |
| Branch Lab | Coral-red | Parallel lab | Competing approaches, merge state | Compare branches |
| Review Deck | Indigo | Gallery / review table | Proposed Proof, pending review | Review proposal |
| Signal Tower | Emerald | Beacon / dispatch | Open Calls, invitations, dependencies | Answer or create a Call |
| Artifact Library | Amber | Library / repository | Reusable outputs, references, handoffs | Browse artifacts |
| Surge Hall | Violet | Gathering hall | Countdown/live focus, attendance | Join Surge |

Rooms are created only when their work mode becomes real. A solo Mission begins with Mission Core and Workshop; Research Observatory or Review Deck appears after the first evidence/review need; Branch Lab appears only once an alternative is explicitly created.

### Map interaction model

- **Hover/focus a room:** light its boundary, surface one sentence of purpose and one safe action. Never require hover for essential information.
- **Select a room:** set it as the map selection and open/update Inspector; URL reflects selection for shareable context.
- **Enter a room:** double-click, press Enter on a selected Room, use its Inspector action, or choose from the command palette. The transition is spatial but immediate.
- **Follow a participant:** select their token or “Follow” in the Inspector. Camera follows their room, never their fine-grained cursor; an always-visible “Stop following” control exits.
- **Open an event:** Call, Fracture, Proof, Branch, and Artifact are selectable objects anchored to their Room. Their inspector supplies one primary action plus a link to durable history.
- **Pan/zoom:** mouse wheel/pinch changes semantic zoom, not arbitrary canvas scale. A reset control returns to the full Mission World.
- **Keyboard:** Tab reaches major landmarks and controls; arrow keys move map selection between nearest valid destinations; Enter opens; Escape steps out (object → room → map) and closes Inspector only when it is not the sole access path.

## Complete room interior: Workshop

Workshop is the production room, not a generic whiteboard. It is optimized for building one high-value Artifact with people and agents working in parallel.

### Layout

```text
┌──────────────────────────────── Top bar ──────────────────────────────────┐
│ ← Mission World / Workshop     “Realtime music studio”    Pulse  6 active │
├─────────────┬───────────────────────────────────────┬──────────────────────┤
│ Room rail   │ Main Artifact canvas                  │ Context inspector    │
│ Objective   │ [document / code / media / structured │ selected Move        │
│ Current Move│  artifact editor]                     │ evidence / versions  │
│ People      │                                       │ agent status/actions │
│ Room feed   │ collaborator cursors + selections     │ approve / request    │
│             │ inline handoffs and comments          │ review / open Proof  │
├─────────────┴───────────────────────────────────────┴──────────────────────┤
│ Pulse: active participants, handoffs, related room signals, Surge control  │
└────────────────────────────────────────────────────────────────────────────┘
```

### Workshop behavior

- **Artifact first:** the dominant surface is a real editable Artifact, chosen by content type. The room does not make chat the center of work.
- **Room rail:** provides objective, active Move, room members, and a concise event trail. It is collapsible but remains accessible by keyboard and screen reader.
- **Co-editing:** participant cursors use a color + name label + avatar; selections use an alpha-tinted version of the identity color. The color palette is contrast-checked and the name is always available in text.
- **Fine-grained awareness:** typing appears as “Priya is editing the sync section,” rather than streaming keystrokes. Selection/cursor updates are lossy and never mistaken for saved content.
- **Handoffs:** a user can select a range/object and hand it to a person or agent with a bounded request. The recipient sees a linked task in their context; both can decline. A handoff is durable only when accepted.
- **Agent work:** an agent’s area reads as a proposal in progress, with status (queued/running/waiting/finished), tool/action summary, cost/budget indicator, cited evidence, and “review changes” action. It never impersonates a human cursor or shows chain-of-thought.
- **Conflict:** concurrent durable changes resolve through the artifact’s collaboration model. When a user needs to choose, show a short conflict card with author, affected content, options, and version history; never silently discard work.
- **Proof:** when the active Move’s criteria are satisfied, Workshop offers “Prepare Proof,” which packages the proposed outcome, evidence, and open questions for Review Deck. It does not award cosmetic rewards.

### Workshop entry and exit

- Entering from the map performs a 180–220ms shared-axis transition: Room landmark expands toward the content area, then the selected Artifact becomes focus. The exact object is retained in the URL and browser history.
- If no Artifact exists, the interior opens an intentional starter state: one recommended Artifact, the active Move, and “create with Steward” / “create myself.”
- Exit via breadcrumb, Escape, browser Back, or minimap returns to the same map position and selection. This preserves spatial memory and does not reset other participants’ presence.

## Realtime presence: Google Docs-grade, room-scale

### Presence states

| State | Human representation | Agent representation | Persistence |
| --- | --- | --- | --- |
| Present in Mission | Avatar in Pulse rail; room-level location if shared | Glyph in Pulse rail with agent label | Ephemeral |
| In Room | Avatar anchored to room / member list | Glyph + current activation status | Ephemeral |
| Viewing Artifact | Named view indicator | “Reading context” status | Ephemeral, privacy-scoped |
| Editing / selecting | Named cursor and translucent selection | Proposal range, never a human cursor | Ephemeral |
| Working on a Move | Activity chip with short verb | “Running [bounded action]” chip | Durable assignment + ephemeral live state |
| Needs attention | Call/Fracture, visibly tethered to work | Waiting-for-approval status | Durable |
| Offline / stale | Removed after grace period; last durable change remains visible | Paused/stopped status with reason | Ephemeral status, durable result |

### Realtime rules

- Presence must be useful within one glance: identity, location, coarse activity, and whether intervention is welcome.
- Default privacy is room-level, not cursor surveillance. Users may choose to hide their live location from non-collaborators where Mission policy permits.
- A maximum of five individual identities are shown directly in a crowded room; the rest collapse into `+N` with a readable roster. On focus, the full list is available.
- The system coalesces movement and typing updates. It prioritizes durable actions, direct collaborators, Calls, and Fractures over ambient motion.
- Disconnect/reconnect has a quiet 10-second grace state. Reconnection restores authoritative Mission state first, then presence; a stale cursor is never replayed as an edit.
- Presence uses Ably as an ephemeral transport while Convex remains the source of all durable assignments, content, permissions, and history.

## Motion and sound

### Motion

- Motion explains a state change, a spatial relationship, or a successful handoff. It never runs just to make the product feel busy.
- Normal transitions: 160–240ms, opacity/scale/position only, cubic-bezier with a quick settle. Large room entry: maximum 300ms.
- Paths animate once for a durable handoff, Call answer, or Artifact arrival, then settle into a static route. Ambient Pulse is a low-amplitude drift at 8–14 second intervals, disabled in reduced-motion.
- Fractures use a single attention pulse and persistent semantic styling; they do not shake, flash, or repeatedly pulse.
- Proof has a one-time “world changed” bloom around the affected Room, with no confetti and no celebration for non-substantive actions.
- `prefers-reduced-motion: reduce` replaces travel, pulses, and parallax with instant state changes plus text in the event trail. All information remains available.

### Sound

- Sound is **off by default**. It can be enabled per user and never plays without an explicit interaction in the current session.
- The sole initial sound set is subtle confirmation: a soft handoff/Call acknowledgement, Surge start, and optional personal attention cue. It uses system-level volume, has per-category toggles, and has no looping ambience.
- Every audible state has an equivalent visual and screen-reader announcement. Muting changes no workflow behavior.

## Design tokens

Implementation uses semantic tokens, not hard-coded room colors. Exact values are provisional until a visual fidelity pass.

```css
:root {
  --rw-surface-canvas: #fbfcff;
  --rw-surface-raised: #ffffff;
  --rw-surface-selected: #eef4ff;
  --rw-ink-strong: #111827;
  --rw-ink-muted: #667085;
  --rw-line-subtle: #dde4f0;
  --rw-brand: #1463ff;
  --rw-room-core: #1463ff;
  --rw-room-workshop: #2486ff;
  --rw-room-research: #00a891;
  --rw-room-branch: #ef5b4c;
  --rw-room-review: #5b49d9;
  --rw-room-signal: #1b9c68;
  --rw-room-library: #d79316;
  --rw-room-surge: #7b61ff;
  --rw-state-fracture: #d92d20;
  --rw-state-proof: #039855;
  --rw-focus-ring: 0 0 0 3px rgb(20 99 255 / 0.32);
  --rw-radius-sm: 8px;
  --rw-radius-md: 12px;
  --rw-radius-lg: 20px;
  --rw-shadow-float: 0 12px 28px rgb(16 24 40 / 0.12);
}
```

- Body text is 14–16px; labels never fall below 12px; interactive targets are at least 44×44 CSS pixels.
- Room color never acts as the sole identifier: name, icon, and state label accompany it.
- The implementation prioritizes system sans for collaboration surfaces; the editorial serif from early concepts may appear only in mission/outcome headings if it retains performance and readability.

## Responsive behavior

| Breakpoint / input | Mission World | Room interior |
| --- | --- | --- |
| Desktop ≥ 1200px | Full map, persistent Inspector and Pulse rail | Three-column Workshop layout |
| Compact desktop / tablet 768–1199px | Map remains primary; Inspector becomes overlay/drawer; Mission summary compacts | Context inspector becomes an end drawer; room rail collapses |
| Mobile < 768px | A focused map lens: Core + selected/nearby Rooms, room carousel/list alternative, bottom sheet Inspector | Artifact is full-screen; room context opens as a bottom sheet; clear back-to-world control |
| Touch | Tap selects, second tap/primary button enters; pinch semantic zoom; no hover-only control | Long-press opens object context; drag only when a direct manipulation has a non-gesture fallback |
| Keyboard | Landmark navigation and spatial arrow traversal | Full editor and side-panel navigation; command palette routes every essential action |

Mobile does not attempt to miniaturize every room landmark. It shows the minimum spatial context needed to select a destination and provides an equivalent accessible room list and activity stream.

## Accessibility requirements

- The Mission World has a semantic list/tree alternative synchronized with map state. Users can create, enter, inspect, and act on every Room/object without a canvas gesture.
- Screen readers receive concise live announcements only for direct collaboration, assigned Calls, significant Fractures, and completion of requested agent work; ambient presence is discoverable on demand, not announced continuously.
- Every visual path/event has text equivalent in the activity/event trail.
- Focus is always visible and preserved across room transitions. Closing Inspector returns focus to the selected map object.
- All color combinations meet WCAG 2.2 AA contrast; status colors are paired with icons and text.
- No timed interaction is required for Surge; its timer communicates scheduling, not expiring access.
- Motion and sound preferences are respected independently, persisted per user, and testable.

## Concept-to-browser acceptance checklist

The visual direction is not accepted by a screenshot alone. Before Phase 3 is marked complete, record evidence for each item:

- [ ] Browser render matches the approved Living Atlas / Mission World hierarchy: Core, purposeful Rooms, active paths, people/agents, Calls/Fractures, Pulse, and Inspector are discernible in one viewport.
- [ ] A new solo user can create a Mission, understand the Core, enter Workshop, create a first Artifact, and return to the map without a blank or dead-end state.
- [ ] Two-browser interaction verifies shared durable state, cursor/selection presence, room occupancy, a handoff, reconnect recovery, and a conflict/merge path.
- [ ] A user can enter any room, select any visible event, and reach its durable history without pointer-only interaction.
- [ ] Keyboard-only traversal and the room list alternative support Core → Room → Artifact → Proof → map return.
- [ ] Mobile browser testing verifies selecting/entering rooms, Inspector actions, a full-screen Artifact, and back navigation at 320px and 390px widths.
- [ ] `prefers-reduced-motion` and sound-off runs show the same functional outcomes without ambient travel or audio.
- [ ] Screen-reader checks verify concise labels, focus restoration, non-spammy collaboration announcements, and access to all map information.
- [ ] Performance trace at 50 simulated occupants keeps the map interactive; presence coalesces rather than causing layout thrash or visual noise.
- [ ] Design fidelity review compares browser captures to `living-atlas-realtime-hybrid.png` and `mission-world-map.png`, documenting deliberate deviations and their accessibility/performance rationale.

## Founder approvals needed before implementation

1. **Naming choice:** keep the room label **Experience Studio** from the concept or standardize it to **Workshop** across product and visual language. This spec recommends **Workshop** for clarity and reserves “Experience Studio” for a domain-specific Mission room template.
2. **Spatial visual level:** ship vector/map landmarks inspired by the concept, rather than literal 3D illustrated buildings. This spec recommends vector/2.5D for accessibility, performance, and responsive behavior.
3. **Sound policy:** start with sound fully off by default and optional subtle cues only. This spec recommends no ambient soundtrack at launch.
4. **Presence privacy default:** share coarse room-level location with Mission collaborators, not fine-grained artifact viewing/cursor position beyond direct collaborators. This spec recommends that privacy-first default.
