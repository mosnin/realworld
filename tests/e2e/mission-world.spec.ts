import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto("/");

  const missionHeading = page.getByRole("heading", { name: "Company sprint" });
  if (await missionHeading.isVisible()) {
    return;
  }

  await expect(page.getByRole("heading", { name: "Enter the Mission World." })).toBeVisible();
  await page.getByLabel("Email").fill(
    `browser-${testInfo.workerIndex}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
  );
  await page.getByLabel("Password").fill("Realworld-browser-test-2026");
  await page.getByRole("button", { name: "Need an invitation? Create an account" }).click();
  const createAccount = page.getByRole("button", { name: "Create private-alpha account" });
  await expect(createAccount).toBeVisible();
  await createAccount.click();
  await expect(
    page.getByRole("heading", { name: "Start a Mission with a real work shape." }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Launch Company sprint" }).click();
  await expect(missionHeading).toBeVisible({ timeout: 15_000 });
});

test("a participant can inspect and enter Workshop from the Mission World", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Company sprint" })).toBeVisible();
  await expect(page.getByText(/music studio|digital audio workstation/i)).toHaveCount(0);
  await page.getByRole("button", { name: /Workshop\. 4 active people/i }).click();
  await expect(page.getByRole("heading", { name: "Workshop" })).toBeVisible();
  await page.getByRole("complementary", { name: "Workshop" }).getByRole("button", { name: "Enter Workshop" }).click();
  await expect(page.getByRole("heading", { name: "Make room entry feel instantly useful" })).toBeVisible();
  await page.getByRole("button", { name: "Mission World" }).click();
  await expect(page.getByRole("heading", { name: "Company sprint" })).toBeVisible();
});

test("the room directory provides a non-spatial path to Workshop", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Room directory" }).click();
  await expect(page.getByRole("heading", { name: "Mission rooms" })).toBeVisible();
  await page.locator(".room-directory").getByRole("button", { name: "Enter Workshop" }).click();
  await expect(page.getByRole("heading", { name: "Make room entry feel instantly useful" })).toBeVisible();
});

test.describe("on a phone-sized Mission World", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("a participant can enter Workshop through the mobile room directory", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Company sprint" })).toBeVisible();
    await page.getByRole("button", { name: "Room directory" }).click();
    await expect(page.getByRole("heading", { name: "Mission rooms" })).toBeVisible();

    await page.locator(".room-directory").getByRole("button", { name: "Enter Workshop" }).click();
    await expect(page.getByRole("heading", { name: "A room should answer one useful question immediately." })).toBeVisible();

    await page.getByRole("button", { name: "Mission World" }).click();
    await expect(page.getByRole("heading", { name: "Company sprint" })).toBeVisible();
  });
});

test("keyboard users can move between spatial landmarks without pointer input", async ({ page }) => {
  await page.goto("/");

  const workshop = page.getByRole("button", { name: /Workshop\. 4 active people/i });
  await workshop.focus();
  await page.keyboard.press("ArrowRight");

  await expect(page.getByRole("complementary", { name: "Review Deck" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Review Deck\. 3 active people/i })).toBeFocused();
});

test("view preferences persist density, accent, reduced decoration, and default room list", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Open world preferences" }).click();
  const dialog = page.getByRole("dialog", { name: "World preferences" });
  await dialog.getByRole("button", { name: "compact" }).click();
  await dialog.getByRole("button", { name: "teal accent" }).click();
  await dialog.getByRole("button", { name: "Room directory" }).click();
  await dialog.getByRole("checkbox", { name: /Reduced decoration/i }).check();
  await page.getByRole("button", { name: "Close preferences" }).click();

  await expect(page.getByRole("heading", { name: "Mission rooms" })).toBeVisible();
  await expect(page.locator(".mission-world")).toHaveAttribute("data-density", "compact");
  await expect(page.locator(".mission-world")).toHaveAttribute("data-accent", "teal");
  await expect(page.locator(".mission-world")).toHaveAttribute("data-decoration", "reduced");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Mission rooms" })).toBeVisible();
  await expect(page.locator(".mission-world")).toHaveAttribute("data-accent", "teal");
});

test("reduced-motion presentation retains a usable Mission World", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.getByRole("button", { name: /Workshop\. 4 active people/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Room directory" })).toBeVisible();
});

test("a participant can customize and persist a personal canvas layout", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("New room").fill("Release Cabin");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("complementary", { name: "Release Cabin" })).toBeVisible();

  const nameInput = page.getByLabel("Room name");
  await nameInput.fill("Launch Cabin");
  await nameInput.press("Tab");
  await expect(page.getByRole("heading", { name: "Launch Cabin" })).toBeVisible();

  const customRoom = page.getByRole("button", { name: /Launch Cabin\. 0 active people/i });
  await customRoom.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Layout unlocked" }).click();
  await page.reload();

  await expect(page.getByRole("button", { name: /Launch Cabin\. 0 active people/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Layout locked" })).toBeVisible();
  await page.getByRole("button", { name: /Launch Cabin\. 0 active people/i }).click();
  await page.getByRole("button", { name: "Archive room" }).click();
  await expect(page.getByRole("button", { name: /Launch Cabin\. 0 active people/i })).toHaveCount(0);
});

// The following invitation journey handles a bearer URL. Do not retain it in Playwright traces.
test.use({ trace: "off" });

test.describe("a reactive scoped Mission canvas", () => {
  test("an owner can invite a participant and their Workshop map reacts without a reload", async ({ browser, page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Invite collaborators" }).click();

  const invitations = page.getByRole("dialog", { name: "Invite collaborators" });
  await expect(invitations.getByRole("heading", { name: "Invite collaborators" })).toBeVisible();
  await invitations.getByRole("checkbox", { name: /Workshop/i }).check();
  await invitations.getByRole("button", { name: "Create invitation" }).click();

  const inviteUrl = await invitations.getByLabel("Invitation link").inputValue();
  expect(inviteUrl).toContain("/invite/");

  const participantContext = await browser.newContext();
  try {
    const participant = await participantContext.newPage();
    await participant.goto(inviteUrl);
    await participant.getByLabel("Email").fill(
      `invited-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
    );
    await participant.getByLabel("Password").fill("Realworld-browser-test-2026");
    await participant.getByRole("button", { name: "Need an invitation? Create an account" }).click();
    await participant.getByRole("button", { name: "Create private-alpha account" }).click();

    await expect(participant.getByRole("heading", { name: "You have a Mission invitation." })).toBeVisible({ timeout: 15_000 });
    await participant.getByRole("button", { name: "Join Mission" }).click();
    await expect(participant.getByText("You joined the Mission.")).toBeVisible();
    await participant.getByRole("link", { name: "Enter the Mission World" }).click();

    await expect(participant.getByRole("heading", { name: "Company sprint" })).toBeVisible();
    await expect(participant.getByText("contributor", { exact: true })).toBeVisible();
    await expect(participant.getByRole("button", { name: /Mission Core\./i })).toHaveCount(0);
    await expect(participant.getByRole("button", { name: /Review Deck\./i })).toHaveCount(0);

    const participantWorkshop = participant.getByRole("button", { name: /Workshop\. 4 active people/i });
    await expect(participantWorkshop).toBeVisible();
    const initialParticipantPosition = await participantWorkshop.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }));

    await page.getByRole("button", { name: "Close invitations" }).click();
    await expect(invitations).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Layout unlocked" })).toBeVisible();

    const ownerWorkshop = page.getByRole("button", { name: /Workshop\. 4 active people/i });
    const initialOwnerPosition = await ownerWorkshop.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }));
    await ownerWorkshop.focus();
    await page.keyboard.press("Alt+ArrowRight");

    await expect.poll(async () => ownerWorkshop.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }))).not.toEqual(initialOwnerPosition);
    const updatedOwnerPosition = await ownerWorkshop.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }));
    expect(updatedOwnerPosition).not.toEqual(initialParticipantPosition);

    await expect.poll(async () => participantWorkshop.evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    })), { timeout: 15_000 }).toEqual(updatedOwnerPosition);

    await participant.reload();
    await expect(participant.getByRole("heading", { name: "Company sprint" })).toBeVisible();
    await expect.poll(async () => participant.getByRole("button", { name: /Workshop\. 4 active people/i }).evaluate((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
    }))).toEqual(updatedOwnerPosition);
  } finally {
    await participantContext.close();
  }
  });

  test("concurrent builders receive conflict recovery and reconnect to the authoritative Workshop layout", async ({ browser, page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Invite collaborators" }).click();

    const invitations = page.getByRole("dialog", { name: "Invite collaborators" });
    await expect(invitations.getByRole("heading", { name: "Invite collaborators" })).toBeVisible();
    await invitations.getByLabel("Role").selectOption("builder");
    await invitations.getByRole("checkbox", { name: /Workshop/i }).check();
    await invitations.getByRole("button", { name: "Create invitation" }).click();

    const inviteUrl = await invitations.getByLabel("Invitation link").inputValue();
    const builderContext = await browser.newContext();
    try {
      const builder = await builderContext.newPage();
      await builder.goto(inviteUrl);
      await builder.getByLabel("Email").fill(
        `builder-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      );
      await builder.getByLabel("Password").fill("Realworld-browser-test-2026");
      await builder.getByRole("button", { name: "Need an invitation? Create an account" }).click();
      await builder.getByRole("button", { name: "Create private-alpha account" }).click();
      await expect(builder.getByRole("heading", { name: "You have a Mission invitation." })).toBeVisible({ timeout: 15_000 });
      await builder.getByRole("button", { name: "Join Mission" }).click();
      await builder.getByRole("link", { name: "Enter the Mission World" }).click();

      await expect(builder.getByText("builder", { exact: true })).toBeVisible();
      const ownerWorkshop = page.getByRole("button", { name: /Workshop\. 4 active people/i });
      const builderWorkshop = builder.getByRole("button", { name: /Workshop\. 4 active people/i });
      await expect(ownerWorkshop).toBeVisible();
      await expect(builderWorkshop).toBeVisible();
      await page.getByRole("button", { name: "Close invitations" }).click();
      await expect(page.getByRole("button", { name: "Layout unlocked" })).toBeVisible();
      await expect(builder.getByRole("button", { name: "Layout unlocked" })).toBeVisible();

      const initialOwnerPosition = await ownerWorkshop.evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
      }));
      const initialBuilderPosition = await builderWorkshop.evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
      }));
      expect(initialBuilderPosition).toEqual(initialOwnerPosition);

      await Promise.all([ownerWorkshop.focus(), builderWorkshop.focus()]);
      await Promise.all([
        page.keyboard.press("Alt+ArrowRight"),
        builder.keyboard.press("Alt+ArrowLeft"),
      ]);

      const conflictMessage = "That room changed elsewhere. The live map has been refreshed.";
      await expect.poll(async () => {
        const [ownerConflictCount, builderConflictCount] = await Promise.all([
          page.getByText(conflictMessage).count(),
          builder.getByText(conflictMessage).count(),
        ]);
        return ownerConflictCount + builderConflictCount;
      }, { timeout: 15_000 }).toBeGreaterThan(0);

      await expect.poll(async () => {
        const [ownerPosition, builderPosition] = await Promise.all([
          ownerWorkshop.evaluate((element) => ({ left: (element as HTMLElement).style.left, top: (element as HTMLElement).style.top })),
          builderWorkshop.evaluate((element) => ({ left: (element as HTMLElement).style.left, top: (element as HTMLElement).style.top })),
        ]);
        return ownerPosition.left === builderPosition.left && ownerPosition.top === builderPosition.top;
      }, { timeout: 15_000 }).toBe(true);
      const authoritativePosition = await ownerWorkshop.evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
      }));
      expect(authoritativePosition).not.toEqual(initialOwnerPosition);

      await builder.reload();
      await expect(builder.getByRole("heading", { name: "Company sprint" })).toBeVisible();
      await expect.poll(async () => builder.getByRole("button", { name: /Workshop\. 4 active people/i }).evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
      }))).toEqual(authoritativePosition);
    } finally {
      await builderContext.close();
    }
  });
});
