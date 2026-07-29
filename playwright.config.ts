import { defineConfig, devices } from "@playwright/test";
import {
  requireCloudPreviewSettings,
  requireTemporaryCloudPreviewOutputDirectory,
} from "./tests/e2e/cloud-preview-settings";

const port = 3100;
const localBaseURL = `http://127.0.0.1:${port}`;
const cloudPreviewRun = process.env.REALWORLD_CLOUD_PREVIEW_E2E === "true";
const cloudPreviewSettings = cloudPreviewRun ? requireCloudPreviewSettings() : undefined;
const baseURL = cloudPreviewSettings?.baseURL ?? localBaseURL;
const extraHTTPHeaders = cloudPreviewSettings?.protectionHeaders;
const outputDir = cloudPreviewRun ? requireTemporaryCloudPreviewOutputDirectory() : "test-results";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: cloudPreviewRun ? undefined : ["**/cloud-preview.spec.ts"],
  testMatch: cloudPreviewRun ? "**/cloud-preview.spec.ts" : undefined,
  outputDir,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: cloudPreviewRun ? (process.env.CI ? "github" : "line") : process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    extraHTTPHeaders,
    screenshot: cloudPreviewRun ? "off" : undefined,
    trace: cloudPreviewRun ? "off" : "on-first-retry",
    video: cloudPreviewRun ? "off" : undefined,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: cloudPreviewRun ? undefined : {
    command: `pnpm dev --port ${port}`,
    url: `${localBaseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
