# Protected cloud-preview acceptance

Run the narrow protected-preview acceptance only from a secret-capable runner. It is hard-bound to the reviewed stable protected preview origin. The harness creates two disposable private-alpha accounts and an invitation configured for a single use at runtime; it retains no account identity, invitation URL, token, share link, screenshot, trace, or video artifact on either a successful or failed normal exit. The live browser path consumes that invitation once; separate Convex authorization tests cover replay and usage enforcement.

Set these runner-only environment names through the secret manager, never in a checked-in file:

- `REALWORLD_CLOUD_PREVIEW_URL`: exactly `https://realworld-cloud-preview-mosnins-projects.vercel.app`, with no path, query, hash, or share-link parameter.
- `VERCEL_AUTOMATION_BYPASS_SECRET`: dedicated Vercel Protection Bypass for Automation secret for this test lane.

Then run:

```sh
pnpm test:e2e:cloud-preview
```

The command creates a uniquely named directory under the operating system temporary directory, points Playwright at it, and removes it in a `finally` block after both successful and failed normal exits. It fails before browser startup unless both names are present, and cloud mode positively selects only `cloud-preview.spec.ts` even when Playwright is invoked without a file argument. It sends the Vercel bypass and set-cookie headers to the owner context and the explicitly created reviewer context. Keep Vercel Deployment Protection enabled; use an automation-bypass secret rather than a Shareable Link, and rotate or revoke the dedicated secret when this lane is no longer needed.

The preview's Convex development backend intentionally retains the Mission, account, invite-hash, membership, and Pulse event records created by this acceptance run. The harness does not delete those durable records; review or reset that development data through an approved operational process, not through this browser test.
