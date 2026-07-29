# Founder Actions

Do not paste secrets into issues, commits, Notion, or chat. Add credentials only through the relevant provider's encrypted environment settings.

## Needed now

- [x] Confirm the visual direction as **Living Atlas + Mission World rooms**: a navigable, customizable canvas with tactile room interiors, Google Docs-level presence, and cooperative-game immediacy.
- [x] Confirm the working product name `Realworld`; a naming and trademark check can happen before public launch.
- [ ] Choose the initial sign-in policy. Recommendation: invite-only workspaces with email/social sign-in, private Missions by default, and explicit publishing.
- [ ] Set a monthly AI spend ceiling and a per-Mission default budget. Recommendation for private development: a hard global cap plus visible per-agent run budgets.
- [x] Approved **Blank canvas** as a real Mission type beside the guided templates, so a Mission may begin with a genuinely empty Workshop through the normal product flow.

## Next release gate: cloud development preview

- [x] Created the Vercel-managed Convex development project `realworld-dev`, provisioned development deployment `hallowed-snail-690`, and pushed the current functions, schema, and indexes. Production remains disconnected.
- [x] Assigned stable preview origin `https://realworld-cloud-preview-mosnins-projects.vercel.app`; Convex Auth does not depend on a disposable deployment URL.
- [x] Ran the Convex Auth setup flow for that stable preview origin. The development deployment received encrypted `SITE_URL`, `JWT_PRIVATE_KEY`, and `JWKS` values; no secret values were copied into source or campaign records.
- [x] Set Vercel **Preview** environment variables `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_APP_ENV=preview`; the Vercel-managed `CONVEX_DEPLOY_KEY` remains Preview-only.
- [x] Built a protected preview and verified cloud account creation, callsign setup, Blank canvas Mission launch, owner reload persistence, one-use Workshop-scoped reviewer invitation acceptance in an isolated second browser session, reviewer reload persistence, room containment, and owner-side join history on 2026-07-29.
- [x] Rebuilt the protected preview from clean cloud-preview commit `256ed7f`, preserved both cloud identities and exact room scope across redeploy, and passed the 390×844 responsive-shell gate with no document-level horizontal overflow.
- [x] Added a fail-closed cloud-preview acceptance command that creates disposable accounts and a one-use invitation only in memory, applies Vercel automation-bypass headers to both browser contexts, and disables retained browser artifacts.

Already complete:

- [x] GitHub is connected and the authenticated release gate runs in Actions.
- [x] Vercel is linked to the `realworld` project and has produced a preview build.

The cloud-preview foundation, development Ably transport, and truthful participant-facing connection-health gates have passed. A named presence roster and live revocation remain gated; OpenAI and OpenRouter credentials remain gated until the bounded agent-runtime lane begins.

## Needed immediately after the cloud preview gate

- [x] Created dedicated Ably development application `Realworld Preview Live Room` on the free account. Its revocable `preview-token-issuer` key is restricted to `rw:preview:*` channels and only publish, subscribe, and presence capabilities.
- [x] In Convex development deployment `hallowed-snail-690`, set encrypted `REALWORLD_APP_ENV=preview` and a corrected `ABLY_API_KEY` through a secret-safe local transfer. The key was not placed in Vercel browser variables, source, chat, Notion, or campaign records, and temporary transfer state was removed.
- [x] Ran the first live scoped connection, exact room-isolation, disconnect-cleanup, and reconnect checks against the protected preview. Two distinct pseudonymous owner/reviewer clients held Mission Core and Workshop capabilities respectively, teardown reached zero connections, and reconnect created a new connection. Production token issuance remains hard-disabled in code.
- [x] Shipped truthful exact-room connection health in Mission World and room interiors without rendering raw provider identities or fabricating occupants. A local revocation regression proves fresh token issuance is denied after membership revocation and the previous request remains bounded to five minutes.
- [ ] Run live membership revocation and token-expiry enforcement, including the already-issued active-connection boundary, before any named presence roster, cursor, or selection UI.
- [ ] Choose the primary domain after naming is confirmed.
- [ ] Create production Convex, Ably, and Vercel environments only when the production release phase begins.

## Needed before autonomous agents run

- [ ] Add an OpenRouter key through encrypted environment settings and approve the exact DeepSeek model route after tool-calling and reliability tests.
- [ ] Add an OpenAI project key through the secure OpenAI setup flow if the control plane uses hosted OpenAI services.
- [ ] Approve default agent autonomy: recommendation is read-only exploration by default, explicit permission envelopes for writes, and human approval for publishing, spending, invitations, destructive actions, or external communication.
- [ ] Decide whether agents may act while no human is present. Recommendation: allow bounded resumable jobs, never unbounded resident agents.

## Needed before inviting other people

- [ ] Name the first three real projects that will be run inside Realworld.
- [ ] Invite five to ten trusted collaborators with different working styles.
- [ ] Define what content may be public, workspace-only, Mission-only, or private to one person.
- [ ] Approve community rules, reporting expectations, data export, and account deletion behavior.
- [ ] Schedule moderated sessions for solo, two-person, five-person, and ten-plus-person use.

## Later release decisions

- [ ] Choose pricing and quotas only after real cost and retention data exist.
- [ ] Approve a staged rollout: private personal use, trusted alpha, invite beta, then public discovery.
- [ ] Approve the production release only after security, recovery, load, accessibility, and role-boundary gates pass.
