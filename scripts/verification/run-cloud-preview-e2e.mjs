import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outputDirectory = mkdtempSync(join(tmpdir(), "realworld-cloud-preview-"));
const playwrightArguments = process.argv.slice(2);
if (playwrightArguments[0] === "--") {
  playwrightArguments.shift();
}

try {
  const result = spawnSync("pnpm", ["exec", "playwright", "test", ...playwrightArguments], {
    env: {
      ...process.env,
      REALWORLD_CLOUD_PREVIEW_E2E: "true",
      REALWORLD_CLOUD_PREVIEW_OUTPUT_DIR: outputDirectory,
    },
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outputDirectory, { force: true, recursive: true });
}
