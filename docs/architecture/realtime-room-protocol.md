# Realtime Room Protocol

## Purpose and non-goals

This protocol makes a Mission World feel co-present while keeping Convex as the sole source of truth. Ably carries short-lived, best-effort room signals. Convex owns membership, room access, durable work, agent runs, approvals, and event history.

The protocol intentionally does **not** implement artifact editing, authorization, durable room membership, notifications, or agent execution over Ably. A client must remain useful when all realtime signals are absent.

## Transport boundary

```text
Convex query/mutation
  authoritative Mission snapshot, policy, room access, durable events
          │
          ├─ browser receives a short-lived, scoped realtime token
          ▼
Ably room channels
  lossy presence, interaction, transient visual/sound effects, public agent status
          │
          ▼
Browser derives transient decoration only; it never commits durable state from a message
```

The trusted token issuer first asks Convex for the caller’s current principal, Mission, membership, visibility, room policy, and allowed realtime scopes. The issuer returns only a short-lived capability token for the approved namespace. It must not accept a user-supplied role, Mission scope, room scope, or principal identity as authority.

Tokens are environment-isolated, audience-restricted to the realtime transport, short-lived, and refreshable only after a fresh authorization check. Their contents, signatures, and provider credentials never reach logs or repositories.

### Implemented non-production issuer boundary

`api.realtime.issueTokenRequest` now implements the trusted boundary as a Convex action. It derives the caller from Convex Auth, rechecks the active human principal, Mission, room, membership, expiry, role, exact room scope, and durable grant version in a server-only query, then signs a five-minute Ably `TokenRequest`. The browser cannot supply its own role, scope, client identity, environment, or capability.

Development, test, and preview namespaces are explicit and fail closed when `REALWORLD_APP_ENV` or the server-only `ABLY_API_KEY` is absent. Production issuance is unconditionally disabled in this release. Human writer roles receive only the exact operations in the matrix below, observers receive subscribe-only channels with no interaction channel, and `agent-status` remains subscribe-only for every human role. Client ids are pseudonymous and rotate when the durable membership grant version changes.

This is offline issuer and authorization evidence only. No Ably application, credentialed provider request, client connection, presence session, network recovery, or load test has run. A revoked non-production token can remain usable until its five-minute expiry; a tested live disconnect/re-authentication path is therefore a production-enable gate.

## Channel namespace and capability design

### Names

All names are opaque identifiers, never slugs or user-generated text:

```text
rw:{environment}:mission:{missionId}:world
rw:{environment}:mission:{missionId}:room:{roomId}:presence
rw:{environment}:mission:{missionId}:room:{roomId}:interaction
rw:{environment}:mission:{missionId}:room:{roomId}:surge
rw:{environment}:mission:{missionId}:room:{roomId}:agent-status
```

`world` is a Mission-level, low-frequency stream for coarse selected-room context and transition decorations. Room channels are joined only for the room the user is actively viewing or participating in. This avoids multiplying per-client fan-out in a 50-person Mission.

No wildcard capability crosses an environment or Mission boundary. A browser may receive access to `world` plus one or more explicitly permitted room-channel groups; it never receives a broadly scoped all-Mission or all-project credential merely for map browsing.

### Capability matrix

| Channel | Publisher | Subscriber / presence member | Allowed payload class | Not allowed |
| --- | --- | --- | --- | --- |
| `world` | Authorized human client; trusted server relay for safe effects | Mission members with Field access | Coarse room location, map selection, one-time route/effect | Membership, role, content, durable events |
| `presence` | Authorized human client; authorized agent status relay | Users with room-presence visibility | Join/leave/heartbeat; coarse activity; privacy flag | Fine cursor, artifact text, permissions |
| `interaction` | Authorized human client | Direct room collaborators with interaction visibility | Cursor, selection, viewport, typing, drag ghost, attention ping | Durable edits, approval, artifact data |
| `surge` | Authorized participant; trusted coordinator relay | Users allowed to see the Surge | Readiness, local time sync sample, voluntary reaction, ephemeral countdown tick | Attendance record, timer authority, coercive tracking |
| `agent-status` | Trusted server relay only | Users allowed to see the room/run summary | Safe public operational status tied to durable `runId` | Raw model output, tool arguments/results, private reasoning, final outcome |

The token capability must grant only the publish, subscribe, and presence operations required by the caller. Agent processes never hold a browser-equivalent broad capability: a trusted relay emits their filtered public status after validating the durable run state and room visibility.

## Privacy model

Realtime scopes are evaluated by Convex policy at token issue and refresh. They can only narrow Mission membership; presence never expands visibility.

| Signal | Default audience | User control | Detail |
| --- | --- | --- | --- |
| Mission presence | Mission collaborators | May appear unavailable where policy allows | Active in Mission, not live location |
| Room presence | Room collaborators | Hide exact room from non-direct collaborators where policy permits | Room id, coarse activity, last heartbeat age |
| Artifact interaction | Direct Artifact/room collaborators | Opt out of live cursor/selection, retaining durable editing rights | Cursor/selection/typing are off for viewers lacking direct collaboration scope |
| Drag ghost / viewport | Direct room collaborators during active manipulation only | No persistent opt-in needed; automatically expires | Object reference/geometry only, never hidden object data |
| Surge participation | Users who can see the Surge | Join is voluntary; no timer-based attendance penalty | Ready/active/away state, never background tracking |
| Agent public status | Users permitted to view the associated run/room | Not user-configurable beyond room access | State, safe action summary, timestamp, confidence/evidence refs if durable and visible |

A user’s browser must not publish pointer coordinates, cursor, viewport, or typing while backgrounded. When the user hides fine presence, their client may still publish a neutral room-presence heartbeat necessary for capacity/occupancy, subject to Mission policy.

## Event envelope and message classes

Every message uses a versioned envelope. Values shown below are a protocol shape, not a provider SDK invocation.

```ts
type RealtimeEnvelope<T> = {
  v: 1;
  kind: string;
  messageId: string;          // UUID generated once per publish attempt
  sender: {
    principalId: string;
    clientInstanceId: string; // random per browser tab/session; not a stable device id
    connectionEpoch: number;  // increments after reconnect
  };
  missionId: string;
  roomId?: string;
  issuedAtMs: number;
  expiresAtMs: number;
  clientSeq: number;          // monotonic within sender + client instance + epoch
  correlationId?: string;
  payload: T;
};
```

Receivers reject a message when schema version, namespace binding, sender shape, room scope, payload size/type, or expiry is invalid. They do not treat transport order as truth.

| Kind | Payload minimum | Max payload | Default TTL | Publish rate / coalescing |
| --- | --- | ---: | ---: | --- |
| `presence.heartbeat` | coarse activity, privacy mode, room sequence | 1 KB | 45 s | 15 s heartbeat; immediate on entering/leaving a room |
| `presence.leave` | reason (`navigate`, `hidden`, `disconnect`) | 512 B | 15 s | Once; TTL expiry is the fallback leave |
| `interaction.cursor` | normalized x/y, artifact/object ref, coarse mode | 512 B | 3 s | Max 15 Hz foreground; send latest only |
| `interaction.selection` | object/range ref, selection digest | 2 KB | 8 s | Max 5 Hz, latest selection wins |
| `interaction.typing` | target ref, boolean | 512 B | 5 s | Start, keepalive ≤ 4 s, stop/expiry |
| `interaction.drag` | public object ref, normalized geometry, gesture phase | 2 KB | 2 s | Max 20 Hz while active; no durable move |
| `interaction.attention` | target ref, short preset reason | 1 KB | 12 s | User-driven, rate-limited 3/min per sender/target |
| `world.transition` | source/target room, effect type, durable event ref if present | 2 KB | 10 s | One-shot, deduped by durable correlation when applicable |
| `surge.signal` | surge id, readiness/reaction/local time sample | 1 KB | 15 s | readiness state change; reactions rate-limited |
| `agent.public-status` | durable run id, safe state, safe summary, updated durable version | 2 KB | 30 s | Trusted relay emits on state transition; heartbeat ≤ 15 s for running |

TTL is a client visibility deadline, not authority. A message that arrives after `expiresAtMs` is discarded. A missing leave event causes the receiver to remove the ephemeral state when its most recent heartbeat expires.

## Client sequence, deduplication, and ordering

Each client session keeps a monotonically increasing `clientSeq` for every `(principalId, clientInstanceId, connectionEpoch)` tuple. The counter is initialized at zero for a fresh epoch and incremented before each publish. Each reconnect increments `connectionEpoch`; a stale prior epoch may not overwrite a current one.

For every sender tuple, the receiver retains the greatest accepted sequence and a bounded recent `messageId` cache through the longest relevant TTL. Handling is deterministic:

1. Reject expired, malformed, unauthorized namespace, or oversize messages.
2. If `messageId` was seen, drop it.
3. If `connectionEpoch` is older than the accepted epoch, drop it.
4. If same epoch and `clientSeq` is lower than or equal to the last accepted sequence for that message class, drop it.
5. Accept higher sequence, update the transient view, and schedule state removal at the TTL deadline.

Message classes use independent last-sequence records so a high-frequency cursor cannot suppress an important `presence.leave`. Within a class, “latest valid state wins”; this is appropriate because the protocol deliberately contains no durable commands. A world-transition effect deduplicates primarily by `correlationId`/durable event reference so reconnecting recipients do not replay celebration or attention animation.

The client must validate that a payload object reference is already visible through its current Convex-authorized snapshot. It renders unknown references only as a generic, non-interactive status if policy allows; it never fetches or reveals an object because a realtime message named it.

## Room lifecycle

### Enter

1. Browser requests the current authorized Mission/room snapshot from Convex.
2. Browser requests a realtime token scoped to the desired Mission and Room. The trusted issuer validates latest membership, room access, visibility, and privacy controls.
3. Browser subscribes, hydrates its local transient store from current channel presence/occupancy where available, and publishes `presence.heartbeat` only after the durable snapshot is ready.
4. Browser opens the Room UI. Failure at any realtime step leaves the Room usable with a “Live signals unavailable” status and a reconnect control; it never blocks durable work.
5. Browser announces room entry to assistive technology only for the local user; peers receive no noisy system-wide announcement unless they are direct collaborators and policy enables it.

### Exit, hidden, and route change

- On intentional exit, publish `presence.leave`, detach interaction listeners, then unsubscribe. The receiver still relies on TTL because delivery is best effort.
- On background/tab-hidden, immediately stop cursor/drag/typing signals and move coarse activity to `away` after a short idle threshold. Do not infer that a durable Move is abandoned.
- On browser close or network loss, no special durable action is attempted. Other clients remove the participant when heartbeat TTL expires.
- Room route change starts the new room lifecycle before tearing down the old one where feasible, but never presents both as a durable membership change.

## Interaction signals

### Cursors and selections

Cursor coordinates are normalized against the visible local artifact or map pane, not raw screen/device coordinates. A cursor payload includes a public target reference and mode (`map`, `artifact`, `comment`, `inspect`) but no content. A selection sends an object/range identifier/digest that the recipient can resolve only if they already possess access to that artifact version.

Cursor labels are identity color + readable name. Selection rendering always includes a non-color label. On reduced motion, remote cursors update at a lower rate and snap instead of interpolating. On mobile, viewers see a compact “N people in this artifact” indicator until they explicitly open collaborator detail.

### Drag ghosts

Drag ghosts are a preview of an in-progress map layout or supported direct manipulation. They include only public object id, geometry, gesture phase, and a short expiry. They never commit a Move, room change, dependency, branch, or artifact position. On drop, the client submits a guarded Convex mutation with the expected aggregate version; a successful durable result may emit a short `world.transition` effect.

Other users see a muted ghost and actor label; they do not see controls implying that the move is final. If the client loses connection, the ghost expires and the durable layout remains unchanged.

### Surge signals

Surge has one durable record in Convex (definition, permitted audience, scheduled state, organizer, any allowed attendance/proof). `surge` carries only readiness, “here/away,” optional reaction, and local-clock samples for smooth UI countdown rendering. The durable schedule controls the timer; no peer message can start, extend, or end a Surge.

When local clocks disagree, the browser displays its derived countdown from the latest durable schedule and uses time samples only to adjust visual smoothness. A reconnect always rereads the Surge record from Convex before resuming ephemeral signals.

### Agent public status

The agent runtime records all meaningful run transitions durably. A trusted service filters those transitions into `agent.public-status` only when the room and viewer may see them. Valid states are concise operational terms such as `queued`, `researching`, `drafting`, `awaiting_approval`, `paused`, `succeeded`, `failed`, and `budget_exhausted`.

Payloads may include a safe action summary, last update timestamp, durable run version, and already-authorized evidence/Artifact references. They must not include prompts, unredacted sources, private reasoning, tool parameters, credentials, or a final outcome that has not reached Convex. The Room always derives the canonical status/details from Convex; Ably may make it feel timely.

## Reconnect, revocation, and hydration

### Reconnect

1. Immediately mark ephemeral collaborators as potentially stale; keep their last rendered state muted until their TTL ends.
2. Retry the realtime connection with bounded exponential backoff and jitter; do not block Convex reads/writes.
3. On transport restoration, fetch/revalidate the current Convex Mission/room snapshot, latest permission/room policy, relevant durable event cursor, active agent runs, and Surge record.
4. Request a new scoped token when the old token is near expiry or authorization version changed.
5. Subscribe to authorized channels, repopulate current presence/occupancy, and resume local heartbeat/interaction publication.
6. Clear transient cursor/typing/drag state from prior epochs; retain only new valid signals. Re-render from Convex state, not cached realtime history.

### Authorization revocation

Revocation starts at Convex: membership/room grant/visibility is changed and an audit event is written. Token refresh then denies further access. A best-effort revocation notifier disconnects/invalidates relevant realtime connections, but correctness does not depend on it.

- Every durable read or write checks current authorization immediately.
- Every realtime token is short-lived and carries an authorization/policy version. A client detects higher policy version in a durable snapshot and discards old local presence scopes before requesting a new token.
- On token rejection, permission change, Mission archive, or room policy narrowing, the client unsubscribes, clears all transient signals for that scope, returns to the nearest authorized screen, and does not retry with cached privileges.
- Other clients treat a forced disconnect as a normal TTL leave. They must not infer the reason or expose revocation details.

## Degraded and offline behavior

| Condition | Durable experience | Realtime experience | User-visible state |
| --- | --- | --- | --- |
| Ably unavailable | Convex reads/writes continue | No remote cursor/presence/Surge decoration | “Live signals are unavailable; work is saved normally.” |
| Realtime slow/flooded | Guarded mutations continue | Coalesce/drop cursor, drag, typing first; keep low-rate presence/agent status | “Live detail simplified.” |
| Convex temporarily unavailable, transport healthy | Show last authorized snapshot as stale/read-only; queue no irreversible state silently | Presence is muted; no claim that work is current | “Mission data is reconnecting.” |
| Offline browser | Draft locally only where an artifact-specific durable sync design supports it; otherwise disable writes clearly | Do not publish presence/interactions | “Offline—changes cannot be shared yet.” |
| Permission changed | Stop unauthorized durable requests | Drop/unsubscribe scoped signals | “Your access changed.” |
| Background tab | Preserve durable UI state | Stop fine signals; coarse `away` only | No notification unless an assigned Call/approval requires it |

Load shedding order is: visual interpolation/ambient effects → cursor/drag frequency → typing/viewport detail → optional world signals → optional discovery signals. It never sheds authorization checks, durable acknowledgements, agent budget enforcement, audit, or confirmed writes.

## Performance budgets for one to fifty people

The representative test Mission has 50 humans, 20 active agents, 500 visible Field entities, and concurrent artifact work. Budgets extend the release standard and are measured from the client’s supported reference network/device:

| Measure | Target | Protocol action on breach |
| --- | --- | --- |
| Local pointer/keyboard response | p95 < 50 ms | Render locally; defer/coalesce remote decoration |
| Cursor/drag publish | <= 15 Hz cursor, <= 20 Hz drag, latest-only | Drop intermediate frames under pressure |
| Presence fan-out | p95 < 250 ms | Collapse to room occupancy and recent activity |
| Agent public status fan-out | p95 < 1 s after trusted emission | Show durable last known status/time |
| Durable mutation acknowledgement | p95 < 750 ms | Pending state with idempotent retry; never optimistic finality |
| Room/Field initial usable view | p75 < 2.5 s broadband | Render prioritized visible region and list alternative |
| Reconnect usable state | < 5 s after transient loss | Hydrate durable snapshot before live decoration |
| Realtime payload size | <= 2 KB except future explicitly approved classes | Reject and count oversize messages |
| Per-client subscriptions | World + active room by default | Leave inactive room channels; use aggregate occupancy elsewhere |

No channel may be treated as an unbounded event log. Clients retain no realtime history beyond TTL/dedup needs. Analytics receives aggregates and safe metadata, never payload content by default.

## Telemetry and operational signals

Each connection/session receives a correlation id that is propagated to safe telemetry. Record:

- connect/auth/subscribe latency and failure class;
- token issue/refresh/denial with Mission/room anonymized references and policy version;
- publish/receive rate per kind, coalesced/dropped/expired/duplicate/malformed counters;
- presence occupancy, TTL removals, reconnect duration, epoch changes, and stale-state duration;
- client render latency, frame stalls, subscription count, payload-size buckets, and load-shed level;
- revocation/unsubscribe propagation time without exposing reason to other clients;
- trusted agent-status relay latency and durable-version mismatch;
- Surge signal health and countdown drift bucket.

Alerts prioritize anomalous publish rate, malformed-message rejection spikes, repeated token denials, high reconnect failures, fan-out p95 breach, cross-scope subscription attempt, and load shedding that persists past its allowed window. Logs redact tokens, raw payloads, artifact references that are private, pointer coordinates, and user-generated content.

## Deterministic multi-client test matrix

All simulations use fixed clocks, seeded principal/client ids, deterministic network fault scripts, and a fake transport adapter that preserves the envelope semantics. Browser cases use at least two isolated authenticated sessions and validate Convex state independently after each scenario.

| Scenario | Clients / fault | Assertions | Evidence label |
| --- | --- | --- | --- |
| Room entry baseline | Two authorized collaborators enter same room | Presence appears within budget; no durable event is required; room remains useful with transport disabled | A, I, P |
| Coarse privacy | Collaborator + non-direct Mission member | Non-direct user sees allowed coarse room state only; no cursor/selection payload/render | A, Role, I |
| Fine privacy opt-out | Two direct collaborators; one disables fine presence | Room occupancy remains; cursor/selection/typing disappear within TTL | A, I, P |
| Duplicate/reorder | Sender emits seq 4, duplicate 4, seq 3, seq 5 | Receiver renders 4 then 5 only; retained durable snapshot unchanged | A |
| Reconnect epoch | Sender reconnects with higher epoch and seq 0 | New epoch accepted; old-epoch cursor cannot overwrite it | A, I |
| TTL cleanup | Drop leave and all heartbeats after cursor/typing/drag | All transient state disappears at class TTL; no durable assignment changes | A, I |
| Drag disconnect | Sender begins drag then loses network | Peers lose ghost by TTL; Convex layout never moves | A, I, P |
| Durable drop conflict | Two clients drop same map object / edit same Move | Convex version/authorization decides outcome; one receives conflict/proposal; no realtime ghost is treated as final | A, Role, I, P |
| Ably outage | Two clients with transport blocked | Convex Mission/Artifact operations work; UI announces degraded live state once | I, P |
| Convex outage | Cached UI + healthy transport | UI is stale/read-only; incoming presence is muted; no false current claim | I |
| Revocation | Revoke a direct collaborator mid-room | Next durable read/write denied; refresh denied; client unsubscribes/clears signals; peers only see TTL leave | A, Role, I, P |
| Expired token | Token expires during active cursor flow | Refresh revalidates and resumes only if allowed; no cached privilege continues | A, Role |
| Surge clock skew | Three clients with fixed +/- clock offsets | Same durable schedule; visual countdown stays within approved drift; peer signals cannot change schedule | A, I, P |
| Agent visibility | Same Mission, room viewer and unauthorized observer | Viewer sees safe public status linked to run; observer receives no agent-status subscription/payload | A, Role, I |
| Agent status race | Relay sends status newer than client’s durable snapshot | UI marks status transient/awaiting sync and reconciles from Convex; it never marks final outcome early | A, I, P |
| Flood/load shed | 50 simulated humans, 20 agents, 500 Field entities | Budgets hold or protocol degrades in defined order; durable mutation and audit error rate stays within release target | L, A, I |
| Accessibility reduced motion | Two collaborators, reduced-motion client | Same participant/object information; no travel interpolation; remote signals do not flood live region | A, I |
| Cross-Mission isolation | Valid token from Mission A attempts Mission B channels | Subscription/publish rejected; no payload or occupancy leak | A, Role |

## Decisions and blockers

1. **Token issuer location is decided.** The guarded Convex action is the trusted issuer boundary. Production remains disabled until credentialed connection, revocation/disconnect, refresh, namespace isolation, and degraded-mode checks pass. No browser-held API key is acceptable.
2. **Artifact collaboration engine is still open.** This protocol supports presence around object/range identifiers; rich-text/code/media conflict and selection semantics need a chosen engine and tested version model before implementation.
3. **Presence retention window is open.** The policy must set the retention period for server/analytics presence metadata and declare whether anonymous aggregate occupancy is retained. Payload contents should not be retained by default.
4. **Voice is intentionally excluded from Phase 3.** The `surge` channel only supports lightweight coordination signals. A later voice provider requires a separate privacy, consent, recording, moderation, and capacity contract.
