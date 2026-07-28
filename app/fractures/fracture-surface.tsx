"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";

import { Icon } from "@/app/ui/icons";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type FractureStatus = "open" | "investigating" | "resolved" | "dismissed";
type Severity = "low" | "medium" | "high" | "critical";

type Mission = { _id: Id<"missions">; lifecycle: string; role: string };
type RoomOption = { _id: Id<"rooms">; title: string; x: number; y: number };
type MoveOption = { _id: Id<"moves">; title: string; roomId?: Id<"rooms"> };

const transitions: Record<FractureStatus, FractureStatus[]> = {
  open: ["investigating", "resolved", "dismissed"],
  investigating: ["open", "resolved", "dismissed"],
  resolved: ["open"],
  dismissed: ["open"],
};

function statusLabel(status: FractureStatus) {
  return status === "investigating" ? "investigating" : status;
}

function transitionLabel(status: FractureStatus) {
  return ({ investigating: "Investigate", open: "Reopen", resolved: "Resolve", dismissed: "Dismiss" } as const)[status];
}

export function FractureSurface({
  mission,
  rooms,
  moves,
}: Readonly<{ mission: Mission; rooms: RoomOption[]; moves: MoveOption[] }>) {
  const fractures = useQuery(api.fractures.listMissionFractures, { missionId: mission._id });
  const createFracture = useMutation(api.fractures.createFracture);
  const updateFracture = useMutation(api.fractures.updateFracture);
  const transitionFracture = useMutation(api.fractures.transitionFracture);
  const commandKeys = useRef<Record<string, string>>({});
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const pendingIntentRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedFractureId, setSelectedFractureId] = useState<Id<"fractures"> | null>(null);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [severity, setSeverity] = useState<Severity>("medium");
  const [roomId, setRoomId] = useState<Id<"rooms"> | "">(rooms[0]?._id ?? "");
  const [linkedMoveId, setLinkedMoveId] = useState<Id<"moves"> | "">("");
  const [pendingIntent, setPendingIntent] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const canCreate = mission.lifecycle === "active" && ["owner", "steward", "builder", "contributor"].includes(mission.role);
  const selectedFracture = fractures?.find((fracture) => fracture._id === selectedFractureId);
  const selectedRoom = rooms.find((room) => room._id === selectedFracture?.roomId);
  const selectedMove = moves.find((move) => move._id === selectedFracture?.linkedMoveId);
  const linkedMoveOptions = moves.filter((move) => move.roomId === roomId);
  const isTerminal = selectedFracture?.status === "resolved" || selectedFracture?.status === "dismissed";
  const canAdminister = mission.lifecycle === "active" && selectedFracture?.canAdminister === true;
  const isEditable = selectedFracture === undefined ? canCreate : canAdminister && !isTerminal;
  const nextTransitions = selectedFracture === undefined || !canAdminister ? [] : transitions[selectedFracture.status];

  const closeSurface = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }, []);

  useEffect(() => {
    pendingIntentRef.current = pendingIntent;
  }, [pendingIntent]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const firstInteractive = panelRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])");
      (firstFieldRef.current ?? firstInteractive)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pendingIntentRef.current === null) closeSurface();
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])"));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeSurface, open]);

  function resetComposer(clearStatus = true) {
    setSelectedFractureId(null);
    setTitle("");
    setDetail("");
    setSeverity("medium");
    setRoomId(rooms[0]?._id ?? "");
    setLinkedMoveId("");
    if (clearStatus) setStatus(null);
  }

  function openComposer(event: React.MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    resetComposer();
    setOpen(true);
  }

  function inspectFracture(fractureId: Id<"fractures">, event: React.MouseEvent<HTMLButtonElement>) {
    const fracture = fractures?.find((candidate) => candidate._id === fractureId);
    if (!fracture) return;
    if (!panelRef.current?.contains(event.currentTarget)) openerRef.current = event.currentTarget;
    setSelectedFractureId(fracture._id);
    setTitle(fracture.title);
    setDetail(fracture.detail);
    setSeverity(fracture.severity);
    setRoomId(fracture.roomId ?? "");
    setLinkedMoveId(fracture.linkedMoveId ?? "");
    setStatus(null);
    setOpen(true);
  }

  async function runCommand(intent: string, action: (idempotencyKey: string) => Promise<unknown>, successMessage: string) {
    if (pendingIntent !== null) return false;
    const idempotencyKey = commandKeys.current[intent] ?? crypto.randomUUID();
    commandKeys.current[intent] = idempotencyKey;
    setPendingIntent(intent);
    setStatus(null);
    try {
      await action(idempotencyKey);
      delete commandKeys.current[intent];
      setStatus(successMessage);
      return true;
    } catch {
      setStatus("The Fracture could not change. Review the latest state and retry.");
      return false;
    } finally {
      setPendingIntent(null);
    }
  }

  async function save() {
    if (!isEditable || roomId === "") return;
    if (selectedFracture === undefined) {
      const succeeded = await runCommand(
        "create",
        (idempotencyKey) => createFracture({ missionId: mission._id, roomId, linkedMoveId: linkedMoveId || undefined, title, detail, severity, idempotencyKey, correlationId: crypto.randomUUID() }),
        "Fracture recorded.",
      );
      if (succeeded) resetComposer(false);
      return;
    }
    const succeeded = await runCommand(
      `update:${selectedFracture._id}`,
      (idempotencyKey) => updateFracture({ fractureId: selectedFracture._id, expectedVersion: selectedFracture.currentVersion, roomId, linkedMoveId: linkedMoveId || null, title, detail, severity, idempotencyKey, correlationId: crypto.randomUUID() }),
      "Fracture details saved.",
    );
    if (succeeded) setSelectedFractureId(null);
  }

  async function transition(nextStatus: FractureStatus) {
    if (selectedFracture === undefined) return;
    await runCommand(
      `transition:${selectedFracture._id}:${nextStatus}`,
      (idempotencyKey) => transitionFracture({ fractureId: selectedFracture._id, expectedVersion: selectedFracture.currentVersion, nextStatus, idempotencyKey, correlationId: crypto.randomUUID() }),
      `${selectedFracture.title} is now ${statusLabel(nextStatus)}.`,
    );
  }

  return (
    <section className="fracture-surface" aria-label="Mission Fractures">
      <button className="fracture-surface__trigger" onClick={openComposer} type="button"><Icon name="branch" /> {canCreate ? "Open Fractures" : "View Fractures"}{fractures === undefined ? "" : ` (${fractures.length})`}</button>
      <div aria-label="Fractures anchored to Mission rooms" className="fracture-beacons" role="group">
        {fractures?.map((fracture, index) => {
          const room = rooms.find((candidate) => candidate._id === fracture.roomId);
          return <button aria-label={`Open Fracture: ${fracture.title}, ${statusLabel(fracture.status)}, ${fracture.severity} severity`} className={`fracture-beacon fracture-beacon--${fracture.severity} fracture-beacon--${fracture.status}`} key={fracture._id} onClick={(event) => inspectFracture(fracture._id, event)} style={{ left: `calc(${room?.x ?? 50}% + ${(index % 2) * 14}px)`, top: `calc(${room?.y ?? 44}% + ${34 + Math.floor(index / 2) * 12}px)` }} type="button"><span aria-hidden="true"><Icon name="branch" /></span><strong>{fracture.title}</strong><small>{fracture.severity} · {statusLabel(fracture.status)}</small></button>;
        })}
      </div>

      {open ? createPortal(<div aria-labelledby="fracture-surface-title" aria-modal="true" className="preference-panel fracture-surface__panel" ref={panelRef} role="dialog">
        <div className="preference-panel__header"><div><p className="eyebrow">Mission Fractures</p><h2 id="fracture-surface-title">Name the break, hold the line</h2></div><button aria-label="Close Fractures" className="icon-button" disabled={pendingIntent !== null} onClick={closeSurface} type="button">×</button></div>
        {!canCreate ? <p aria-label="Mission Fractures read-only">Fractures are read-only for your role or this archived Mission.</p> : null}
        {selectedFracture !== undefined && canCreate ? <button className="fracture-surface__back" disabled={pendingIntent !== null} onClick={() => resetComposer()} type="button">Create another Fracture</button> : null}

        {selectedFracture !== undefined ? <article aria-label={`Fracture details for ${selectedFracture.title}`} className="fracture-detail"><p><strong>{selectedFracture.title}</strong><span>{statusLabel(selectedFracture.status)}</span></p><div>{selectedFracture.detail}</div><small>Severity: {selectedFracture.severity}</small><small>Room: {selectedRoom?.title ?? "Mission-wide"}</small><small>Linked Move: {selectedMove?.title ?? "None"}</small>{selectedFracture.reporterDisplayName ? <small>Reported by {selectedFracture.reporterDisplayName}</small> : null}</article> : null}

        {isEditable && rooms.length > 0 ? <form className="fracture-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><label>Fracture title<input disabled={pendingIntent !== null} onChange={(event) => setTitle(event.target.value)} ref={firstFieldRef} required value={title} /></label><label>Detail<textarea disabled={pendingIntent !== null} onChange={(event) => setDetail(event.target.value)} required value={detail} /></label><label>Severity<select disabled={pendingIntent !== null} onChange={(event) => setSeverity(event.target.value as Severity)} value={severity}><option value="low">Low — watch it</option><option value="medium">Medium — work is slowed</option><option value="high">High — work is blocked</option><option value="critical">Critical — shared work is at risk</option></select></label><label>Room<select disabled={pendingIntent !== null} onChange={(event) => { setRoomId(event.target.value as Id<"rooms">); setLinkedMoveId(""); }} required value={roomId}>{rooms.map((room) => <option key={room._id} value={room._id}>{room.title}</option>)}</select></label><label>Linked Move (optional)<select disabled={pendingIntent !== null} onChange={(event) => setLinkedMoveId(event.target.value as Id<"moves"> | "")} value={linkedMoveId}><option value="">No linked Move</option>{linkedMoveOptions.map((move) => <option key={move._id} value={move._id}>{move.title}</option>)}</select></label><button disabled={pendingIntent !== null} type="submit">{pendingIntent === "create" ? "Creating…" : selectedFracture === undefined ? "Create Fracture" : pendingIntent?.startsWith("update:") ? "Saving…" : "Save Fracture"}</button></form> : isEditable ? <p>No writable Room is available for a Fracture.</p> : null}

        {selectedFracture !== undefined && nextTransitions.length > 0 ? <section aria-label={`Fracture actions for ${selectedFracture.title}`} className="fracture-actions"><p><strong>{selectedFracture.title}</strong><span>{statusLabel(selectedFracture.status)}</span></p>{nextTransitions.map((nextStatus) => <button disabled={pendingIntent !== null} key={nextStatus} onClick={() => void transition(nextStatus)} type="button">{pendingIntent === `transition:${selectedFracture._id}:${nextStatus}` ? `${transitionLabel(nextStatus)}ing…` : `${transitionLabel(nextStatus)} ${selectedFracture.title}`}</button>)}</section> : null}

        {fractures !== undefined && fractures.length > 0 ? <ul aria-label="Mission Fractures" className="fracture-list">{fractures.map((fracture) => <li key={fracture._id}><button aria-pressed={selectedFractureId === fracture._id} onClick={(event) => inspectFracture(fracture._id, event)} type="button"><span><strong>{fracture.title}</strong><em>{fracture.severity} · {statusLabel(fracture.status)}</em></span><small>{fracture.detail}</small></button></li>)}</ul> : null}
        {status ? <p aria-live="polite" className="fracture-surface__status">{status}</p> : null}
        {fractures === undefined ? <p>Loading Fractures…</p> : fractures.length === 0 ? <p className="fracture-surface__empty">No Fractures recorded. Signal the first break while it is still close to the work.</p> : null}
      </div>, document.body) : null}
    </section>
  );
}
