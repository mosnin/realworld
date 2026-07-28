"use client";

import { useState } from "react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type Mission = { _id: Id<"missions"> };

function timeLabel(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function actorLabel(entry: { actorDisplayName?: string; actorType: string; effectiveRole: string }) {
  return entry.actorDisplayName ?? (entry.actorType === "agent" ? "An agent" : entry.effectiveRole);
}

export function PulseSurface({ mission }: Readonly<{ mission: Mission }>) {
  const entries = useQuery(api.pulse.listMissionPulse, { missionId: mission._id, limit: 12 });
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<Id<"missionEvents"> | null>(null);
  const selected = entries?.find((entry) => entry._id === selectedId) ?? entries?.[0];

  return <footer aria-label="Mission activity Pulse" className="pulse-surface">
    {open ? <section aria-label="Recent durable Mission activity" className="pulse-surface__detail">
      {entries === undefined ? <p aria-live="polite">Loading durable activity…</p> : entries.length === 0 ? <p>No durable Mission activity yet. The first real action will appear here.</p> : <>
        {selected ? <div aria-live="polite" className="pulse-surface__selected"><strong>{selected.summary}</strong><span>{actorLabel(selected)} · {selected.roomTitle ?? "Mission-wide"} · {timeLabel(selected.createdAt)}</span></div> : null}
        <ol className="pulse-surface__events">
          {entries.map((entry) => <li key={entry._id}><button aria-pressed={selected?._id === entry._id} onClick={() => setSelectedId(entry._id)} type="button"><span className={`pulse-surface__event-mark pulse-surface__event-mark--${entry.actorType}`} aria-hidden="true">{actorLabel(entry).slice(0, 1)}</span><span><strong>{entry.summary}</strong><small>{actorLabel(entry)} · {entry.roomTitle ?? "Mission-wide"} · {timeLabel(entry.createdAt)}</small></span></button></li>)}
        </ol>
      </>}
      <p className="pulse-surface__note">Durable Mission events — not live presence.</p>
    </section> : null}
    <div className="pulse-rail">
      <div><strong>Pulse</strong><span>{entries === undefined ? "Loading activity" : entries.length === 0 ? "Waiting for a durable action" : "Durable activity"}</span></div>
      <div aria-hidden="true" className="pulse-rail__route" />
      <div aria-label={entries === undefined ? "Loading Mission activity" : `${entries.length} recent durable Mission events`} className="pulse-rail__people">
        {entries?.slice(0, 7).map((entry) => <button aria-label={`${actorLabel(entry)}: ${entry.summary}`} className={`pulse-surface__node pulse-surface__node--${entry.actorType}`} key={entry._id} onClick={() => { setSelectedId(entry._id); setOpen(true); }} type="button">{actorLabel(entry).slice(0, 1)}</button>)}
      </div>
      <button aria-expanded={open} className="pulse-rail__count" onClick={() => setOpen((current) => !current)} type="button">{open ? "Close Mission Pulse" : "Open Mission Pulse"}{entries === undefined ? "" : ` (${entries.length})`}</button>
    </div>
  </footer>;
}
