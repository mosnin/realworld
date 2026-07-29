# Human identity and attribution contract

Realworld needs recognizable people without turning account metadata into public identity or letting a rename rewrite the historical record. This contract separates a mutable public callsign from immutable action-time attribution.

## Product language

- A person chooses a **callsign** before creating a Mission or accepting an invitation.
- A callsign is a presentation label, not verified identity, a username, or an authorization handle.
- The product never derives a callsign from email, provider name, token subject, or another private account field.
- Current-presence surfaces may show the current callsign. Historical activity shows the callsign captured when the action occurred.
- Missing historical snapshots fall back to a role or generic collaborator label. They never fall back to account metadata.

## Durable authority

- Convex remains authoritative for the human principal, current callsign, callsign change time, and action-time snapshots.
- Authorization continues to use the immutable principal id and active Mission membership. Callsigns never appear in capability, realtime, idempotency, correlation, or lookup scopes.
- The browser may update only its own active human principal. The mutation accepts no principal id, token identifier, role, Mission id, or email.
- Agent and service principals cannot use the human self-profile mutation.
- No broad principal directory is introduced by this slice.

## Callsign policy

The server applies one canonical normalization path:

- Unicode NFKC normalization
- leading and trailing whitespace removal
- internal whitespace collapse
- two to forty visible graphemes
- rejection of controls, line breaks, bidi overrides, zero-width controls, email-shaped values, and reserved system or agent labels

Callsigns are not globally unique. Surfaces that could imply authority must also show the actor type or effective role. The first callsign may be set immediately; later changes use a server-enforced cooldown. Exact replay is idempotent and reuse of an idempotency key with a different normalized callsign fails closed.

## Historical attribution

Every newly attributable durable action captures an optional `actorDisplayNameAtAction` beside its immutable `actorPrincipalId`. Domain rows with human-facing attribution capture the corresponding action-time label for their revision, such as submitter, verifier, reporter, creator, or responder.

Pulse and entity history prefer these snapshots. Existing records without snapshots use the safe generic fallback. Renaming a profile changes future actions and current-presence presentation, but never changes earlier history.

This is intentionally different from Ably presence. A durable “Maker Mark” can visualize the newest completed room action from Pulse, but it must never imply that the actor is online.

## Smallest implementation sequence

1. Add self-only profile query and mutation plus shared normalization, replay, cooldown, and authorization tests.
2. Add optional action-time attribution fields and write them on newly attributable event and domain revisions; make projections prefer snapshots.
3. Gate Mission creation and invitation acceptance on a completed human profile.
4. Replace the top-bar fixture person with the current callsign and remove fixture identity from any surface that could be mistaken for live occupants.
5. Add room-anchored Maker Marks from existing scoped Pulse data, with explicit durable-activity language and no Ably dependency.

## Release evidence

- Direct checks deny unauthenticated, inactive, agent, and cross-principal profile mutation.
- Validation covers normalization, reserved and hostile Unicode, bounds, replay, key collision, and cooldown.
- A two-context browser journey proves a reviewer callsign appears in authorized Proof and Pulse attribution after reload without exposing email, token identifier, principal id, or correlation id.
- Renaming between two actions leaves the first action under the old snapshot and the second under the new snapshot.
- Scoped members see only authorized room history; the contained observer shell remains unchanged.
- Reduced-motion, keyboard, phone, and strict accessibility checks cover the profile gate and any Maker Mark.

Cloud Convex, Ably presence, provider identity, and production behavior remain unverified until their separate gates pass.
