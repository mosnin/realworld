# Dependency security

Production dependencies must pass `pnpm audit --prod --audit-level=low`. The
hosted release workflow enforces this after a frozen install and the reviewed
runtime dependency checks.

## Temporary development-tooling exception

- Advisory: `GHSA-mh99-v99m-4gvg` / `CVE-2026-14257`
- Reviewed: 2026-07-28
- Scope: `brace-expansion@1.1.16`, reached only through
  `minimatch@3.1.5` in ESLint and the Next.js ESLint plugin graph
- Production exposure: none in the current lockfile; every reported path is a
  development dependency
- Risk: attacker-influenced brace or glob input can exhaust the lint process
  memory; pull-request jobs remain bounded to fifteen minutes with
  `contents: read`

No compatible patched release exists for the required `brace-expansion` 1.x
line. Forcing version 5 beneath `minimatch` 3 is prohibited because it crosses
the declared dependency range and changes the CommonJS API. A direct ESLint 10
upgrade is also prohibited until the current import, React, and accessibility
plugins publish compatible peer ranges and remove their `minimatch` 3 paths.

The exception is reviewed through weekly npm Dependabot checks. Remove it as
soon as the complete ESLint and Next.js lint graph has an upstream-compatible
path to `minimatch` 10 and `brace-expansion` 5.0.8 or newer. That migration must
pass a frozen install, a full audit with this advisory absent, lint, typecheck,
unit and Convex tests, production build, and browser journeys. Do not execute
the advisory's out-of-memory proof of concept in CI.
