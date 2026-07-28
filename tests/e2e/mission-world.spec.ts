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

test("an owner can archive a Mission into a read-only world, restore it, and keep it active", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Manage Mission" }).click();
  await expect(page.getByRole("button", { name: "Archive Mission" })).toBeVisible();
  await page.getByRole("button", { name: "Archive Mission" }).click();

  await expect(page.getByRole("status", { name: "Archived Mission read-only" })).toBeVisible();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite collaborators" })).toHaveCount(0);
  await expect(page.getByLabel("New room")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create room" })).toHaveCount(0);
  await expect(page.getByLabel("Room name")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive room" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Layout unlocked" })).toBeDisabled();

  const archivedWorkshop = page.getByRole("button", { name: /Workshop\. 4 active people/i });
  const archivedPosition = await archivedWorkshop.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  await archivedWorkshop.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(250);
  expect(await archivedWorkshop.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }))).toEqual(archivedPosition);

  await page.getByRole("button", { name: "Room directory" }).click();
  await expect(page.locator(".room-directory").getByRole("button", { name: "Enter Workshop" })).toBeDisabled();

  await page.getByRole("button", { name: "Restore Mission" }).click();
  await expect(page.getByRole("status", { name: "Archived Mission read-only" })).toHaveCount(0);
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite collaborators" })).toBeVisible();
  await expect(page.getByLabel("New room")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create room" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Layout unlocked" })).toBeEnabled();

  await page.getByRole("button", { name: "Map" }).click();
  const restoredWorkshop = page.getByRole("button", { name: /Workshop\. 4 active people/i });
  const restoredPosition = await restoredWorkshop.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }));
  await restoredWorkshop.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(async () => restoredWorkshop.evaluate((element) => ({
    left: (element as HTMLElement).style.left,
    top: (element as HTMLElement).style.top,
  }))).not.toEqual(restoredPosition);

  await page.reload();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite collaborators" })).toBeVisible();
  await expect(page.getByLabel("New room")).toBeVisible();
});

test("an owner can create, switch, archive, and recover separate Mission worlds", async ({ page }) => {
  await page.goto("/");

  const missionSelector = page.getByLabel("Selected Mission");
  await expect(missionSelector).toHaveValue(await missionSelector.inputValue());
  const firstMissionId = await missionSelector.inputValue();
  await expect(page.getByRole("heading", { name: "Company sprint" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Surge Hall\. 12 active people/i })).toBeVisible();

  await page.getByRole("button", { name: "New Mission" }).click();
  const launcher = page.getByRole("dialog", { name: "Choose a work shape" });
  await expect(launcher).toBeVisible();
  await launcher.getByRole("button", { name: "Launch Classroom project" }).click();

  await expect(page.getByRole("heading", { name: "Classroom project" })).toBeVisible();
  const secondMissionId = await missionSelector.inputValue();
  expect(secondMissionId).not.toBe(firstMissionId);
  await expect(page.getByRole("button", { name: /Observatory\. 3 active people/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Surge Hall\. 12 active people/i })).toHaveCount(0);

  await missionSelector.selectOption(firstMissionId);
  await expect(page.getByRole("heading", { name: "Company sprint" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Surge Hall\. 12 active people/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Observatory\. 3 active people/i })).toHaveCount(0);

  await missionSelector.selectOption(secondMissionId);
  await expect(page.getByRole("heading", { name: "Classroom project" })).toBeVisible();
  await page.reload();
  await expect(missionSelector).toHaveValue(secondMissionId);
  await expect(page.getByRole("heading", { name: "Classroom project" })).toBeVisible();

  await page.getByRole("button", { name: "Manage Mission" }).click();
  await page.getByRole("button", { name: "Archive Mission" }).click();
  await expect(page.getByRole("status", { name: "Archived Mission read-only" })).toBeVisible();
  await expect(missionSelector).toHaveValue(secondMissionId);
  await expect(page.getByRole("button", { name: "Layout unlocked" })).toBeDisabled();

  await missionSelector.selectOption(firstMissionId);
  await expect(missionSelector).toHaveValue(firstMissionId);
  await expect(page.getByRole("heading", { name: "Company sprint" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Archived Mission read-only" })).toHaveCount(0);
  await expect(page.getByLabel("New room")).toBeVisible();
  await expect(page.getByRole("button", { name: "Layout unlocked" })).toBeEnabled();
});

test("an owner can save, archive, restore, and persist governing intent", async ({ page }) => {
  const constitution = "Build a durable multiplayer work system with accountable human and agent collaboration.";
  const firstOutcome = "Ship a trustworthy shared Mission world.";
  const secondOutcome = "Make every important change attributable and reviewable.";
  const revisedOutcome = "Keep every important change attributable, reviewable, and durable.";

  await page.goto("/");
  const governingIntent = page.getByRole("heading", { name: "Governing intent" }).locator("..");
  await expect(governingIntent.getByText("No Constitution has been set yet.")).toBeVisible();

  await governingIntent.getByRole("button", { name: "Edit governing intent" }).click();
  await governingIntent.getByLabel("Mission Constitution").fill(constitution);
  await governingIntent.getByLabel("Outcome 1").fill(firstOutcome);
  await governingIntent.getByRole("button", { name: "Add outcome" }).click();
  await governingIntent.getByLabel("Outcome 2").fill(secondOutcome);
  await governingIntent.getByRole("button", { name: "Save governing intent" }).click();
  await expect(governingIntent.getByText("Governing intent saved.")).toBeVisible();
  await expect(governingIntent.getByRole("button", { name: "Edit governing intent" })).toBeVisible();
  await expect(governingIntent.getByText(constitution)).toBeVisible();
  await expect(governingIntent.getByText(firstOutcome)).toBeVisible();
  await expect(governingIntent.getByText(secondOutcome)).toBeVisible();

  await page.reload();
  await expect(governingIntent.getByText(constitution)).toBeVisible();
  await expect(governingIntent.getByText(firstOutcome)).toBeVisible();
  await expect(governingIntent.getByText(secondOutcome)).toBeVisible();

  await governingIntent.getByRole("button", { name: "Edit governing intent" }).click();
  await governingIntent.getByLabel("Outcome 2").fill(revisedOutcome);
  await governingIntent.getByRole("button", { name: "Save governing intent" }).click();
  await expect(governingIntent.getByText("Governing intent saved.")).toBeVisible();
  await expect(governingIntent.getByRole("button", { name: "Edit governing intent" })).toBeVisible();
  await expect(governingIntent.getByText(revisedOutcome)).toBeVisible();

  await page.getByRole("button", { name: "Manage Mission" }).click();
  await page.getByRole("button", { name: "Archive Mission" }).click();
  await expect(page.getByRole("status", { name: "Archived Mission read-only" })).toBeVisible();
  await expect(governingIntent.getByLabel("Governing intent read-only")).toHaveText("Archived Mission — governing intent is read-only.");
  await expect(governingIntent.getByText(constitution)).toBeVisible();
  await expect(governingIntent.getByText(revisedOutcome)).toBeVisible();

  await page.getByRole("button", { name: "Restore Mission" }).click();
  await expect(page.getByRole("status", { name: "Archived Mission read-only" })).toHaveCount(0);
  await expect(governingIntent.getByRole("button", { name: "Edit governing intent" })).toBeVisible();
  await expect(governingIntent.getByText(constitution)).toBeVisible();
  await expect(governingIntent.getByText(revisedOutcome)).toBeVisible();

  await page.reload();
  await expect(governingIntent.getByText(constitution)).toBeVisible();
  await expect(governingIntent.getByText(revisedOutcome)).toBeVisible();
});

// The following invitation journey handles a bearer URL. Do not retain it in Playwright traces.
test.use({ trace: "off" });

test("an owner can create, link, advance, and reload durable Moves", async ({ page }) => {
  const initialTitle = "Prepare release evidence";
  const updatedTitle = "Prepare verified release evidence";
  const updatedIntent = "Collect attributable evidence before publishing the release proof.";
  const prerequisite = "Set the sprint outcome";

  await page.goto("/");
  await page.getByRole("button", { name: /Open Moves/ }).click();
  const board = page.getByRole("dialog", { name: "Turn intent into progress" });
  await expect(board.getByRole("article", { name: `Move ${prerequisite}` })).toBeVisible();

  await board.getByLabel("Move title").fill(initialTitle);
  await board.getByLabel("Move intent").fill("Collect release evidence.");
  await board.getByLabel("Room").selectOption({ label: "Workshop" });
  await board.getByRole("button", { name: "Create Move" }).click();
  await expect(board.getByText("Move created.")).toBeVisible();

  const createdMove = board.getByRole("article", { name: `Move ${initialTitle}` });
  const editCreatedMove = createdMove.getByRole("button", { name: `Edit Move ${initialTitle}` });
  await editCreatedMove.click();
  await createdMove.getByLabel("Move title").fill(updatedTitle);
  await createdMove.getByLabel("Move intent").fill(updatedIntent);
  const dependency = createdMove.getByLabel(prerequisite);
  await dependency.focus();
  await page.keyboard.press("Space");
  const saveMove = createdMove.getByRole("button", { name: "Save Move" });
  await saveMove.click();
  await expect(board.getByText("Move details saved.")).toBeVisible();
  await expect(board.getByRole("article", { name: `Move ${updatedTitle}` }).getByText(`Depends on ${prerequisite}`)).toBeVisible();

  for (const state of ["ready", "in progress", "review", "completed"] as const) {
    const transition = board.getByRole("button", { name: `Mark ${prerequisite} ${state}` });
    await transition.focus();
    await page.keyboard.press("Enter");
    await expect(board.getByText(`${prerequisite} is now ${state}.`)).toBeVisible();
  }

  const readyMove = board.getByRole("button", { name: `Mark ${updatedTitle} ready` });
  await readyMove.focus();
  await expect(readyMove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(board.getByText(`${updatedTitle} is now ready.`)).toBeVisible();
  for (const state of ["in progress", "review", "completed"] as const) {
    const transition = board.getByRole("button", { name: `Mark ${updatedTitle} ${state}` });
    await transition.focus();
    await page.keyboard.press("Enter");
    await expect(board.getByText(`${updatedTitle} is now ${state}.`)).toBeVisible();
  }

  await board.getByRole("button", { name: "Close Moves" }).click();
  await page.reload();
  await page.getByRole("button", { name: /Open Moves/ }).click();
  await expect(board.getByRole("article", { name: `Move ${updatedTitle}` }).getByText("completed", { exact: true })).toBeVisible();
  await expect(board.getByRole("article", { name: `Move ${updatedTitle}` }).getByText(`Depends on ${prerequisite}`)).toBeVisible();
});

test("an owner can issue, edit, advance, and reload a durable room Call", async ({ page }) => {
  const initialTitle = "Review the room signal";
  const updatedTitle = "Review the live room signal";
  const initialDetail = "Bring one concrete interaction concern from the Workshop.";
  const updatedDetail = "Bring one concrete interaction concern and a suggested repair from the Workshop.";
  const linkedMove = "Set the sprint outcome";

  await page.goto("/");
  await page.getByRole("button", { name: /Issue Call/ }).click();
  const callDialog = page.getByRole("dialog", { name: "Ask for a hand, in context" });
  await expect(callDialog).toBeVisible();

  await callDialog.getByLabel("Call title").fill(initialTitle);
  await callDialog.getByRole("textbox", { name: "Detail" }).fill(initialDetail);
  await callDialog.getByLabel("Room").selectOption({ label: "Workshop" });
  await callDialog.getByLabel("Linked Move (optional)").selectOption({ label: linkedMove });
  await callDialog.getByRole("button", { name: "Issue Call", exact: true }).click();
  await expect(callDialog.getByText("Call issued.")).toBeVisible();

  await callDialog.getByRole("button", { name: "Close Calls" }).click();
  const beacon = page.getByRole("button", { name: `Open Call: ${initialTitle}, open` });
  await expect(beacon).toBeVisible();
  await beacon.click();
  await expect(callDialog.getByLabel(`Call actions for ${initialTitle}`)).toBeVisible();

  await callDialog.getByLabel("Call title").fill(updatedTitle);
  await callDialog.getByRole("textbox", { name: "Detail" }).fill(updatedDetail);
  await callDialog.getByRole("button", { name: "Save Call" }).click();
  await expect(callDialog.getByText("Call details saved.")).toBeVisible();
  await callDialog.getByRole("button", { name: "Close Calls" }).click();
  const updatedBeacon = page.getByRole("button", { name: `Open Call: ${updatedTitle}, open` });
  await expect(updatedBeacon).toBeVisible();
  await updatedBeacon.click();
  await expect(callDialog.getByLabel(`Call actions for ${updatedTitle}`)).toBeVisible();
  await expect(callDialog.getByLabel("Linked Move (optional)").locator("option:checked")).toHaveText(linkedMove);

  const accept = callDialog.getByRole("button", { name: `Accept ${updatedTitle}` });
  await accept.focus();
  await expect(accept).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(callDialog.getByText(`${updatedTitle} is now accepted.`)).toBeVisible();

  const reopen = callDialog.getByRole("button", { name: `Reopen ${updatedTitle}` });
  await reopen.focus();
  await page.keyboard.press("Enter");

  const acceptAgain = callDialog.getByRole("button", { name: `Accept ${updatedTitle}` });
  await expect(acceptAgain).toBeVisible();
  await acceptAgain.focus();
  await page.keyboard.press("Enter");
  await expect(callDialog.getByText(`${updatedTitle} is now accepted.`)).toBeVisible();

  const resolve = callDialog.getByRole("button", { name: `Resolve ${updatedTitle}` });
  await resolve.focus();
  await page.keyboard.press("Enter");
  await expect(callDialog.getByText(`${updatedTitle} is now resolved.`)).toBeVisible();
  const callList = callDialog.getByRole("list", { name: "Mission Calls" });
  await expect(callList.getByText(updatedTitle, { exact: true })).toBeVisible();
  await expect(callList.getByText(updatedDetail, { exact: true })).toBeVisible();
  await expect(callList.getByText(`Workshop · Move: ${linkedMove}`, { exact: true })).toBeVisible();
  await expect(callDialog.getByLabel("Call title")).toHaveCount(0);
  await expect(callDialog.getByLabel(`Call actions for ${updatedTitle}`)).toHaveCount(0);

  await callDialog.getByRole("button", { name: "Close Calls" }).click();
  await page.reload();
  const resolvedBeacon = page.getByRole("button", { name: `Open Call: ${updatedTitle}, resolved` });
  await expect(resolvedBeacon).toBeVisible();
  await resolvedBeacon.focus();
  await page.keyboard.press("Enter");
  await expect(callDialog.getByRole("list", { name: "Mission Calls" }).getByText(updatedDetail, { exact: true })).toBeVisible();
  await expect(callDialog.getByLabel(`Call details for ${updatedTitle}`).getByText("resolved", { exact: true })).toBeVisible();
  await expect(callDialog.getByLabel("Call title")).toHaveCount(0);
  await expect(callDialog.getByLabel(`Call actions for ${updatedTitle}`)).toHaveCount(0);

  await callDialog.getByRole("button", { name: "Close Calls" }).click();
  await page.getByRole("button", { name: "Manage Mission" }).click();
  await page.getByRole("button", { name: "Archive Mission" }).click();
  await expect(page.getByRole("status", { name: "Archived Mission read-only" })).toBeVisible();

  await resolvedBeacon.focus();
  await page.keyboard.press("Enter");
  await expect(callDialog.getByLabel("Mission Calls read-only")).toBeVisible();
  await expect(callDialog.getByRole("list", { name: "Mission Calls" }).getByText(updatedDetail, { exact: true })).toBeVisible();
  await expect(callDialog.getByRole("list", { name: "Mission Calls" }).getByText(`Workshop · Move: ${linkedMove}`, { exact: true })).toBeVisible();
  await expect(callDialog.getByLabel("Call title")).toHaveCount(0);
  await expect(callDialog.getByLabel(`Call actions for ${updatedTitle}`)).toHaveCount(0);
});

test("an owner and contributor reactively coordinate a capacity-limited Call", async ({ browser, page }) => {
  const title = `Pair on the live Call ${Date.now()}`;
  const firstResponse = "I can review the current permission behavior.";
  const updatedResponse = "I can review the current permission behavior and verify the recovery path.";

  await page.goto("/");
  await page.getByRole("button", { name: "Invite collaborators" }).click();
  const invitations = page.getByRole("dialog", { name: "Invite collaborators" });
  await invitations.getByLabel("Role").selectOption("contributor");
  await invitations.getByRole("checkbox", { name: /Workshop/i }).check();
  await invitations.getByRole("button", { name: "Create invitation" }).click();
  const inviteUrl = await invitations.getByLabel("Invitation link").inputValue();
  expect(inviteUrl).toContain("/invite/");

  const contributorContext = await browser.newContext();
  try {
    const contributor = await contributorContext.newPage();
    await contributor.goto(inviteUrl);
    await contributor.getByLabel("Email").fill(
      `call-contributor-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
    );
    await contributor.getByLabel("Password").fill("Realworld-browser-test-2026");
    await contributor.getByRole("button", { name: "Need an invitation? Create an account" }).click();
    await contributor.getByRole("button", { name: "Create private-alpha account" }).click();
    await expect(contributor.getByRole("heading", { name: "You have a Mission invitation." })).toBeVisible({ timeout: 15_000 });
    await contributor.getByRole("button", { name: "Join Mission" }).click();
    await expect(contributor.getByText("You joined the Mission.")).toBeVisible();
    await contributor.getByRole("link", { name: "Enter the Mission World" }).click();
    await expect(contributor.getByRole("heading", { name: "Company sprint" })).toBeVisible();
    await expect(contributor.getByText("contributor", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Close invitations" }).click();
    await page.getByRole("button", { name: /Issue Call/ }).click();
    const ownerDialog = page.getByRole("dialog", { name: "Ask for a hand, in context" });
    await ownerDialog.getByLabel("Call title").fill(title);
    await ownerDialog.getByRole("textbox", { name: "Detail" }).fill("Pair with one contributor on the Workshop access review.");
    await ownerDialog.getByLabel("Room").selectOption({ label: "Workshop" });
    await ownerDialog.getByLabel("Participant limit (1–50)").fill("1");
    await ownerDialog.getByRole("button", { name: "Issue Call", exact: true }).click();
    await expect(ownerDialog.getByText("Call issued.")).toBeVisible();
    await ownerDialog.getByRole("button", { name: "Close Calls" }).click();

    const contributorBeacon = contributor.getByRole("button", { name: `Open Call: ${title}, open` });
    await expect(contributorBeacon).toBeVisible({ timeout: 15_000 });
    await contributorBeacon.click();
    let contributorDialog = contributor.getByRole("dialog", { name: "Ask for a hand, in context" });
    const contributorParticipants = contributorDialog.getByLabel(`Call participants for ${title}`);
    await expect(contributorParticipants).toContainText(/0\s*\/\s*1/);
    await contributorDialog.getByRole("button", { name: `Join ${title}` }).click();
    await expect(contributorParticipants).toContainText(/1\s*\/\s*1/);

    const ownerBeacon = page.getByRole("button", { name: `Open Call: ${title}, open` });
    await ownerBeacon.click();
    const ownerParticipants = ownerDialog.getByLabel(`Call participants for ${title}`);
    await expect(ownerParticipants).toContainText(/1\s*\/\s*1/, { timeout: 15_000 });

    await contributorDialog.getByLabel(`Response to ${title}`).fill(firstResponse);
    await contributorDialog.getByRole("button", { name: `Respond to ${title}` }).click();
    await expect(contributorParticipants.getByText(firstResponse, { exact: true })).toBeVisible();
    await contributorDialog.getByLabel(`Response to ${title}`).fill(updatedResponse);
    await contributorDialog.getByRole("button", { name: `Respond to ${title}` }).click();
    await expect(ownerParticipants.getByText(updatedResponse, { exact: true })).toBeVisible({ timeout: 15_000 });

    await contributorDialog.getByRole("button", { name: `Withdraw ${title}` }).click();
    await expect(contributorParticipants).toContainText(/0\s*\/\s*1/);
    await expect(ownerParticipants).toContainText(/0\s*\/\s*1/, { timeout: 15_000 });

    await contributor.reload();
    await expect(contributor.getByRole("heading", { name: "Company sprint" })).toBeVisible();
    await contributor.getByRole("button", { name: `Open Call: ${title}, open` }).click();
    contributorDialog = contributor.getByRole("dialog", { name: "Ask for a hand, in context" });
    const reloadedParticipants = contributorDialog.getByLabel(`Call participants for ${title}`);
    await expect(reloadedParticipants).toContainText(/0\s*\/\s*1/);
    await expect(contributorDialog.getByRole("button", { name: `Join ${title}` })).toBeVisible();

    await contributorDialog.getByRole("button", { name: `Join ${title}` }).click();
    await expect(reloadedParticipants).toContainText(/1\s*\/\s*1/);
    await contributorDialog.getByLabel(`Response to ${title}`).fill(updatedResponse);
    await contributorDialog.getByRole("button", { name: `Respond to ${title}` }).click();
    await expect(ownerParticipants.getByText(updatedResponse, { exact: true })).toBeVisible({ timeout: 15_000 });

    await ownerDialog.getByRole("button", { name: `Accept ${title}` }).click();
    await expect(ownerDialog.getByText(`${title} is now accepted.`)).toBeVisible();
    await ownerDialog.getByRole("button", { name: `Resolve ${title}` }).click();
    await expect(ownerDialog.getByText(`${title} is now resolved.`)).toBeVisible();

    await expect(contributorDialog.getByRole("button", { name: `Join ${title}` })).toHaveCount(0, { timeout: 15_000 });
    await expect(contributorDialog.getByRole("button", { name: `Withdraw ${title}` })).toHaveCount(0);
    await expect(contributorDialog.getByLabel(`Response to ${title}`)).toHaveCount(0);
    await expect(contributorDialog.getByRole("button", { name: `Respond to ${title}` })).toHaveCount(0);
    await expect(contributorDialog.getByLabel(`Call participants for ${title}`)).toContainText(/1\s*\/\s*1/);
    await expect(contributorDialog.getByText(updatedResponse, { exact: true })).toBeVisible();
  } finally {
    await contributorContext.close();
  }
});

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

  test("an offline participant converges to the durable Workshop layout when connectivity returns", async ({ browser, page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Invite collaborators" }).click();

    const invitations = page.getByRole("dialog", { name: "Invite collaborators" });
    await invitations.getByRole("checkbox", { name: /Workshop/i }).check();
    await invitations.getByRole("button", { name: "Create invitation" }).click();

    const inviteUrl = await invitations.getByLabel("Invitation link").inputValue();
    const participantContext = await browser.newContext();
    try {
      const participant = await participantContext.newPage();
      await participant.goto(inviteUrl);
      await participant.getByLabel("Email").fill(
        `offline-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      );
      await participant.getByLabel("Password").fill("Realworld-browser-test-2026");
      await participant.getByRole("button", { name: "Need an invitation? Create an account" }).click();
      await participant.getByRole("button", { name: "Create private-alpha account" }).click();
      await expect(participant.getByRole("heading", { name: "You have a Mission invitation." })).toBeVisible({ timeout: 15_000 });
      await participant.getByRole("button", { name: "Join Mission" }).click();
      await participant.getByRole("link", { name: "Enter the Mission World" }).click();

      const ownerWorkshop = page.getByRole("button", { name: /Workshop\. 4 active people/i });
      const participantWorkshop = participant.getByRole("button", { name: /Workshop\. 4 active people/i });
      await expect(ownerWorkshop).toBeVisible();
      await expect(participantWorkshop).toBeVisible();
      await page.getByRole("button", { name: "Close invitations" }).click();
      await expect(page.getByRole("button", { name: "Layout unlocked" })).toBeVisible();

      const initialParticipantPosition = await participantWorkshop.evaluate((element) => ({
        left: (element as HTMLElement).style.left,
        top: (element as HTMLElement).style.top,
      }));
      await participantContext.setOffline(true);

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

      for (let observation = 0; observation < 3; observation += 1) {
        await participant.waitForTimeout(250);
        expect(await participantWorkshop.evaluate((element) => ({
          left: (element as HTMLElement).style.left,
          top: (element as HTMLElement).style.top,
        }))).toEqual(initialParticipantPosition);
      }

      await participantContext.setOffline(false);
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
      await participantContext.setOffline(false);
      await participantContext.close();
    }
  });
});
