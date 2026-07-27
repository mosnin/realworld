import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

describe("health route", () => {
  it("reports the web service without caching", async () => {
    const priorEnvironment = process.env.NEXT_PUBLIC_APP_ENV;
    process.env.NEXT_PUBLIC_APP_ENV = "test";
    const response = GET();

    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "realworld-web",
      environment: "test",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    if (priorEnvironment === undefined) {
      delete process.env.NEXT_PUBLIC_APP_ENV;
    } else {
      process.env.NEXT_PUBLIC_APP_ENV = priorEnvironment;
    }
  });
});
