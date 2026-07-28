"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function MissionControls({ mission }: Readonly<{ mission: { _id: Id<"missions">; title: string; summary: string; lifecycle: "active" | "archived" | "pendingDeletion" | "deletedTombstone"; currentVersion: number; role: string } }>) {
  const edit = useMutation(api.missions.editPrivateMission); const archive = useMutation(api.missions.archivePrivateMission); const restore = useMutation(api.missions.restorePrivateMission);
  const [open, setOpen] = useState(false); const [title, setTitle] = useState(mission.title); const [summary, setSummary] = useState(mission.summary); const [feedback, setFeedback] = useState<string | null>(null);
  if (mission.role !== "owner") return null;
  async function run(action: () => Promise<unknown>) { setFeedback(null); try { await action(); setFeedback("Mission updated."); } catch { setFeedback("The Mission changed elsewhere. Refresh and try again."); } }
  return <section aria-label="Mission owner controls">
    <button onClick={() => setOpen((value) => !value)} type="button">Manage Mission</button>
    {open ? <div><label>Title<input onChange={(event) => setTitle(event.target.value)} value={title} /></label><label>Summary<textarea onChange={(event) => setSummary(event.target.value)} value={summary} /></label>
      {mission.lifecycle === "active" ? <><button onClick={() => void run(() => edit({ missionId: mission._id, title, summary, expectedVersion: mission.currentVersion, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() }))} type="button">Save Mission</button><button onClick={() => void run(() => archive({ missionId: mission._id, expectedVersion: mission.currentVersion, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() }))} type="button">Archive Mission</button></> : <button onClick={() => void run(() => restore({ missionId: mission._id, expectedVersion: mission.currentVersion, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() }))} type="button">Restore Mission</button>}
      {feedback === null ? null : <p aria-live="polite">{feedback}</p>}</div> : null}
  </section>;
}
