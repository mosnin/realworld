# Founder Actions

Do not paste secrets into issues, commits, Notion, or chat. Add credentials only through the relevant provider's encrypted environment settings.

## Needed now

- [ ] Confirm that the visual direction is **Living Atlas + Mission World rooms**: a navigable map for Missions with tactile room interiors, Google Docs-level presence, and cooperative-game immediacy.
- [ ] Confirm the working product name `Realworld`; a naming and trademark check can happen before public launch.
- [ ] Choose the initial sign-in policy. Recommendation: invite-only workspaces with email/social sign-in, private Missions by default, and explicit publishing.
- [ ] Set a monthly AI spend ceiling and a per-Mission default budget. Recommendation for private development: a hard global cap plus visible per-agent run budgets.

## Needed for the production foundation

- [ ] Connect or create the Convex production and preview deployments.
- [ ] Create an Ably application and add separate preview and production credentials to encrypted Vercel environment settings.
- [ ] Connect the Vercel project, select the owning team, and decide whether a custom domain is needed before private alpha.
- [ ] Choose the primary domain once naming is confirmed.

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

