import { expect, test, type Page } from "@playwright/test";

const diagnosticPath = "/verification/realtime-lifecycle";

async function count(page: Page, testId: string) {
  return Number(await page.getByTestId(testId).textContent());
}

test("the test-only lifecycle remains disabled until explicitly opted in", async ({ page }) => {
  await page.goto(diagnosticPath);

  await expect(page.getByRole("heading", { name: "Realtime lifecycle verification" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Lifecycle state" })).toHaveText("Lifecycle inactive");
  await expect(page.getByTestId("start-count")).toHaveText("0");
  await expect(page.getByTestId("stop-count")).toHaveText("0");
  await expect(page.getByTestId("publish-count")).toHaveText("0");
  await expect(page.getByTestId("source-factory-count")).toHaveText("0");
  await expect(page.getByTestId("session-factory-count")).toHaveText("0");

  await page.getByRole("button", { name: "Enable test lifecycle" }).click();
  await expect(page.getByRole("status", { name: "Lifecycle state" })).toHaveText("Lifecycle active");
  await expect(page.getByTestId("start-count")).toHaveText("1");
  await expect(page.getByTestId("source-factory-count")).toHaveText("1");
  await expect(page.getByTestId("session-factory-count")).toHaveText("1");

  await page.getByRole("button", { name: "Send neutral heartbeat" }).click();
  await expect(page.getByTestId("publish-count")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Enable test lifecycle" })).toBeDisabled();
});

test("real Chromium page focus/visibility changes do not disconnect an opted-in session", async ({ page, context }) => {
  await page.goto(diagnosticPath);
  await page.getByRole("button", { name: "Enable test lifecycle" }).click();
  await expect(page.getByTestId("start-count")).toHaveText("1");
  await expect(page.getByTestId("context-visible")).toHaveText("true");

  const otherPage = await context.newPage();
  try {
    await otherPage.goto("about:blank");
    await otherPage.bringToFront();
    try {
      await expect.poll(() => page.evaluate(() => ({
        visible: document.visibilityState === "hidden",
        focused: document.hasFocus() === false,
      })), { timeout: 1_500 }).toEqual({ visible: true, focused: true });
    } catch {
      test.skip(true, "Headless Chromium did not expose a real hidden/unfocused document after another page was brought to front.");
    }

    await expect(page.getByTestId("context-visible")).toHaveText("false");
    await expect(page.getByTestId("context-focused")).toHaveText("false");
    await expect(page.getByRole("status", { name: "Lifecycle state" })).toHaveText("Lifecycle active");
    await expect(page.getByTestId("start-count")).toHaveText("1");
    await expect(page.getByTestId("stop-count")).toHaveText("0");

    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => ({
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
    })), { timeout: 1_500 }).toEqual({ visible: true, focused: true });
    await expect(page.getByTestId("context-visible")).toHaveText("true");
    await expect(page.getByTestId("context-focused")).toHaveText("true");
  } finally {
    await otherPage.close();
  }
});

test("a real Chromium offline transition stops the opted-in session and online restarts it", async ({ page, context }) => {
  await page.goto(diagnosticPath);
  await page.getByRole("button", { name: "Enable test lifecycle" }).click();
  await expect(page.getByTestId("start-count")).toHaveText("1");

  await context.setOffline(true);

  try {
    await expect(page.getByTestId("context-online")).toHaveText("false", { timeout: 3_000 });
    await expect.poll(() => count(page, "stop-count"), { timeout: 3_000 }).toBe(1);
    await expect(page.getByRole("status", { name: "Lifecycle state" })).toHaveText("Lifecycle inactive");

    await context.setOffline(false);
    await expect(page.getByTestId("context-online")).toHaveText("true");
    await expect.poll(() => count(page, "start-count"), { timeout: 3_000 }).toBe(2);
    await expect(page.getByRole("status", { name: "Lifecycle state" })).toHaveText("Lifecycle active");
  } finally {
    await context.setOffline(false);
  }
});
