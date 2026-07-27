# Realworld Engineering Charter

## Product standard

Realworld is a production product, not a demo, prototype, or disposable MVP. Every phase must leave the repository in a coherent, testable state and must advance a real end-to-end user journey.

## Product language

- Project: Mission
- Task: Move
- Deliverable: Artifact
- Blocker: Fracture
- Request for help: Call
- Focused live session: Surge
- Activity state: Pulse
- Project rules: Constitution
- Alternative approach: Branch
- Verified milestone: Proof

## Architecture boundaries

- Convex owns durable shared state and the authoritative event history.
- Ephemeral realtime state must never become a second source of truth.
- Long-running agents are resumable, event-driven activations, not resident server processes.
- All agent actions have explicit identity, permissions, budgets, and traceable outcomes.
- Do not expose private chain-of-thought. Show concise operational status, evidence, actions, and confidence.
- Never commit credentials. Use `[REDACTED_SECRET]` in reports and examples.

## Delivery rules

- Keep parallel lanes non-overlapping. A worker owns only the files named in its task.
- Update `BUILD_LEDGER.md` and `.campaign/state.json` at phase boundaries.
- Do not claim a phase complete until its listed exit gates pass.
- Distinguish source review, automated checks, render checks, interaction checks, role checks, and persistent-state checks.
- Visual implementation requires an approved concept and a concept-to-browser fidelity review.
- Backend work must pass typecheck and a Convex push or an explicitly recorded deployment blocker.
- Do not deploy production or change paid infrastructure without a recorded release gate.

## Required checks

Once the application scaffold exists, every implementation phase must define and run:

- typecheck
- lint
- unit tests
- targeted integration tests
- browser interaction checks for changed journeys
- accessibility checks for changed surfaces
- production build

