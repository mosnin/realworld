import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
  await expect(page.getByRole("heading", { name: "Choose your callsign" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "Callsign", exact: true }).fill("Access Pilot");
  await page.getByRole("button", { name: "Save callsign" }).click();
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

test("the callsign setup gate has no serious or critical axe violations", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(`callsign-a11y-${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("Realworld-browser-test-2026");
  await page.getByRole("button", { name: "Need an invitation? Create an account" }).click();
  await page.getByRole("button", { name: "Create private-alpha account" }).click();
  await expect(page.getByRole("heading", { name: "Choose your callsign" })).toBeVisible({ timeout: 15_000 });
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

test("the authenticated Fracture dialog has no serious or critical axe violations", async ({ page }) => {
  await launchPrivateMission(page);

  await page.getByRole("button", { name: /Open Fractures/ }).click();
  await expect(page.getByRole("dialog", { name: "Name the break, hold the line" })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test("the authenticated Proof dialog has no serious or critical axe violations", async ({ page }) => {
  await launchPrivateMission(page);

  await page.getByRole("button", { name: /Open Proofs/ }).click();
  await expect(page.getByRole("dialog", { name: "Make the work verifiable" })).toBeVisible();
  await expectNoSeriousOrCriticalAxeViolations(page);
});

test.describe("on an expanded desktop Mission World", () => {
  test.use({ viewport: { width: 1728, height: 1117 } });

  test("the wide Mission header has no serious or critical axe violations", async ({
    page,
  }) => {
    await launchPrivateMission(page);
    const newMission = page.getByRole("button", { name: "New Mission" });
    await expect(newMission).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await expectNoSeriousOrCriticalAxeViolations(page);
  });
});

test.describe("on a constrained desktop Mission World", () => {
  test.use({ viewport: { width: 1600, height: 1057 } });

  test("the action rail stays readable on a constrained desktop", async ({ page }) => {
    await launchPrivateMission(page);

    await expect(page.getByRole("button", { name: "New Mission" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });
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
