"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type ProofStatus = "submitted" | "verified" | "rejected";
type Mission = { _id: Id<"missions">; lifecycle: string; role: string };
type RoomOption = { _id: Id<"rooms">; title: string; x: number; y: number };
type MoveOption = { _id: Id<"moves">; title: string; roomId?: Id<"rooms"> };

type ProofCapabilities = {
  canEdit?: boolean;
  canReview?: boolean;
  canResubmit?: boolean;
  canTransition?: boolean;
  verifiedAt?: number;
};

function statusLabel(status: ProofStatus) {
  return status;
}

export function ProofSurface({ mission, rooms, moves }: Readonly<{ mission: Mission; rooms: RoomOption[]; moves: MoveOption[] }>) {
  const proofs = useQuery(api.proofs.listMissionProofs, { missionId: mission._id });
  const createProof = useMutation(api.proofs.createProof);
  const updateProof = useMutation(api.proofs.updateProof);
  const transitionProof = useMutation(api.proofs.transitionProof);
  const commandKeys = useRef<Record<string, string>>({});
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const pendingIntentRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedProofId, setSelectedProofId] = useState<Id<"proofs"> | null>(null);
  const [title, setTitle] = useState("");
  const [claim, setClaim] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [roomId, setRoomId] = useState<Id<"rooms"> | "">(rooms[0]?._id ?? "");
  const [linkedMoveId, setLinkedMoveId] = useState<Id<"moves"> | "">("");
  const [pendingIntent, setPendingIntent] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const canCreate = mission.lifecycle === "active" && ["owner", "steward", "builder", "contributor"].includes(mission.role);
  const selectedProof = proofs?.find((proof) => proof._id === selectedProofId);
  const capabilities = selectedProof as (typeof selectedProof & ProofCapabilities) | undefined;
  const selectedRoom = rooms.find((room) => room._id === selectedProof?.roomId);
  const selectedMove = moves.find((move) => move._id === selectedProof?.linkedMoveId);
  const linkedMoveOptions = moves.filter((move) => move.roomId === roomId);
  const canEdit = mission.lifecycle === "active" && selectedProof?.status === "submitted" && (capabilities?.canEdit === true || capabilities?.canTransition === true);
  const canReview = mission.lifecycle === "active" && (capabilities?.canReview === true || capabilities?.canTransition === true);
  const canResubmit = mission.lifecycle === "active" && (capabilities?.canResubmit === true || capabilities?.canTransition === true);

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
    setSelectedProofId(null);
    setTitle("");
    setClaim("");
    setEvidenceNote("");
    setRoomId(rooms[0]?._id ?? "");
    setLinkedMoveId("");
    if (clearStatus) setStatus(null);
  }

  function openComposer(event: React.MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    resetComposer();
    setOpen(true);
  }

  function inspectProof(proofId: Id<"proofs">, event: React.MouseEvent<HTMLButtonElement>) {
    const proof = proofs?.find((candidate) => candidate._id === proofId);
    if (!proof) return;
    if (!panelRef.current?.contains(event.currentTarget)) openerRef.current = event.currentTarget;
    setSelectedProofId(proof._id);
    setTitle(proof.title);
    setClaim(proof.claim);
    setEvidenceNote(proof.evidenceNote);
    setRoomId(proof.roomId);
    setLinkedMoveId(proof.linkedMoveId ?? "");
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
      setStatus("The Proof could not change. Review the latest state and retry.");
      return false;
    } finally {
      setPendingIntent(null);
    }
  }

  async function save() {
    if ((selectedProof === undefined ? !canCreate : !canEdit) || roomId === "") return;
    if (selectedProof === undefined) {
      const succeeded = await runCommand("create", (idempotencyKey) => createProof({ missionId: mission._id, roomId, linkedMoveId: linkedMoveId || undefined, title, claim, evidenceNote, idempotencyKey, correlationId: crypto.randomUUID() }), "Proof submitted.");
      if (succeeded) resetComposer(false);
      return;
    }
    const succeeded = await runCommand(`update:${selectedProof._id}`, (idempotencyKey) => updateProof({ proofId: selectedProof._id, expectedVersion: selectedProof.currentVersion, roomId, linkedMoveId: linkedMoveId || null, title, claim, evidenceNote, idempotencyKey, correlationId: crypto.randomUUID() }), "Proof details saved.");
    if (succeeded) setSelectedProofId(null);
  }

  async function transition(nextStatus: ProofStatus) {
    if (!selectedProof) return;
    await runCommand(`transition:${selectedProof._id}:${nextStatus}`, (idempotencyKey) => transitionProof({ proofId: selectedProof._id, expectedVersion: selectedProof.currentVersion, nextStatus, idempotencyKey, correlationId: crypto.randomUUID() }), `${selectedProof.title} is now ${statusLabel(nextStatus)}.`);
  }

  return <section aria-label="Mission Proofs" className="proof-surface">
    <button className="proof-surface__trigger" onClick={openComposer} type="button"><span aria-hidden="true">✓</span> {canCreate ? "Open Proofs" : "View Proofs"}{proofs === undefined ? "" : ` (${proofs.length})`}</button>
    <div aria-label="Proofs anchored to Mission rooms" className="proof-beacons" role="group">{proofs?.map((proof, index) => {
      const room = rooms.find((candidate) => candidate._id === proof.roomId);
      return <button aria-label={`Open Proof: ${proof.title}, ${statusLabel(proof.status)}`} className={`proof-beacon proof-beacon--${proof.status}`} key={proof._id} onClick={(event) => inspectProof(proof._id, event)} style={{ left: `calc(${room?.x ?? 50}% + ${(index % 2) * 14}px)`, top: `calc(${room?.y ?? 50}% + ${-68 - Math.floor(index / 2) * 12}px)` }} type="button"><span aria-hidden="true">✓</span><strong>{proof.title}</strong><small>{statusLabel(proof.status)}</small></button>;
    })}</div>
    {open ? createPortal(<div aria-labelledby="proof-surface-title" aria-modal="true" className="preference-panel proof-surface__panel" ref={panelRef} role="dialog">
      <div className="preference-panel__header"><div><p className="eyebrow">Mission Proofs</p><h2 id="proof-surface-title">Make the work verifiable</h2></div><button aria-label="Close Proofs" className="icon-button" disabled={pendingIntent !== null} onClick={closeSurface} type="button">×</button></div>
      {!canCreate ? <p aria-label="Mission Proofs read-only">Proofs are read-only for your role or this archived Mission.</p> : null}
      {selectedProof !== undefined && canCreate ? <button className="proof-surface__back" disabled={pendingIntent !== null} onClick={() => resetComposer()} type="button">Submit another Proof</button> : null}
      {selectedProof !== undefined ? <article aria-label={`Proof details for ${selectedProof.title}`} className="proof-detail"><p><strong>{selectedProof.title}</strong><span>{statusLabel(selectedProof.status)}</span></p><div><b>Claim</b><span>{selectedProof.claim}</span></div><div><b>Evidence</b><span>{selectedProof.evidenceNote}</span></div><small>Room: {selectedRoom?.title ?? "Mission-wide"}</small><small>Linked Move: {selectedMove?.title ?? "None"}</small>{selectedProof.submitterDisplayName ? <small>Submitted by {selectedProof.submitterDisplayName}</small> : null}{selectedProof.verifierDisplayName ? <small>Reviewed by {selectedProof.verifierDisplayName}</small> : null}{capabilities?.verifiedAt ? <small>Verified {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(capabilities.verifiedAt)}</small> : null}</article> : null}
      {(selectedProof === undefined ? canCreate : canEdit) && rooms.length > 0 ? <form className="proof-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><label>Proof title<input disabled={pendingIntent !== null} onChange={(event) => setTitle(event.target.value)} ref={firstFieldRef} required value={title} /></label><label>Claim<textarea disabled={pendingIntent !== null} onChange={(event) => setClaim(event.target.value)} required value={claim} /></label><label>Evidence note<textarea disabled={pendingIntent !== null} onChange={(event) => setEvidenceNote(event.target.value)} required value={evidenceNote} /></label><label>Room<select disabled={pendingIntent !== null} onChange={(event) => { setRoomId(event.target.value as Id<"rooms">); setLinkedMoveId(""); }} required value={roomId}>{rooms.map((room) => <option key={room._id} value={room._id}>{room.title}</option>)}</select></label><label>Linked Move (optional)<select disabled={pendingIntent !== null} onChange={(event) => setLinkedMoveId(event.target.value as Id<"moves"> | "")} value={linkedMoveId}><option value="">No linked Move</option>{linkedMoveOptions.map((move) => <option key={move._id} value={move._id}>{move.title}</option>)}</select></label><button disabled={pendingIntent !== null} type="submit">{pendingIntent === "create" ? "Submitting…" : selectedProof === undefined ? "Submit Proof" : pendingIntent?.startsWith("update:") ? "Saving…" : "Save Proof"}</button></form> : (selectedProof === undefined ? <p>No writable Room is available for a Proof.</p> : null)}
      {selectedProof !== undefined && selectedProof.status === "submitted" ? <section aria-label={`Proof actions for ${selectedProof.title}`} className="proof-actions">{canReview ? <><button disabled={pendingIntent !== null} onClick={() => void transition("verified")} type="button">{pendingIntent?.endsWith(":verified") ? "Verifying…" : `Verify ${selectedProof.title}`}</button><button disabled={pendingIntent !== null} onClick={() => void transition("rejected")} type="button">{pendingIntent?.endsWith(":rejected") ? "Rejecting…" : `Reject ${selectedProof.title}`}</button></> : null}</section> : null}
      {selectedProof !== undefined && selectedProof.status === "rejected" && canResubmit ? <section aria-label={`Proof actions for ${selectedProof.title}`} className="proof-actions"><button disabled={pendingIntent !== null} onClick={() => void transition("submitted")} type="button">{pendingIntent?.endsWith(":submitted") ? "Resubmitting…" : `Resubmit ${selectedProof.title}`}</button></section> : null}
      {proofs !== undefined && proofs.length > 0 ? <ul aria-label="Mission Proofs" className="proof-list">{proofs.map((proof) => <li key={proof._id}><button aria-pressed={selectedProofId === proof._id} onClick={(event) => inspectProof(proof._id, event)} type="button"><span><strong>{proof.title}</strong><em>{statusLabel(proof.status)}</em></span><small>{proof.claim}</small></button></li>)}</ul> : null}
      {status ? <p aria-live="polite" className="proof-surface__status">{status}</p> : null}
      {proofs === undefined ? <p>Loading Proofs…</p> : proofs.length === 0 ? <p className="proof-surface__empty">No Proofs yet. Turn a meaningful claim into something the Mission can verify.</p> : null}
    </div>, document.body) : null}
  </section>;
}
