"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const joinCall = useMutation(api.calls.joinCall);
  const withdrawCall = useMutation(api.calls.withdrawCall);
  const respondToCall = useMutation(api.calls.respondToCall);
  const commandKeys = useRef<Record<string, string>>({});
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const pendingIntentRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<Id<"calls"> | null>(null);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [roomId, setRoomId] = useState<Id<"rooms"> | "">(rooms[0]?._id ?? "");
  const [linkedMoveId, setLinkedMoveId] = useState<Id<"moves"> | "">("");
  const [maxParticipants, setMaxParticipants] = useState("50");
  const [responseDraft, setResponseDraft] = useState<{ callId: Id<"calls"> | null; participantVersion: number; value: string }>({ callId: null, participantVersion: -1, value: "" });
  const [pendingIntent, setPendingIntent] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const participants = useQuery(
    api.calls.listCallParticipants,
    selectedCallId === null ? "skip" : { callId: selectedCallId },
  );
  const canCreate = mission.lifecycle === "active" && ["owner", "steward", "builder", "contributor"].includes(mission.role);
  const canParticipate = mission.lifecycle === "active" && ["owner", "steward", "builder", "reviewer", "contributor"].includes(mission.role);
  const selectedCall = calls?.find((call) => call._id === selectedCallId);
  const linkedMoveOptions = moves.filter((move) => move.roomId === roomId);
  const selectedCallRoom = rooms.find((room) => room._id === selectedCall?.roomId);
  const selectedCallMove = moves.find((move) => move._id === selectedCall?.linkedMoveId);
  const selectedTransitions = selectedCall === undefined ? [] : transitions[selectedCall.status] ?? [];
  const isTerminalCall = selectedCall?.status === "resolved" || selectedCall?.status === "cancelled";
  const isEditableCall = selectedCall === undefined ? canCreate : Boolean(selectedCall?.canAdminister) && !isTerminalCall;
  const currentParticipant = participants?.find((participant) => participant.isCurrentUser);
  const canChangeParticipation = canParticipate && !isTerminalCall && selectedCall !== undefined;
  const remainingSlots = selectedCall === undefined ? 0 : Math.max(0, selectedCall.maxParticipants - selectedCall.joinedCount);
  const response = responseDraft.callId === selectedCallId && responseDraft.participantVersion === currentParticipant?.currentVersion
    ? responseDraft.value
    : currentParticipant?.response ?? "";
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
    setSelectedCallId(null);
    setTitle("");
    setDetail("");
    setRoomId(rooms[0]?._id ?? "");
    setLinkedMoveId("");
    setMaxParticipants("50");
    setResponseDraft({ callId: null, participantVersion: -1, value: "" });
    if (clearStatus) setStatus(null);
  }

  function openComposer(event: React.MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    resetComposer();
    setOpen(true);
  }

  function inspectCall(callId: Id<"calls">, event: React.MouseEvent<HTMLButtonElement>) {
    const call = calls?.find((candidate) => candidate._id === callId);
    if (!call) return;
    if (!panelRef.current?.contains(event.currentTarget)) openerRef.current = event.currentTarget;
    setSelectedCallId(call._id);
    setTitle(call.title);
    setDetail(call.detail);
    setRoomId(call.roomId ?? "");
    setLinkedMoveId(call.linkedMoveId ?? "");
    setMaxParticipants(String(call.maxParticipants));
    setResponseDraft({ callId: null, participantVersion: -1, value: "" });
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
    if (!isEditableCall || roomId === "") return;
    const participantLimit = Number(maxParticipants);
    if (!Number.isInteger(participantLimit) || participantLimit < 1 || participantLimit > 50) {
      setStatus("Choose a participant limit from 1 to 50.");
      return;
    }
    if (selectedCall === undefined) {
      const succeeded = await runCommand(
        "create",
        (idempotencyKey) => createCall({
          missionId: mission._id,
          roomId,
          linkedMoveId: linkedMoveId || undefined,
          title,
          detail,
          maxParticipants: participantLimit,
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
        maxParticipants: participantLimit,
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

  async function join() {
    if (!selectedCall || !canChangeParticipation) return;
    await runCommand(
      `join:${selectedCall._id}`,
      (idempotencyKey) => joinCall({ callId: selectedCall._id, idempotencyKey, correlationId: crypto.randomUUID() }),
      `You joined ${selectedCall.title}.`,
    );
  }

  async function withdraw() {
    if (!selectedCall || !currentParticipant || !canChangeParticipation) return;
    await runCommand(
      `withdraw:${selectedCall._id}`,
      (idempotencyKey) => withdrawCall({ callId: selectedCall._id, expectedParticipantVersion: currentParticipant.currentVersion, idempotencyKey, correlationId: crypto.randomUUID() }),
      `You withdrew from ${selectedCall.title}.`,
    );
  }

  async function respond() {
    if (!selectedCall || !currentParticipant || !canChangeParticipation) return;
    await runCommand(
      `respond:${selectedCall._id}`,
      (idempotencyKey) => respondToCall({ callId: selectedCall._id, expectedParticipantVersion: currentParticipant.currentVersion, response, idempotencyKey, correlationId: crypto.randomUUID() }),
      `Response sent to ${selectedCall.title}.`,
    );
  }

  return (
    <section className="call-surface" aria-label="Mission Calls">
      <button className="call-surface__trigger" onClick={openComposer} type="button">
        <Icon name="spark" /> {canCreate ? "Issue Call" : "View Calls"}{calls === undefined ? "" : ` (${calls.length})`}
      </button>

      <div className="call-beacons" aria-label="Calls anchored to Mission rooms">
        {calls?.map((call, index) => {
          const room = rooms.find((candidate) => candidate._id === call.roomId);
          return (
            <button
              aria-label={`Open Call: ${call.title}, ${statusLabel(call.status)}, ${call.joinedCount} of ${call.maxParticipants} participants`}
              className={`call-beacon call-beacon--${call.status}`}
              key={call._id}
              onClick={(event) => inspectCall(call._id, event)}
              style={{
                left: `calc(${room?.x ?? 50}% + ${(index % 3) * 12}px)`,
                top: `calc(${room?.y ?? 10}% + ${-42 - Math.floor(index / 3) * 12}px)`,
              }}
              type="button"
            >
              <span aria-hidden="true"><Icon name="spark" /></span>
              <strong>{call.title}</strong>
              <small>{statusLabel(call.status)} · {call.joinedCount}/{call.maxParticipants}</small>
            </button>
          );
        })}
      </div>

      {open ? createPortal((
        <div aria-labelledby="call-surface-title" aria-modal="true" className="preference-panel call-surface__panel" ref={panelRef} role="dialog">
          <div className="preference-panel__header">
            <div>
              <p className="eyebrow">Mission Calls</p>
              <h2 id="call-surface-title">Ask for a hand, in context</h2>
            </div>
            <button aria-label="Close Calls" className="icon-button" disabled={pendingIntent !== null} onClick={closeSurface} type="button">×</button>
          </div>

          {!canCreate && !canParticipate ? <p aria-label="Mission Calls read-only">Calls are read-only for your role or this archived Mission.</p> : null}
          {selectedCall !== undefined && canCreate ? <button className="call-surface__back" disabled={pendingIntent !== null} onClick={() => resetComposer()} type="button">Issue another Call</button> : null}

          {selectedCall !== undefined ? (
            <article className="call-detail" aria-label={`Call details for ${selectedCall.title}`}>
              <p><strong>{selectedCall.title}</strong><span>{statusLabel(selectedCall.status)}</span></p>
              <div>{selectedCall.detail}</div>
              <small>Room: {selectedCallRoom?.title ?? "Mission-wide"}</small>
              <small>Linked Move: {selectedCallMove?.title ?? "None"}</small>
              <small aria-live="polite" className="call-detail__capacity" role="status">{selectedCall.joinedCount} / {selectedCall.maxParticipants} participants</small>
            </article>
          ) : null}

          {isEditableCall && rooms.length > 0 ? (
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
              <label>
                Participant limit (1–50)
                <input disabled={pendingIntent !== null} max="50" min="1" onChange={(event) => setMaxParticipants(event.target.value)} required type="number" value={maxParticipants} />
              </label>
              <button disabled={pendingIntent !== null} type="submit">{pendingIntent === "create" ? "Issuing…" : selectedCall === undefined ? "Issue Call" : pendingIntent?.startsWith("update:") ? "Saving…" : "Save Call"}</button>
            </form>
          ) : isEditableCall ? <p>No writable Room is available for a Call.</p> : null}

          {selectedCall !== undefined && selectedCall.canAdminister && selectedTransitions.length > 0 ? (
            <section aria-label={`Call actions for ${selectedCall.title}`} className="call-actions">
              <p><strong>{selectedCall.title}</strong> <span>{statusLabel(selectedCall.status)}</span></p>
              {selectedTransitions.map((nextStatus) => (
                <button disabled={pendingIntent !== null} key={nextStatus} onClick={() => void transition(nextStatus)} type="button">
                  {pendingIntent === `transition:${selectedCall._id}:${nextStatus}` ? `${transitionLabel(nextStatus)}ing…` : `${transitionLabel(nextStatus)} ${selectedCall.title}`}
                </button>
              ))}
            </section>
          ) : null}

          {selectedCall !== undefined ? (
            <section aria-label={`Call participants for ${selectedCall.title}`} className="call-participants">
              <div className="call-participants__header">
                <strong>Participants</strong>
                <span>{selectedCall.joinedCount} / {selectedCall.maxParticipants}</span>
              </div>
              {participants === undefined ? <p>Loading participants…</p> : participants.length === 0 ? <p>No one has joined yet.</p> : (
                <ul>
                  {participants.map((participant, index) => <li key={participant._id}>
                    <span>{participant.isCurrentUser ? "You" : participant.displayName ?? participant.role ?? `Collaborator ${index + 1}`}</span>
                    {participant.response ? <small>{participant.response}</small> : <small>Joined</small>}
                  </li>)}
                </ul>
              )}
              {canChangeParticipation && participants !== undefined ? (
                <div className="call-participation-actions">
                  {currentParticipant ? <button disabled={pendingIntent !== null} onClick={() => void withdraw()} type="button">{pendingIntent?.startsWith("withdraw:") ? "Withdrawing…" : `Withdraw ${selectedCall.title}`}</button> : (
                    <button disabled={pendingIntent !== null || remainingSlots === 0} onClick={() => void join()} type="button">{pendingIntent?.startsWith("join:") ? "Joining…" : `Join ${selectedCall.title}`}</button>
                  )}
                  {currentParticipant ? <>
                    <label>
                      Response to {selectedCall.title}
                      <textarea disabled={pendingIntent !== null} onChange={(event) => setResponseDraft({ callId: selectedCall._id, participantVersion: currentParticipant.currentVersion, value: event.target.value })} value={response} />
                    </label>
                    <button disabled={pendingIntent !== null || response.trim().length === 0} onClick={() => void respond()} type="button">{pendingIntent?.startsWith("respond:") ? "Responding…" : `Respond to ${selectedCall.title}`}</button>
                  </> : null}
                  {!currentParticipant && remainingSlots === 0 ? <p aria-live="polite">This Call is full.</p> : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {calls !== undefined && calls.length > 0 ? (
            <ul className="call-list" aria-label="Mission Calls">
              {calls.map((call) => {
                const callRoom = rooms.find((room) => room._id === call.roomId);
                const linkedMove = moves.find((move) => move._id === call.linkedMoveId);
                return (
                  <li key={call._id}>
                    <button aria-pressed={selectedCallId === call._id} onClick={(event) => inspectCall(call._id, event)} type="button">
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
