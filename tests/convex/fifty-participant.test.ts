import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";

const modules = {
  "../../convex/_generated/api.js": () => import("../../convex/_generated/api.js"),
  "../../convex/missions.ts": () => import("../../convex/missions"),
  "../../convex/canvas.ts": () => import("../../convex/canvas"),
};

const owner = {
  tokenIdentifier: "https://fifty-participants.test|owner",
  subject: "owner",
  issuer: "https://fifty-participants.test",
  name: "Owner",
};

const participantCount = 50;
const concurrentWriterCount = 8;
const localBudgetMs = 15_000;

function participant(index: number) {
  return {
    tokenIdentifier: `https://fifty-participants.test|participant-${index}`,
    subject: `participant-${index}`,
    issuer: "https://fifty-participants.test",
    name: `Participant ${index}`,
  };
}

describe("bounded fifty-participant local evidence", () => {
  it("keeps fifty scoped participants isolated under concurrent reads and distinct layout updates", async () => {
    const startedAt = Date.now();
    const t = convexTest(schema, modules);
    const asOwner = t.withIdentity(owner);
    const created = await asOwner.mutation(api.missions.createPrivateMission, {
      slug: "fifty-participant-evidence",
      title: "Fifty participant evidence",
      summary: "A deterministic local authorization and concurrency probe.",
      idempotencyKey: "fifty-create-mission",
      correlationId: "fifty-create-mission",
    });

    const identities = Array.from({ length: participantCount }, (_, index) => participant(index));
    const roomIds = await t.run(async (ctx) => {
      const now = Date.now();
      const ids: Id<"rooms">[] = [];
      for (let index = 0; index < participantCount; index += 1) {
        const roomId = await ctx.db.insert("rooms", {
          missionId: created.missionId,
          kind: "workshop",
          title: `Participant room ${index}`,
          accessPolicy: "restricted",
          mapType: "field",
          layout: { x: 100 + index, y: 200, width: 220, height: 140 },
          layoutVersion: 1,
          state: "active",
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        });
        ids.push(roomId);
        const principalId = await ctx.db.insert("principals", {
          type: "human",
          state: "active",
          tokenIdentifier: identities[index]!.tokenIdentifier,
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        });
        await ctx.db.insert("missionMembers", {
          missionId: created.missionId,
          principalId,
          role: index < concurrentWriterCount ? "builder" : "contributor",
          state: "active",
          scope: [`room:${roomId}`],
          grantVersion: 1,
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        });
      }
      return ids;
    });

    const initialReads = await Promise.all(
      identities.map((identity) => t.withIdentity(identity).query(api.canvas.roomLayouts, { missionId: created.missionId })),
    );
    for (let index = 0; index < participantCount; index += 1) {
      expect(initialReads[index]).toEqual([expect.objectContaining({ _id: roomIds[index], layoutVersion: 1 })]);
    }

    const updates = await Promise.all(
      identities.slice(0, concurrentWriterCount).map((identity, index) =>
        t.withIdentity(identity).mutation(api.canvas.updateRoomLayout, {
          roomId: roomIds[index]!,
          expectedLayoutVersion: 1,
          layout: { x: 500 + index, y: 300 + index, width: 240, height: 160 },
          idempotencyKey: `fifty-layout-${index}`,
        }),
      ),
    );
    expect(updates).toEqual(
      roomIds.slice(0, concurrentWriterCount).map((roomId) => expect.objectContaining({ roomId, layoutVersion: 2 })),
    );

    const finalReads = await Promise.all(
      identities.map((identity) => t.withIdentity(identity).query(api.canvas.roomLayouts, { missionId: created.missionId })),
    );
    for (let index = 0; index < participantCount; index += 1) {
      expect(finalReads[index]).toHaveLength(1);
      expect(finalReads[index]![0]).toMatchObject({ _id: roomIds[index] });
      expect(finalReads[index]![0]!.layoutVersion).toBe(index < concurrentWriterCount ? 2 : 1);
      expect(finalReads[index]![0]!.layout.x).toBe(index < concurrentWriterCount ? 500 + index : 100 + index);
    }

    const elapsedMs = Date.now() - startedAt;
    console.info(`[fifty-participant-local] participants=${participantCount} concurrentWrites=${concurrentWriterCount} elapsedMs=${elapsedMs}`);
    expect(elapsedMs).toBeLessThan(localBudgetMs);
  }, localBudgetMs + 5_000);
});
