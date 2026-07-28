"use client";

import { useMutation } from "convex/react";
import { useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function MissionControls({ mission }: Readonly<{ mission: { _id: Id<"missions">; title: string; summary: string; lifecycle: "active" | "archived" | "pendingDeletion" | "deletedTombstone"; currentVersion: number; role: string } }>) {
  const edit = useMutation(api.missions.editPrivateMission); const archive = useMutation(api.missions.archivePrivateMission); const restore = useMutation(api.missions.restorePrivateMission);
  const [open, setOpen] = useState(false); const [title, setTitle] = useState(mission.title); const [summary, setSummary] = useState(mission.summary); const [baseVersion, setBaseVersion] = useState(mission.currentVersion); const [feedback, setFeedback] = useState<string | null>(null); const [pending, setPending] = useState(false); const keys = useRef<Record<string, string>>({});
  if (mission.role !== "owner") return null;
  async function run(intent: string, action: (idempotencyKey: string) => Promise<unknown>) { if (pending) return; if (baseVersion !== mission.currentVersion) { setFeedback("This Mission changed elsewhere. Close Manage Mission to load the latest details before saving."); return; } setPending(true); setFeedback(null); keys.current[intent] ??= crypto.randomUUID(); try { await action(keys.current[intent]); setFeedback("Mission updated."); } catch { setFeedback("The Mission changed elsewhere. The live Mission has been refreshed; review and try again."); keys.current[intent] = crypto.randomUUID(); } finally { setPending(false); } }
  return <section aria-label="Mission owner controls">
    <button onClick={() => { if (!open) { setTitle(mission.title); setSummary(mission.summary); setBaseVersion(mission.currentVersion); } setOpen((value) => !value); }} type="button">Manage Mission</button>
    {open ? <div><label>Title<input disabled={pending || mission.lifecycle !== "active"} onChange={(event) => setTitle(event.target.value)} value={title} /></label><label>Summary<textarea disabled={pending || mission.lifecycle !== "active"} onChange={(event) => setSummary(event.target.value)} value={summary} /></label>
      {mission.lifecycle === "active" ? <><button disabled={pending || baseVersion !== mission.currentVersion} onClick={() => void run("edit", (idempotencyKey) => edit({ missionId: mission._id, title, summary, expectedVersion: baseVersion, idempotencyKey, correlationId: crypto.randomUUID() }))} type="button">Save Mission</button><button disabled={pending || baseVersion !== mission.currentVersion} onClick={() => void run("archive", (idempotencyKey) => archive({ missionId: mission._id, expectedVersion: baseVersion, idempotencyKey, correlationId: crypto.randomUUID() }))} type="button">Archive Mission</button></> : mission.lifecycle === "archived" ? <button disabled={pending || baseVersion !== mission.currentVersion} onClick={() => void run("restore", (idempotencyKey) => restore({ missionId: mission._id, expectedVersion: baseVersion, idempotencyKey, correlationId: crypto.randomUUID() }))} type="button">Restore Mission</button> : <p>This Mission is read-only.</p>}
      {feedback === null ? null : <p aria-live="polite">{feedback}</p>}</div> : null}
  </section>;
}
