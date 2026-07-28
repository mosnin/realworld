#!/usr/bin/env node

import { existsSync } from "node:fs";

const phaseArgument = process.argv.find((argument) => argument.startsWith("--phase="));
const phase = phaseArgument?.split("=", 2)[1] ?? "foundation";

const requirements = {
  foundation: {
    automated: ["install", "lint", "typecheck", "unit", "convex-tests", "build", "chromium", "accessibility"],
    render: ["mission-world"],
    interaction: ["mission-world", "room-directory", "keyboard"],
    role: [],
    persistentState: [],
    deployment: [],
  },
  phase1: {
    automated: ["install", "lint", "typecheck", "unit", "convex-tests", "build", "chromium", "accessibility"],
    render: ["mission-world", "authenticated-shell"],
    interaction: ["mission-world", "room-directory", "keyboard", "authenticated-shell"],
    role: ["authorization"],
    persistentState: ["mission-state"],
    deployment: ["vercel-preview"],
  },
};

if (!(phase in requirements)) {
  console.error(`Unknown evidence phase: ${phase}. Use foundation or phase1.`);
  process.exit(2);
}

function values(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

const evidence = {
  automated: values("RW_EVIDENCE_AUTOMATED"),
  render: values("RW_EVIDENCE_RENDER"),
  interaction: values("RW_EVIDENCE_INTERACTION"),
  role: values("RW_EVIDENCE_ROLE"),
  persistentState: values("RW_EVIDENCE_PERSISTENT_STATE"),
  deployment: values("RW_EVIDENCE_DEPLOYMENT"),
};

const structuralChecks = [
  ".github/workflows/ci.yml",
  "tests/e2e/mission-world.spec.ts",
  "tests/e2e/health.spec.ts",
  "convex/schema.ts",
].filter((path) => !existsSync(path));

const required = requirements[phase];
const missing = Object.fromEntries(
  Object.entries(required)
    .map(([kind, expected]) => [kind, expected.filter((item) => !evidence[kind].includes(item))])
    .filter(([, items]) => items.length > 0),
);

const report = {
  phase,
  result: structuralChecks.length === 0 && Object.keys(missing).length === 0 ? "pass" : "fail",
  evidence,
  missing,
  structuralChecks,
  labels: {
    A: "automated",
    R: "render/reachability",
    I: "real browser interaction",
    Role: "distinct effective roles/sessions",
    P: "persistent state readback/reconnect",
  },
  truth: "This report only certifies evidence named above. It does not certify production deployment, auth, role isolation, or persistence unless those labels are present.",
};

console.log(JSON.stringify(report, null, 2));

if (report.result === "fail") {
  console.error(`Evidence gate failed for ${phase}.`);
  process.exit(1);
}
