import { expect, test } from "@playwright/test";

test("a participant can inspect and enter Workshop from the Mission World", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Build an open-source multiplayer music studio" })).toBeVisible();
  await page.getByRole("button", { name: /Workshop\. 4 active people/i }).click();
  await expect(page.getByRole("heading", { name: "Workshop" })).toBeVisible();
  await page.getByRole("complementary", { name: "Workshop" }).getByRole("button", { name: "Enter Workshop" }).click();
  await expect(page.getByRole("heading", { name: "Make room entry feel instantly useful" })).toBeVisible();
  await page.getByRole("button", { name: "Mission World" }).click();
  await expect(page.getByRole("heading", { name: "Build an open-source multiplayer music studio" })).toBeVisible();
});

test("the room directory provides a non-spatial path to Workshop", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Room directory" }).click();
  await expect(page.getByRole("heading", { name: "Mission rooms" })).toBeVisible();
  await page.locator(".room-directory").getByRole("button", { name: "Enter Workshop" }).click();
  await expect(page.getByRole("heading", { name: "Make room entry feel instantly useful" })).toBeVisible();
});

test("keyboard users can move between spatial landmarks without pointer input", async ({ page }) => {
  await page.goto("/");

  const workshop = page.getByRole("button", { name: /Workshop\. 4 active people/i });
  await workshop.focus();
  await page.keyboard.press("ArrowRight");

  await expect(page.getByRole("complementary", { name: "Branch Lab" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Branch Lab\. 5 active people/i })).toBeFocused();
});
