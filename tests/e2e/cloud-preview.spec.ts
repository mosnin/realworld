import { expect, test, type Browser, type Page } from "@playwright/test";
import { requireCloudPreviewSettings } from "./cloud-preview-settings";

const { baseURL: previewOrigin, protectionHeaders } = requireCloudPreviewSettings();

async function createPrivateAlphaAccount(page: Page, label: string) {
  const password = `Rw-${Date.now()}-${Math.random().toString(36).slice(2)}-aA7!`;
  await expect(page.getByRole("heading", { name: "Enter the Mission World." })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Email").fill(
    `cloud-preview-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
  );
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Need an invitation? Create an account" }).click();
  await page.getByRole("button", { name: "Create private-alpha account" }).click();
  await expect(page.getByRole("heading", { name: "Choose your callsign" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("textbox", { name: "Callsign", exact: true }).fill(label);
  await page.getByRole("button", { name: "Save callsign" }).click();
}

async function enterWorkshop(page: Page) {
  await page.getByRole("button", { name: /^Workshop\./ }).click();
  await page.getByRole("complementary", { name: "Workshop" }).getByRole("button", { name: "Open room work" }).click();
  await expect(page.getByRole("heading", { name: "Durable work in Workshop." })).toBeVisible({ timeout: 20_000 });
}

async function newProtectedContext(browser: Browser) {
  return browser.newContext({
    baseURL: previewOrigin,
    extraHTTPHeaders: protectionHeaders,
  });
}

test.use({ extraHTTPHeaders: protectionHeaders });

test("protected preview supports a fresh Blank canvas owner and a reviewer accepting a single-use-configured scoped invite", async ({ browser, page }) => {
  test.setTimeout(120_000);

  await page.goto("/");
  await createPrivateAlphaAccount(page, "Cloud Owner");
  await expect(page.getByRole("heading", { name: "Start a Mission with a real work shape." })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Launch Blank canvas" }).click();
  await expect(page.getByRole("heading", { name: "Blank canvas" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /^Workshop\./ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Blank canvas" })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Invite collaborators" }).click();
  const invitations = page.getByRole("dialog", { name: "Invite collaborators" });
  await invitations.getByLabel("Role").selectOption("reviewer");
  await invitations.getByRole("checkbox", { name: /Workshop/i }).check();
  await invitations.getByLabel("Maximum uses").fill("1");
  await invitations.getByRole("button", { name: "Create invitation" }).click();
  const inviteURL = await invitations.getByLabel("Invitation link").inputValue();
  const parsedInviteURL = new URL(inviteURL);
  expect(parsedInviteURL.origin).toBe(previewOrigin);
  expect(parsedInviteURL.pathname.startsWith("/invite/")).toBe(true);

  const reviewerContext = await newProtectedContext(browser);
  try {
    const reviewer = await reviewerContext.newPage();
    await reviewer.goto("/");
    await reviewer.evaluate((target) => window.location.assign(target), inviteURL);
    await createPrivateAlphaAccount(reviewer, "Cloud Reviewer");
    await expect(reviewer.getByRole("heading", { name: "You have a Mission invitation." })).toBeVisible({ timeout: 20_000 });
    await reviewer.getByRole("button", { name: "Join Mission" }).click();
    await expect(reviewer.getByText("You joined the Mission.")).toBeVisible({ timeout: 20_000 });
    await reviewer.getByRole("link", { name: "Enter the Mission World" }).click();
    await expect(reviewer.getByRole("heading", { name: "Blank canvas" })).toBeVisible({ timeout: 20_000 });
    await expect(reviewer.getByText("reviewer", { exact: true })).toBeVisible();
    await expect(reviewer.getByRole("button", { name: /^Workshop\./ })).toHaveCount(1);
    await expect(reviewer.getByRole("button", { name: /^Mission Core\./ })).toHaveCount(0);

    await page.getByRole("button", { name: "Close invitations" }).click();
    const ownerPulse = page.getByLabel("Mission activity Pulse");
    await ownerPulse.getByRole("button", { name: /Open Mission Pulse/ }).click();
    const ownerActivity = ownerPulse.getByLabel("Recent durable Mission activity");
    await expect(ownerActivity.getByRole("button", { name: /Contributor joined through a scoped invite/ })).toBeVisible({ timeout: 20_000 });

    await enterWorkshop(reviewer);
    await reviewer.reload();
    await expect(reviewer.getByRole("heading", { name: "Blank canvas" })).toBeVisible({ timeout: 20_000 });
    await expect(reviewer.getByRole("button", { name: /^Workshop\./ })).toHaveCount(1);
    await expect(reviewer.getByRole("button", { name: /^Mission Core\./ })).toHaveCount(0);
  } finally {
    await reviewerContext.close();
  }
});
