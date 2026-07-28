"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Icon } from "@/app/ui/icons";

type CallStatus = "open" | "accepted" | "resolved" | "cancelled";

type Mission = {
  _id: Id<"missions">;
  lifecycle: string;
  role: string;
};

type RoomOption = {
  _id: Id<"rooms">;
  title: string;
  x: number;
  y: number;
};

type MoveOption = {
  _id: Id<"moves">;
  title: string;
  roomId?: Id<"rooms">;
};

const transitions: Partial<Record<CallStatus, CallStatus[]>> = {
  open: ["accepted", "cancelled"],
  accepted: ["open", "resolved", "cancelled"],
};

function statusLabel(status: CallStatus) {
  return status === "accepted" ? "accepted" : status;
}

function transitionLabel(status: CallStatus) {
  return ({ accepted: "Accept", open: "Reopen", resolved: "Resolve", cancelled: "Cancel" } as const)[status];
}

export function CallSurface({
  mission,
  rooms,
  moves,
}: Readonly<{
  mission: Mission;
  rooms: RoomOption[];
  moves: MoveOption[];
}>) {
  const calls = useQuery(api.calls.listMissionCalls, { missionId: mission._id });
  const createCall = useMutation(api.calls.createCall);
  const updateCall = useMutation(api.calls.updateCall);
  const transitionCall = useMutation(api.calls.transitionCall);
  const commandKeys = useRef<Record<string, string>>({});
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<Id<"calls"> | null>(null);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [roomId, setRoomId] = useState<Id<"rooms"> | "">(rooms[0]?._id ?? "");
  const [linkedMoveId, setLinkedMoveId] = useState<Id<"moves"> | "">("");
  const [pendingIntent, setPendingIntent] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const canWrite = mission.lifecycle === "active" && ["owner", "steward", "builder", "contributor"].includes(mission.role);
  const selectedCall = calls?.find((call) => call._id === selectedCallId);
  const linkedMoveOptions = moves.filter((move) => move.roomId === roomId);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => firstFieldRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pendingIntent === null) setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, pendingIntent]);

  function resetComposer(clearStatus = true) {
    setSelectedCallId(null);
    setTitle("");
    setDetail("");
    setRoomId(rooms[0]?._id ?? "");
    setLinkedMoveId("");
    if (clearStatus) setStatus(null);
  }

  function openComposer() {
    resetComposer();
    setOpen(true);
  }

  function inspectCall(callId: Id<"calls">) {
    const call = calls?.find((candidate) => candidate._id === callId);
    if (!call) return;
    setSelectedCallId(call._id);
    setTitle(call.title);
    setDetail(call.detail);
    setRoomId(call.roomId ?? "");
    setLinkedMoveId(call.linkedMoveId ?? "");
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
      setStatus("The Call could not change. Review the latest state and retry.");
      return false;
    } finally {
      setPendingIntent(null);
    }
  }

  async function save() {
    if (!canWrite || roomId === "") return;
    if (selectedCall === undefined) {
      const succeeded = await runCommand(
        "create",
        (idempotencyKey) => createCall({
          missionId: mission._id,
          roomId,
          linkedMoveId: linkedMoveId || undefined,
          title,
          detail,
          idempotencyKey,
          correlationId: crypto.randomUUID(),
        }),
        "Call issued.",
      );
      if (succeeded) resetComposer(false);
      return;
    }
    const succeeded = await runCommand(
      `update:${selectedCall._id}`,
      (idempotencyKey) => updateCall({
        callId: selectedCall._id,
        expectedVersion: selectedCall.currentVersion,
        roomId,
        linkedMoveId: linkedMoveId || null,
        title,
        detail,
        idempotencyKey,
        correlationId: crypto.randomUUID(),
      }),
      "Call details saved.",
    );
    if (succeeded) setSelectedCallId(null);
  }

  async function transition(nextStatus: CallStatus) {
    if (selectedCall === undefined) return;
    await runCommand(
      `transition:${selectedCall._id}:${nextStatus}`,
      (idempotencyKey) => transitionCall({
        callId: selectedCall._id,
        expectedVersion: selectedCall.currentVersion,
        nextStatus,
        idempotencyKey,
        correlationId: crypto.randomUUID(),
      }),
      `${selectedCall.title} is now ${statusLabel(nextStatus)}.`,
    );
  }

  return (
    <section className="call-surface" aria-label="Mission Calls">
      <button className="call-surface__trigger" onClick={openComposer} type="button">
        <Icon name="spark" /> {canWrite ? "Issue Call" : "View Calls"}{calls === undefined ? "" : ` (${calls.length})`}
      </button>

      <div className="call-beacons" aria-label="Calls anchored to Mission rooms">
        {calls?.map((call, index) => {
          const room = rooms.find((candidate) => candidate._id === call.roomId);
          return (
            <button
              aria-label={`Open Call: ${call.title}, ${statusLabel(call.status)}`}
              className={`call-beacon call-beacon--${call.status}`}
              key={call._id}
              onClick={() => inspectCall(call._id)}
              style={{
                left: `calc(${room?.x ?? 50}% + ${(index % 3) * 12}px)`,
                top: `calc(${room?.y ?? 10}% + ${-42 - Math.floor(index / 3) * 12}px)`,
              }}
              type="button"
            >
              <span aria-hidden="true"><Icon name="spark" /></span>
              <strong>{call.title}</strong>
              <small>{statusLabel(call.status)}</small>
            </button>
          );
        })}
      </div>

      {open ? createPortal((
        <div aria-labelledby="call-surface-title" aria-modal="true" className="preference-panel call-surface__panel" role="dialog">
          <div className="preference-panel__header">
            <div>
              <p className="eyebrow">Mission Calls</p>
              <h2 id="call-surface-title">Ask for a hand, in context</h2>
            </div>
            <button aria-label="Close Calls" className="icon-button" disabled={pendingIntent !== null} onClick={() => setOpen(false)} type="button">×</button>
          </div>

          {!canWrite ? <p aria-label="Mission Calls read-only">Calls are read-only for your role or this archived Mission.</p> : null}
          {selectedCall !== undefined && canWrite ? <button className="call-surface__back" disabled={pendingIntent !== null} onClick={() => resetComposer()} type="button">Issue another Call</button> : null}

          {canWrite && rooms.length > 0 ? (
            <form className="call-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <label>
                Call title
                <input disabled={pendingIntent !== null} onChange={(event) => setTitle(event.target.value)} ref={firstFieldRef} required value={title} />
              </label>
              <label>
                Detail
                <textarea disabled={pendingIntent !== null} onChange={(event) => setDetail(event.target.value)} required value={detail} />
              </label>
              <label>
                Room
                <select disabled={pendingIntent !== null} onChange={(event) => { setRoomId(event.target.value as Id<"rooms">); setLinkedMoveId(""); }} required value={roomId}>
                  {rooms.map((room) => <option key={room._id} value={room._id}>{room.title}</option>)}
                </select>
              </label>
              <label>
                Linked Move (optional)
                <select disabled={pendingIntent !== null} onChange={(event) => setLinkedMoveId(event.target.value as Id<"moves"> | "")} value={linkedMoveId}>
                  <option value="">No linked Move</option>
                  {linkedMoveOptions.map((move) => <option key={move._id} value={move._id}>{move.title}</option>)}
                </select>
              </label>
              <button disabled={pendingIntent !== null} type="submit">{pendingIntent === "create" ? "Issuing…" : selectedCall === undefined ? "Issue Call" : pendingIntent?.startsWith("update:") ? "Saving…" : "Save Call"}</button>
            </form>
          ) : canWrite ? <p>No writable Room is available for a Call.</p> : null}

          {selectedCall !== undefined && canWrite ? (
            <section aria-label={`Call actions for ${selectedCall.title}`} className="call-actions">
              <p><strong>{selectedCall.title}</strong> <span>{statusLabel(selectedCall.status)}</span></p>
              {(transitions[selectedCall.status] ?? []).map((nextStatus) => (
                <button disabled={pendingIntent !== null} key={nextStatus} onClick={() => void transition(nextStatus)} type="button">
                  {pendingIntent === `transition:${selectedCall._id}:${nextStatus}` ? `${transitionLabel(nextStatus)}ing…` : `${transitionLabel(nextStatus)} ${selectedCall.title}`}
                </button>
              ))}
            </section>
          ) : null}

          {calls !== undefined && calls.length > 0 ? (
            <ul className="call-list" aria-label="Mission Calls">
              {calls.map((call) => {
                const callRoom = rooms.find((room) => room._id === call.roomId);
                const linkedMove = moves.find((move) => move._id === call.linkedMoveId);
                return (
                  <li key={call._id}>
                    <button aria-pressed={selectedCallId === call._id} onClick={() => inspectCall(call._id)} type="button">
                      <span><strong>{call.title}</strong><em>{statusLabel(call.status)}</em></span>
                      <small>{call.detail}</small>
                      <i>{callRoom?.title ?? "Mission-wide"}{linkedMove ? ` · Move: ${linkedMove.title}` : ""}</i>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {status ? <p aria-live="polite" className="call-surface__status">{status}</p> : null}
          {calls === undefined ? <p>Loading Calls…</p> : calls.length === 0 ? <p className="call-surface__empty">No Calls yet. Place the first request where the work is happening.</p> : null}
        </div>
      ), document.body) : null}
    </section>
  );
}
