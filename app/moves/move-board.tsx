"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type MoveState =
  | "proposed"
  | "ready"
  | "claimed"
  | "inProgress"
  | "blocked"
  | "review"
  | "completed"
  | "cancelled"
  | "archived";

type Mission = {
  _id: Id<"missions">;
  role: string;
  lifecycle: string;
};

type RoomOption = {
  _id: Id<"rooms">;
  title: string;
};

type CreateMoveRequest = {
  roomId: Id<"rooms">;
  nonce: string;
};

type InspectMoveRequest = {
  moveId: Id<"moves">;
  roomId: Id<"rooms">;
  nonce: string;
};

type CreatedMove = {
  roomId: Id<"rooms">;
  moveId: Id<"moves">;
};

const transitions: Partial<Record<MoveState, MoveState[]>> = {
  proposed: ["ready", "cancelled"],
  ready: ["inProgress", "blocked", "cancelled"],
  inProgress: ["review", "blocked", "cancelled"],
  blocked: ["ready", "cancelled"],
  review: ["completed", "inProgress", "blocked"],
};

function stateLabel(state: MoveState) {
  if (state === "inProgress") return "in progress";
  return state;
}

export function MoveBoard({
  mission,
  rooms,
  createMoveRequest,
  onCreateMoveRequestHandled,
  onCreateMoveRequestUnavailable,
  inspectMoveRequest,
  onInspectMoveRequestHandled,
  onInspectMoveRequestUnavailable,
  onViewCreatedMove,
}: Readonly<{
  mission: Mission;
  rooms: RoomOption[];
  createMoveRequest?: CreateMoveRequest | null;
  onCreateMoveRequestHandled?: () => void;
  onCreateMoveRequestUnavailable?: () => void;
  inspectMoveRequest?: InspectMoveRequest | null;
  onInspectMoveRequestHandled?: () => void;
  onInspectMoveRequestUnavailable?: () => void;
  onViewCreatedMove?: (createdMove: CreatedMove) => void;
}>) {
  const moves = useQuery(api.moves.listMissionMoves, { missionId: mission._id });
  const createMove = useMutation(api.moves.createMove);
  const updateMove = useMutation(api.moves.updateMove);
  const transitionMove = useMutation(api.moves.transitionMove);
  const commandKeys = useRef<Record<string, string>>({});
  const openerRef = useRef<HTMLButtonElement>(null);
  const createTitleRef = useRef<HTMLInputElement>(null);
  const inspectedMoveRef = useRef<HTMLElement>(null);
  const pendingHandoffFocusRef = useRef<string | null>(null);
  const pendingInspectionFocusRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createIntent, setCreateIntent] = useState("");
  const [createRoomId, setCreateRoomId] = useState<Id<"rooms"> | "">(rooms[0]?._id ?? "");
  const [editingId, setEditingId] = useState<Id<"moves"> | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editIntent, setEditIntent] = useState("");
  const [editVersion, setEditVersion] = useState(0);
  const [editDependencies, setEditDependencies] = useState<Id<"moves">[]>([]);
  const [pendingIntent, setPendingIntent] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [handoffFocusNonce, setHandoffFocusNonce] = useState<string | null>(null);
  const [inspectionFocusNonce, setInspectionFocusNonce] = useState<string | null>(null);
  const [inspectionFocusMoveId, setInspectionFocusMoveId] = useState<Id<"moves"> | null>(null);
  const [firstMoveRoomId, setFirstMoveRoomId] = useState<Id<"rooms"> | null>(null);
  const [createdFirstMove, setCreatedFirstMove] = useState<CreatedMove | null>(null);
  const canWrite =
    mission.lifecycle === "active" &&
    ["owner", "steward", "builder"].includes(mission.role);

  useEffect(() => {
    if (createMoveRequest === undefined || createMoveRequest === null) return;
    const requestedRoomIsAvailable = canWrite && rooms.some((room) => room._id === createMoveRequest.roomId);
    const frame = window.requestAnimationFrame(() => {
      if (requestedRoomIsAvailable) {
        setCreateRoomId(createMoveRequest.roomId);
        setFirstMoveRoomId(createMoveRequest.roomId);
        setCreatedFirstMove(null);
        pendingHandoffFocusRef.current = createMoveRequest.nonce;
        setHandoffFocusNonce(createMoveRequest.nonce);
        setOpen(true);
      } else {
        onCreateMoveRequestUnavailable?.();
      }
      onCreateMoveRequestHandled?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canWrite, createMoveRequest, onCreateMoveRequestHandled, onCreateMoveRequestUnavailable, rooms]);

  useLayoutEffect(() => {
    if (!open) return;
    if (handoffFocusNonce !== null && pendingHandoffFocusRef.current === handoffFocusNonce) {
      createTitleRef.current?.focus();
      pendingHandoffFocusRef.current = null;
    }
    if (inspectionFocusNonce !== null && pendingInspectionFocusRef.current === inspectionFocusNonce) {
      inspectedMoveRef.current?.focus();
      pendingInspectionFocusRef.current = null;
    }
  }, [handoffFocusNonce, inspectionFocusNonce, open]);

  useEffect(() => {
    if (inspectMoveRequest === undefined || inspectMoveRequest === null || moves === undefined) return;
    const requestedMove = rooms.some((room) => room._id === inspectMoveRequest.roomId)
      ? moves.find((move) => move._id === inspectMoveRequest.moveId && move.roomId === inspectMoveRequest.roomId)
      : undefined;
    const frame = window.requestAnimationFrame(() => {
      if (requestedMove !== undefined) {
        setEditingId(null);
        setFirstMoveRoomId(null);
        setCreatedFirstMove(null);
        setStatus(null);
        pendingHandoffFocusRef.current = null;
        setHandoffFocusNonce(null);
        setInspectionFocusMoveId(requestedMove._id);
        pendingInspectionFocusRef.current = inspectMoveRequest.nonce;
        setInspectionFocusNonce(inspectMoveRequest.nonce);
        setOpen(true);
      } else {
        onInspectMoveRequestUnavailable?.();
      }
      onInspectMoveRequestHandled?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inspectMoveRequest, moves, onInspectMoveRequestHandled, onInspectMoveRequestUnavailable, rooms]);

  useEffect(() => () => {
    pendingHandoffFocusRef.current = null;
    pendingInspectionFocusRef.current = null;
  }, []);

  function close() {
    pendingHandoffFocusRef.current = null;
    pendingInspectionFocusRef.current = null;
    setHandoffFocusNonce(null);
    setInspectionFocusNonce(null);
    setInspectionFocusMoveId(null);
    setFirstMoveRoomId(null);
    setCreatedFirstMove(null);
    setOpen(false);
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }

  async function runCommand<Result>(
    intent: string,
    action: (idempotencyKey: string) => Promise<Result>,
    successMessage: string,
  ) {
    if (pendingIntent !== null) return null;
    const idempotencyKey = commandKeys.current[intent] ?? crypto.randomUUID();
    commandKeys.current[intent] = idempotencyKey;
    setPendingIntent(intent);
    setStatus(null);
    try {
      const result = await action(idempotencyKey);
      delete commandKeys.current[intent];
      setStatus(successMessage);
      return result;
    } catch {
      setStatus("The Move could not change. Review the latest state and retry.");
      return null;
    } finally {
      setPendingIntent(null);
    }
  }

  async function create() {
    if (!canWrite || createRoomId === "") return;
    const succeeded = await runCommand(
      "create",
      (idempotencyKey) =>
        createMove({
          missionId: mission._id,
          roomId: createRoomId,
          title: createTitle,
          intent: createIntent,
          dependencyMoveIds: [],
          idempotencyKey,
          correlationId: crypto.randomUUID(),
        }),
      "Move created.",
    );
    if (succeeded !== null) {
      setCreateTitle("");
      setCreateIntent("");
      if (firstMoveRoomId === createRoomId) {
        setCreatedFirstMove({ roomId: createRoomId, moveId: succeeded.moveId });
        setFirstMoveRoomId(null);
      }
    }
  }

  async function saveEdit(moveId: Id<"moves">) {
    const succeeded = await runCommand(
      `edit:${moveId}`,
      (idempotencyKey) =>
        updateMove({
          moveId,
          expectedVersion: editVersion,
          title: editTitle,
          intent: editIntent,
          dependencyMoveIds: editDependencies,
          idempotencyKey,
          correlationId: crypto.randomUUID(),
        }),
      "Move details saved.",
    );
    if (succeeded !== null) setEditingId(null);
  }

  async function transition(
    moveId: Id<"moves">,
    currentVersion: number,
    nextState: MoveState,
    title: string,
  ) {
    await runCommand(
      `transition:${moveId}:${nextState}`,
      (idempotencyKey) =>
        transitionMove({
          moveId,
          expectedVersion: currentVersion,
          nextState: nextState as "ready",
          idempotencyKey,
          correlationId: crypto.randomUUID(),
        }),
      `${title} is now ${stateLabel(nextState)}.`,
    );
  }

  return (
    <section className="move-board" aria-label="Mission Moves">
      <button onClick={() => setOpen(true)} ref={openerRef} type="button">
        Open Moves{moves === undefined ? "" : ` (${moves.length})`}
      </button>
      {open ? (
        <div
          aria-labelledby="move-board-title"
          aria-modal="true"
          className="preference-panel move-board-panel"
          role="dialog"
        >
          <div className="preference-panel__header">
            <div>
              <p className="eyebrow">Mission Moves</p>
              <h2 id="move-board-title">Turn intent into progress</h2>
            </div>
            <button
              aria-label="Close Moves"
              className="icon-button"
              disabled={pendingIntent !== null}
              onClick={close}
              type="button"
            >
              ×
            </button>
          </div>

          {!canWrite ? (
            <p aria-label="Mission Moves read-only">
              Moves are read-only for your role or this archived Mission.
            </p>
          ) : rooms.length === 0 ? (
            <p>No writable Room is available for a new Move.</p>
          ) : (
            <form
              className="move-create"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label>
                Move title
                <input
                  disabled={pendingIntent !== null}
                  onChange={(event) => setCreateTitle(event.target.value)}
                  ref={createTitleRef}
                  required
                  value={createTitle}
                />
              </label>
              <label>
                Move intent
                <textarea
                  disabled={pendingIntent !== null}
                  onChange={(event) => setCreateIntent(event.target.value)}
                  required
                  value={createIntent}
                />
              </label>
              <label>
                Room
                <select
                  disabled={pendingIntent !== null}
                  onChange={(event) =>
                    setCreateRoomId(event.target.value as Id<"rooms">)
                  }
                  required
                  value={createRoomId}
                >
                  {rooms.map((room) => (
                    <option key={room._id} value={room._id}>
                      {room.title}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={pendingIntent !== null} type="submit">
                {pendingIntent === "create" ? "Creating…" : "Create Move"}
              </button>
            </form>
          )}

          {status ? <p aria-live="polite">{status}</p> : null}
          {createdFirstMove === null || onViewCreatedMove === undefined ? null : (
            <button
              onClick={() => {
                setOpen(false);
                onViewCreatedMove(createdFirstMove);
              }}
              type="button"
            >
              View Workshop
            </button>
          )}
          {moves === undefined ? (
            <p>Loading Moves…</p>
          ) : (
            <ul className="move-list">
              {moves.map((move) => {
                const dependencyTitles = move.dependencyMoveIds
                  .map((dependencyId) =>
                    moves.find((candidate) => candidate._id === dependencyId),
                  )
                  .filter((dependency) => dependency !== undefined)
                  .map((dependency) => dependency.title);
                return (
                  <li key={move._id}>
                    <article
                      aria-label={`Move ${move.title}`}
                      ref={inspectionFocusMoveId === move._id ? inspectedMoveRef : undefined}
                      tabIndex={inspectionFocusMoveId === move._id ? -1 : undefined}
                    >
                      <header>
                        <strong>{move.title}</strong>
                        <span>{stateLabel(move.state)}</span>
                      </header>
                      {editingId === move._id ? (
                        <div className="move-edit">
                          <label>
                            Move title
                            <input
                              disabled={pendingIntent !== null}
                              onChange={(event) => setEditTitle(event.target.value)}
                              value={editTitle}
                            />
                          </label>
                          <label>
                            Move intent
                            <textarea
                              disabled={pendingIntent !== null}
                              onChange={(event) => setEditIntent(event.target.value)}
                              value={editIntent}
                            />
                          </label>
                          <fieldset disabled={pendingIntent !== null}>
                            <legend>Dependencies</legend>
                            {moves
                              .filter((candidate) => candidate._id !== move._id)
                              .map((candidate) => (
                                <label key={candidate._id}>
                                  <input
                                    checked={editDependencies.includes(candidate._id)}
                                    onChange={() =>
                                      setEditDependencies((current) =>
                                        current.includes(candidate._id)
                                          ? current.filter((id) => id !== candidate._id)
                                          : [...current, candidate._id],
                                      )
                                    }
                                    type="checkbox"
                                  />
                                  {candidate.title}
                                </label>
                              ))}
                          </fieldset>
                          <button
                            disabled={pendingIntent !== null}
                            onClick={() => void saveEdit(move._id)}
                            type="button"
                          >
                            Save Move
                          </button>
                          <button
                            disabled={pendingIntent !== null}
                            onClick={() => setEditingId(null)}
                            type="button"
                          >
                            Cancel edit
                          </button>
                        </div>
                      ) : (
                        <>
                          <p>{move.intent}</p>
                          <small>
                            {dependencyTitles.length === 0
                              ? "No dependencies"
                              : `Depends on ${dependencyTitles.join(", ")}`}
                          </small>
                          {canWrite ? (
                            <button
                              aria-label={`Edit Move ${move.title}`}
                              disabled={pendingIntent !== null}
                              onClick={() => {
                                setEditingId(move._id);
                                setEditTitle(move.title);
                                setEditIntent(move.intent);
                                setEditVersion(move.currentVersion);
                                setEditDependencies(move.dependencyMoveIds);
                              }}
                              type="button"
                            >
                              Edit Move
                            </button>
                          ) : null}
                        </>
                      )}
                      {canWrite
                        ? (transitions[move.state] ?? []).map((nextState) => (
                            <button
                              aria-label={`Mark ${move.title} ${stateLabel(nextState)}`}
                              disabled={pendingIntent !== null}
                              key={nextState}
                              onClick={() =>
                                void transition(
                                  move._id,
                                  move.currentVersion,
                                  nextState,
                                  move.title,
                                )
                              }
                              type="button"
                            >
                              Mark {stateLabel(nextState)}
                            </button>
                          ))
                        : null}
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
