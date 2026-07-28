import AxeBuilder from "@axe-core/playwright";
import { expect, Page, test } from "@playwright/test";

async function expectNoSeriousOrCriticalAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const impactfulViolations = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );

  expect(impactfulViolations).toEqual([]);
}

async function launchPrivateMission(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Enter the Mission World." })).toBeVisible();
  await page.getByLabel("Email").fill(
    `accessibility-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
  );
  await page.getByLabel("Password").fill("Realworld-browser-test-2026");
  await page.getByRole("button", { name: "Need an invitation? Create an account" }).click();
  await page.getByRole("button", { name: "Create private-alpha account" }).click();
  await expect(
    page.getByRole("heading", { name: "Start a Mission with a real work shape." }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Launch Company sprint" }).click();
  await expect(page.getByRole("heading", { name: "Company sprint" })).toBeVisible({ timeout: 15_000 });
}

test("the private-alpha sign-in shell has no serious or critical axe violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Enter the Mission World." })).toBeVisible();

  await expectNoSeriousOrCriticalAxeViolations(page);
});

test("the authenticated Mission World has no serious or critical axe violations", async ({ page }) => {
  await launchPrivateMission(page);

  await expectNoSeriousOrCriticalAxeViolations(page);
});

test("the authenticated room directory has no serious or critical axe violations", async ({ page }) => {
  await launchPrivateMission(page);

  await page.getByRole("button", { name: "Room directory" }).click();
  await expect(page.getByRole("heading", { name: "Mission rooms" })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test("the authenticated Call dialog has no serious or critical axe violations", async ({ page }) => {
  await launchPrivateMission(page);

  await page.getByRole("button", { name: /Issue Call/ }).click();
  await expect(page.getByRole("dialog", { name: "Ask for a hand, in context" })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test.describe("on a phone-sized reduced-motion Mission World", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("has no serious or critical axe violations", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await launchPrivateMission(page);

    await expectNoSeriousOrCriticalAxeViolations(page);
  });
});
