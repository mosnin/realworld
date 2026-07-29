import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { displayNameCooldownMs, normalizeDisplayName } from "../../convex/profiles";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/profiles.ts": () => import("../../convex/profiles"),
};

function identity(name: string) {
  return {
    tokenIdentifier: `https://realworld.test|profile-${name}`,
    subject: `profile-${name}`,
    issuer: "https://realworld.test",
    name: `Profile ${name}`,
  };
}

describe("self profile kernel", () => {
  it("normalizes and exposes only the active human's privacy-safe profile", async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity(identity("ada"));

    expect(await asAda.query(api.profiles.getMine, {})).toBeNull();
    const first = await asAda.mutation(internal.profiles.setMine, {
      displayName: "  Ada   Lovelace  ",
      idempotencyKey: "profile-ada-1",
    });
    expect(first).toEqual({ displayName: "Ada Lovelace" });
    expect(await asAda.mutation(internal.profiles.setMine, {
      displayName: "Ada Lovelace",
      idempotencyKey: "profile-ada-1",
    })).toEqual(first);
    await expect(asAda.mutation(internal.profiles.setMine, {
      displayName: "Grace Hopper",
      idempotencyKey: "profile-ada-1",
    })).rejects.toThrow("Idempotency key reuse with a different callsign");

    const mine = await asAda.query(api.profiles.getMine, {});
    expect(mine).toMatchObject({ displayName: "Ada Lovelace", displayNameUpdatedAt: expect.any(Number) });
    expect(Object.keys(mine ?? {}).sort()).toEqual(["displayName", "displayNameUpdatedAt"]);
    await t.run(async (ctx) => {
      const principals = await ctx.db.query("principals").collect();
      const receipts = await ctx.db.query("profileReceipts").collect();
      expect(principals).toHaveLength(1);
      expect(principals[0]).toMatchObject({ type: "human", state: "active", displayName: "Ada Lovelace" });
      expect(receipts).toHaveLength(1);
      expect(await ctx.db.query("missionEvents").collect()).toHaveLength(0);
      expect(await ctx.db.query("missionMembers").collect()).toHaveLength(0);
    });
  });

  it("enforces server cooldown but permits a later self-only change", async () => {
    const t = convexTest(schema, modules);
    const ada = identity("ada");
    const asAda = t.withIdentity(ada);
    await asAda.mutation(internal.profiles.setMine, { displayName: "Ada Lovelace", idempotencyKey: "profile-ada-first" });
    await expect(asAda.mutation(internal.profiles.setMine, {
      displayName: "Ada Byron",
      idempotencyKey: "profile-ada-too-soon",
    })).rejects.toThrow("Display name can only change once every 24 hours");

    await t.run(async (ctx) => {
      const principal = await ctx.db.query("principals")
        .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", ada.tokenIdentifier))
        .unique();
      await ctx.db.patch(principal!._id, { displayNameUpdatedAt: Date.now() - displayNameCooldownMs });
    });
    expect(await asAda.mutation(internal.profiles.setMine, {
      displayName: "Ada Byron",
      idempotencyKey: "profile-ada-later",
    })).toEqual({ displayName: "Ada Byron" });
  });

  it("accepts only active humans and cannot modify another human's profile", async () => {
    const t = convexTest(schema, modules);
    const ada = identity("ada");
    const grace = identity("grace");
    const asAda = t.withIdentity(ada);
    const asGrace = t.withIdentity(grace);
    await asAda.mutation(internal.profiles.setMine, { displayName: "Ada Lovelace", idempotencyKey: "profile-ada" });
    await asGrace.mutation(internal.profiles.setMine, { displayName: "Grace Hopper", idempotencyKey: "profile-grace" });
    await expect(t.mutation(internal.profiles.setMine, {
      displayName: "Anonymous Human",
      idempotencyKey: "profile-anonymous",
    })).rejects.toThrow("Unauthorized");

    const agent = identity("agent");
    const disabledHuman = identity("disabled-human");
    const service = identity("service");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("principals", {
        type: "agent",
        state: "active",
        tokenIdentifier: agent.tokenIdentifier,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      await ctx.db.insert("principals", {
        type: "human",
        state: "disabled",
        tokenIdentifier: disabledHuman.tokenIdentifier,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      await ctx.db.insert("principals", {
        type: "service",
        state: "active",
        tokenIdentifier: service.tokenIdentifier,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
    });
    await expect(t.withIdentity(agent).mutation(internal.profiles.setMine, {
      displayName: "Unauthorised Agent",
      idempotencyKey: "profile-agent",
    })).rejects.toThrow("Unauthorized");
    await expect(t.withIdentity(disabledHuman).mutation(internal.profiles.setMine, {
      displayName: "Disabled Human",
      idempotencyKey: "profile-disabled-human",
    })).rejects.toThrow("Unauthorized");
    await expect(t.withIdentity(service).mutation(internal.profiles.setMine, {
      displayName: "Service Human",
      idempotencyKey: "profile-service",
    })).rejects.toThrow("Unauthorized");
    expect(await asAda.query(api.profiles.getMine, {})).toMatchObject({ displayName: "Ada Lovelace" });
    expect(await asGrace.query(api.profiles.getMine, {})).toMatchObject({ displayName: "Grace Hopper" });
  });

  it("rejects unsafe names and retains no Mission artifacts", async () => {
    const t = convexTest(schema, modules);
    const asAda = t.withIdentity(identity("ada"));
    for (const displayName of [
      "A",
      "x".repeat(41),
      "Ada\nLovelace",
      "Ada\u0000Lovelace",
      "Ada\u202ELovelace",
      "Ada\u200BLovelace",
      "ada@example.test",
      "Ｒｅａｌｗｏｒｌｄ",
      "SonicAgent",
      "Admin!",
      "A-d_m.in",
      "🅰dmin",
      "Аdmin",
      "Αdmin",
      "SоnicAgent",
      "SοnicAgent",
    ]) {
      await expect(asAda.mutation(internal.profiles.setMine, {
        displayName,
        idempotencyKey: `invalid-${displayName.length}-${displayName.charCodeAt(0)}`,
      })).rejects.toThrow();
    }
    await expect(asAda.mutation(internal.profiles.setMine, {
      displayName: "👩‍💻",
      idempotencyKey: "invalid-zwj-emoji",
    })).rejects.toThrow("Display name contains unsupported invisible characters");
    for (const [index, displayName] of ["\u0301\u0300", "\u0301 \u0300"].entries()) {
      await expect(asAda.mutation(internal.profiles.setMine, {
        displayName,
        idempotencyKey: `invalid-unattached-mark-${index}`,
      })).rejects.toThrow("Display name contains unattached combining marks");
    }
    await t.run(async (ctx) => {
      expect(await ctx.db.query("principals").collect()).toHaveLength(0);
      expect(await ctx.db.query("profileReceipts").collect()).toHaveLength(0);
      expect(await ctx.db.query("missionEvents").collect()).toHaveLength(0);
      expect(await ctx.db.query("missionMembers").collect()).toHaveLength(0);
    });
  });

  it("counts visible graphemes after NFKC normalization", async () => {
    const accepted = [
      { displayName: "e\u0301e\u0301", normalized: "éé" },
      { displayName: "🇺🇸🇨🇦", normalized: "🇺🇸🇨🇦" },
      { displayName: "🙂🚀", normalized: "🙂🚀" },
      { displayName: "ＡＢ", normalized: "AB" },
      { displayName: "Ａ".repeat(40), normalized: "A".repeat(40) },
    ];
    for (const [index, vector] of accepted.entries()) {
      const t = convexTest(schema, modules);
      const asHuman = t.withIdentity(identity(`grapheme-${index}`));
      expect(await asHuman.mutation(internal.profiles.setMine, {
        displayName: vector.displayName,
        idempotencyKey: `profile-grapheme-${index}`,
      })).toEqual({ displayName: vector.normalized });
    }

    const rejected = ["e\u0301", "🇺🇸", "Ａ".repeat(41)];
    for (const [index, displayName] of rejected.entries()) {
      const t = convexTest(schema, modules);
      await expect(t.withIdentity(identity(`grapheme-rejected-${index}`)).mutation(internal.profiles.setMine, {
        displayName,
        idempotencyKey: `profile-grapheme-rejected-${index}`,
      })).rejects.toThrow("Display name must contain 2 to 40 visible characters");
    }
  });

  it("fails closed when grapheme segmentation is unavailable", () => {
    expect(() => normalizeDisplayName("Ada Lovelace", { Segmenter: null }))
      .toThrow("Unicode grapheme segmentation is unavailable");
  });
});
