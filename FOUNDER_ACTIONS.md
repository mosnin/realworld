# Founder Actions

Do not paste secrets into issues, commits, Notion, or chat. Add credentials only through the relevant provider's encrypted environment settings.

## Needed now

- [x] Confirm the visual direction as **Living Atlas + Mission World rooms**: a navigable, customizable canvas with tactile room interiors, Google Docs-level presence, and cooperative-game immediacy.
- [x] Confirm the working product name `Realworld`; a naming and trademark check can happen before public launch.
- [ ] Choose the initial sign-in policy. Recommendation: invite-only workspaces with email/social sign-in, private Missions by default, and explicit publishing.
- [ ] Set a monthly AI spend ceiling and a per-Mission default budget. Recommendation for private development: a hard global cap plus visible per-agent run budgets.
- [x] Approved **Blank canvas** as a real Mission type beside the guided templates, so a Mission may begin with a genuinely empty Workshop through the normal product flow.

## Next release gate: cloud development preview

- [ ] In Convex, select or create one **development** deployment. Do not connect production yet.
- [ ] Give the preview a stable Vercel origin or branch alias; Convex Auth's `SITE_URL` must not point at a disposable deployment URL.
- [ ] Run the Convex Auth setup flow for that stable preview origin so the development deployment receives encrypted `SITE_URL`, `JWT_PRIVATE_KEY`, and `JWKS` values. Never paste those values into source, chat, or Notion.
- [ ] In the Vercel project's **Preview** environment, set `NEXT_PUBLIC_CONVEX_URL` to that same Convex development deployment and set `NEXT_PUBLIC_APP_ENV=preview`.
- [ ] Redeploy one preview, then verify account creation, sign-in, Mission launch, scoped invitation acceptance in a second browser session, and reload persistence.

Already complete:

- [x] GitHub is connected and the authenticated release gate runs in Actions.
- [x] Vercel is linked to the `realworld` project and has produced a preview build.

Do not add Ably, OpenAI, or OpenRouter credentials before this cloud-preview gate passes.

## Needed immediately after the cloud preview gate

- [ ] Create a dedicated Ably **development** application; keep Convex authoritative for durable state and Ably limited to ephemeral presence.
- [ ] In the connected Convex development deployment, set encrypted `REALWORLD_APP_ENV=preview` and `ABLY_API_KEY` from that development-only Ably application. Never place the key in Vercel browser variables, source, chat, or Notion.
- [ ] Run the first scoped connection and revocation/reconnect checks before any participant-facing presence UI. Production token issuance remains hard-disabled in code.
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
