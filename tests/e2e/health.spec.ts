import { expect, test } from "@playwright/test";

test("the health route is available", async ({ request }) => {
  const response = await request.get("/api/health");

  await expect(response).toBeOK();
  await expect(response.json()).resolves.toMatchObject({
    status: "ok",
    service: "realworld-web",
  });
});
