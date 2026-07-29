"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SessionControl } from "@/app/auth/session-control";
import { createDevelopmentAblyTransportFactory } from "@/app/realtime/development-ably-transport-factory";
import { AuthenticatedMissionRealtimeLifecycle } from "@/app/realtime/authenticated-mission-lifecycle";
import { OwnerInvitePanel } from "@/app/invitations/owner-invite-panel";
import { MissionControls } from "@/app/missions/mission-controls";
import { ConstitutionControls } from "@/app/missions/constitution-controls";
import { MoveBoard } from "@/app/moves/move-board";
import { CallSurface } from "@/app/calls/call-surface";
import { FractureSurface } from "@/app/fractures/fracture-surface";
import { ProofSurface } from "@/app/proofs/proof-surface";
import { PulseSurface } from "@/app/pulse/pulse-surface";
import { CallsignSettings, CallsignSetupGate } from "@/app/profiles/callsign-controls";
import { Icon, type IconName } from "@/app/ui/icons";
import type { AblyClientFactory } from "@/lib/realtime/ably-room-transport";

type RoomId = string;

type MoveSignal = {
  total: number;
  dominantState: string | null;
  hasNonterminalMove: boolean;
};

type Room = {
  id: RoomId;
  name: string;
  eyebrow: string;
  description: string;
  accent: string;
  icon: IconName;
  action: string;
  position: string;
  x: number;
  y: number;
  custom?: boolean;
  archived?: boolean;
  layoutVersion?: number;
  currentVersion?: number;
  layout?: { x: number; y: number; width: number; height: number };
  moveSignal: MoveSignal;
};

type Density = "focus" | "standard" | "compact";
type Accent = "blue" | "teal" | "violet";
type DefaultView = "map" | "list";
type Preferences = {
  density: Density;
  accent: Accent;
  reducedDecoration: boolean;
  defaultView: DefaultView;
};

function missionWorldStorageKey(missionId: Id<"missions">) {
  return `realworld:mission-world-preferences:v3:${missionId}`;
}
const selectedMissionStorageKey = "realworld:mission-world:selected-mission:v1";
const defaultPreferences: Preferences = {
  density: "standard",
  accent: "blue",
  reducedDecoration: false,
  defaultView: "map",
};

const emptyMoveSignal: MoveSignal = { total: 0, dominantState: null, hasNonterminalMove: false };

function moveStateLabel(state: string) {
  if (state === "inProgress") return "in progress";
  return state;
}

function moveSignalText(signal: MoveSignal) {
  if (signal.total === 0) return "No Moves";
  return `${signal.total} ${moveStateLabel(signal.dominantState ?? "unknown")} ${signal.total === 1 ? "Move" : "Moves"}`;
}

function roomMoveSignalLabel(room: Room) {
  return `${room.name} — ${moveSignalText(room.moveSignal)}`;
}

function roomMoveSignal(roomId: Id<"rooms">, moves: WorkshopMove[] | undefined): MoveSignal {
  const roomMoves = (moves ?? []).filter((move) => move.roomId === roomId);
  if (roomMoves.length === 0) return emptyMoveSignal;
  const statePriority = ["blocked", "inProgress", "review", "ready", "proposed", "completed", "cancelled", "archived"];
  const normalizedStates = roomMoves.map((move) => move.state === "claimed" ? "inProgress" : move.state);
  const dominantState = statePriority.find((state) => normalizedStates.includes(state)) ?? null;
  return {
    total: roomMoves.length,
    dominantState,
    hasNonterminalMove: roomMoves.some((move) => !["completed", "cancelled", "archived"].includes(move.state)),
  };
}

const rooms: Room[] = [
  {
    id: "core",
    name: "Mission Core",
    eyebrow: "Shared outcome",
    description: "Build Realworld into a production multiplayer work platform for humans and agents.",
    accent: "blue",
    icon: "spark",
    action: "Open Mission brief",
    position: "core",
    x: 50,
    y: 46,
    moveSignal: emptyMoveSignal,
  },
  {
    id: "workshop",
    name: "Workshop",
    eyebrow: "Artifact in motion",
    description: "Shape the working artifact, hand off a Move, and prepare a Proof.",
    accent: "azure",
    icon: "workshop",
    action: "Enter Workshop",
    position: "workshop",
    x: 74,
    y: 19,
    moveSignal: emptyMoveSignal,
  },
  {
    id: "observatory",
    name: "Research Observatory",
    eyebrow: "Evidence and questions",
    description: "Validate the assumptions behind the next release.",
    accent: "teal",
    icon: "observatory",
    action: "Explore evidence",
    position: "observatory",
    x: 19,
    y: 47,
    moveSignal: emptyMoveSignal,
  },
  {
    id: "branch",
    name: "Branch Lab",
    eyebrow: "Parallel workstreams",
    description: "Compare two approaches before a durable merge.",
    accent: "coral",
    icon: "branch",
    action: "Compare branches",
    position: "branch",
    x: 84,
    y: 50,
    moveSignal: emptyMoveSignal,
  },
  {
    id: "library",
    name: "Artifact Library",
    eyebrow: "Reusable outputs",
    description: "Keep the useful things this Mission has already learned.",
    accent: "amber",
    icon: "library",
    action: "Browse artifacts",
    position: "library",
    x: 18,
    y: 82,
    moveSignal: emptyMoveSignal,
  },
  {
    id: "surge",
    name: "Surge Hall",
    eyebrow: "Focused together",
    description: "A voluntary, time-boxed push with a clear shared outcome.",
    accent: "violet",
    icon: "surge",
    action: "Join Surge",
    position: "surge",
    x: 61,
    y: 84,
    moveSignal: emptyMoveSignal,
  },
];

type CanvasState = { zoom: number; panX: number; panY: number; locked: boolean };
const defaultCanvasState: CanvasState = { zoom: 1, panX: 0, panY: 0, locked: false };

function clamp(value: number, lower: number, upper: number) {
  return Math.min(upper, Math.max(lower, value));
}

function canvasRoom(record: { _id: Id<"rooms">; title: string; kind: string; layout: { x: number; y: number; width: number; height: number }; layoutVersion: number; currentVersion: number }, moveSignal: MoveSignal): Room {
  const fallback = rooms.find((room) => room.position === ({ missionCore: "core", workshop: "workshop", observatory: "observatory", branchLab: "branch", reviewDeck: "library", signalTower: "observatory", surgeHall: "surge" }[record.kind] ?? "core")) ?? rooms[0]!;
  const isCustom = record.kind === "branchLab" && record.title !== "Branch Lab";
  return {
    ...fallback,
    id: record._id,
    name: record.title,
    x: clamp(5 + (record.layout.x / 1200) * 90, 5, 95),
    y: clamp(6 + (record.layout.y / 800) * 86, 6, 92),
    layout: record.layout,
    layoutVersion: record.layoutVersion,
    currentVersion: record.currentVersion,
    moveSignal,
    ...(isCustom ? { accent: "blue" as const, icon: "spark" as const, position: "custom" as const, description: "A room shaped for this Mission's next mode of work.", eyebrow: "Custom room", action: "Open room", custom: true } : {}),
  };
}

function RoomLandmark({
  room,
  navigationRooms,
  selected,
  onSelect,
  onEnter,
  onReposition,
  locked,
}: Readonly<{
  room: Room;
  navigationRooms: Room[];
  selected: boolean;
  onSelect: (id: RoomId) => void;
  onEnter: (id: RoomId) => void;
  onReposition: (id: RoomId, x: number, y: number) => void;
  locked: boolean;
}>) {
  const roomRef = useRef<HTMLButtonElement>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      if (!locked) {
        const distance = event.shiftKey ? 5 : 2;
        onReposition(room.id, room.x + (event.key === "ArrowRight" ? distance : event.key === "ArrowLeft" ? -distance : 0), room.y + (event.key === "ArrowDown" ? distance : event.key === "ArrowUp" ? -distance : 0));
      }
      return;
    }

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const nextRoom = navigationRooms
        .filter((candidate) => candidate.id !== room.id && ((horizontal ? candidate.x - room.x : candidate.y - room.y) * direction > 0))
        .sort((left, right) => {
          const leftPrimary = Math.abs((horizontal ? left.x : left.y) - (horizontal ? room.x : room.y));
          const rightPrimary = Math.abs((horizontal ? right.x : right.y) - (horizontal ? room.x : room.y));
          const leftCross = Math.abs((horizontal ? left.y : left.x) - (horizontal ? room.y : room.x));
          const rightCross = Math.abs((horizontal ? right.y : right.x) - (horizontal ? room.y : room.x));
          return leftPrimary + leftCross * 0.5 - (rightPrimary + rightCross * 0.5);
        })[0];
      if (nextRoom === undefined) return;
      event.preventDefault();
      onSelect(nextRoom.id);
      requestAnimationFrame(() => document.getElementById(`room-${nextRoom.id}`)?.focus());
    }

    if (event.key === "Enter" && selected) {
      onEnter(room.id);
    }
  }

  return (
    <button
      ref={roomRef}
      id={`room-${room.id}`}
      aria-pressed={selected}
      aria-label={`${room.name}. ${room.description} ${roomMoveSignalLabel(room)}.`}
      className={`landmark landmark--${room.position} landmark--${room.accent} ${selected ? "is-selected" : ""}`}
      style={{ left: `${room.x}%`, top: `${room.y}%` }}
      onClick={() => onSelect(room.id)}
      onDoubleClick={() => onEnter(room.id)}
      onPointerDown={(event) => {
        if (locked) return;
        const target = event.currentTarget;
        const canvas = target.closest<HTMLElement>(".world-map");
        if (!canvas) return;
        target.setPointerCapture(event.pointerId);
        let finalPosition = { x: room.x, y: room.y };
        const move = (pointerEvent: PointerEvent) => {
          const bounds = canvas.getBoundingClientRect();
          finalPosition = { x: ((pointerEvent.clientX - bounds.left) / bounds.width) * 100, y: ((pointerEvent.clientY - bounds.top) / bounds.height) * 100 };
        };
        const release = () => {
          void onReposition(room.id, finalPosition.x, finalPosition.y);
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", release);
          target.removeEventListener("pointercancel", release);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", release);
        target.addEventListener("pointercancel", release);
      }}
      onKeyDown={handleKeyDown}
      type="button"
    >
      <span className="landmark__structure" aria-hidden="true">
        <Icon name={room.icon} />
      </span>
      <span className="landmark__copy">
        <strong>{room.name}</strong>
        <small>{moveSignalText(room.moveSignal)}</small>
      </span>
    </button>
  );
}

function CallsignBadge({ callsign }: Readonly<{ callsign: string }>) {
  const initial = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(callsign)][0]?.segment ?? callsign;
  return (
    <span className="person-token" role="img" title={`Your callsign: ${callsign}`} aria-label={`Your callsign: ${callsign}`}>
      {initial.toLocaleUpperCase()}
    </span>
  );
}

type WorkshopMove = {
  _id: Id<"moves">;
  roomId?: Id<"rooms">;
  title: string;
  intent: string;
  state: string;
  currentVersion: number;
  updatedAt: number;
};

type WorkshopCall = {
  _id: Id<"calls">;
  roomId?: Id<"rooms">;
  title: string;
  detail: string;
  status: string;
  joinedCount: number;
  maxParticipants: number;
  currentVersion: number;
  updatedAt: number;
};

type WorkshopFracture = {
  _id: Id<"fractures">;
  roomId: Id<"rooms">;
  linkedMoveId?: Id<"moves">;
  title: string;
  detail: string;
  severity: string;
  status: string;
  currentVersion: number;
  updatedAt: number;
};

type WorkshopContext =
  | { key: string; kind: "Move"; moveId: Id<"moves">; title: string; detail: string; state: string; version: number; updatedAt: number }
  | { key: string; kind: "Call"; callId: Id<"calls">; title: string; detail: string; state: string; joinedCount: number; maxParticipants: number; version: number; updatedAt: number }
  | { key: string; kind: "Fracture"; fractureId: Id<"fractures">; title: string; detail: string; state: string; severity: string; linkedMoveTitle: string | null; version: number; updatedAt: number };

function Workshop({
  mission,
  roomId,
  roomTitle,
  moves,
  calls,
  fractures,
  onCreateFirstMove,
  onAskForHelp,
  onReportFracture,
  onSubmitProof,
  onOpenCall,
  onOpenFracture,
  initialSelectedContextKey,
  onExit,
}: Readonly<{
  mission: { _id: Id<"missions">; role: string; lifecycle?: string };
  roomId: Id<"rooms">;
  roomTitle: string;
  moves: WorkshopMove[] | undefined;
  calls: WorkshopCall[] | undefined;
  fractures: WorkshopFracture[] | undefined;
  onCreateFirstMove: () => void;
  onAskForHelp: (moveId: Id<"moves">) => void;
  onReportFracture: (moveId: Id<"moves">) => void;
  onSubmitProof: (moveId: Id<"moves">) => void;
  onOpenCall: (callId: Id<"calls">) => void;
  onOpenFracture: (fractureId: Id<"fractures">) => void;
  initialSelectedContextKey: string | null;
  onExit: () => void;
}>) {
  const [selectedContextKey, setSelectedContextKey] = useState<string | null>(initialSelectedContextKey);
  const loading = moves === undefined || calls === undefined || fractures === undefined;
  const availableContext: WorkshopContext[] = [
    ...(moves ?? []).filter((move) => move.roomId === roomId).map((move) => ({
      key: `move:${move._id}`,
      kind: "Move" as const,
      moveId: move._id,
      title: move.title,
      detail: move.intent,
      state: move.state,
      version: move.currentVersion,
      updatedAt: move.updatedAt,
    })),
    ...(calls ?? []).filter((call) => call.roomId === roomId).map((call) => ({
      key: `call:${call._id}`,
      kind: "Call" as const,
      callId: call._id,
      title: call.title,
      detail: call.detail,
      state: call.status,
      joinedCount: call.joinedCount,
      maxParticipants: call.maxParticipants,
      version: call.currentVersion,
      updatedAt: call.updatedAt,
    })),
    ...(fractures ?? []).filter((fracture) => fracture.roomId === roomId).map((fracture) => ({
      key: `fracture:${fracture._id}`,
      kind: "Fracture" as const,
      fractureId: fracture._id,
      title: fracture.title,
      detail: fracture.detail,
      state: fracture.status,
      severity: fracture.severity,
      linkedMoveTitle: moves?.find((move) => move._id === fracture.linkedMoveId && move.roomId === fracture.roomId)?.title ?? null,
      version: fracture.currentVersion,
      updatedAt: fracture.updatedAt,
    })),
  ].sort((left, right) => right.updatedAt - left.updatedAt);
  const selectedContext = availableContext.find((context) => context.key === selectedContextKey) ?? null;
  const selectedUpdatedAt = selectedContext === null
    ? null
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(selectedContext.updatedAt);
  const isArchived = mission.lifecycle === "archived";
  const canCreateFirstMove = mission.lifecycle === "active" && ["owner", "steward", "builder"].includes(mission.role);
  const canAskForHelp = mission.lifecycle === "active" && ["owner", "steward", "builder", "contributor"].includes(mission.role);
  const canReportFracture = mission.lifecycle === "active" && ["owner", "steward", "builder", "contributor"].includes(mission.role);
  const canSubmitProof = mission.lifecycle === "active" && ["owner", "steward", "builder", "contributor"].includes(mission.role);

  return (
    <div className="workshop-view" aria-labelledby="workshop-heading">
      <header className="room-topbar">
        <button className="text-button" onClick={onExit} type="button">
          <Icon name="arrow-left" /> Mission World
        </button>
        <span className="room-topbar__slash" aria-hidden="true">/</span>
        <strong>{roomTitle}</strong>
      </header>
      <div className="workshop-layout">
        <aside className="workshop-rail" aria-label="Workshop context">
          <p className="eyebrow">Room context</p>
          <h1 id="workshop-heading">Durable work in {roomTitle}.</h1>
          <p>Moves, Calls, and Fractures below are scoped to this room. They are not live presence or a Mission-wide feed.</p>
          {isArchived ? <p aria-label="Archived room read-only" role="status">Archived Mission — read-only durable room context.</p> : null}
          <section className="workshop-context-list" aria-labelledby="available-durable-work-heading">
            <h2 id="available-durable-work-heading">Available durable work</h2>
            {loading ? <p aria-live="polite">Loading room-scoped durable work…</p> : availableContext.length === 0 ? <><p>No durable Moves, Calls, or Fractures are scoped to this room yet.</p>{canCreateFirstMove ? <button className="primary-button" onClick={onCreateFirstMove} type="button">Create first Move</button> : null}</> : (
              <ul aria-label="Available durable work">
                {availableContext.map((context) => (
                  <li key={context.key}>
                    <button aria-pressed={selectedContext?.key === context.key} onClick={() => setSelectedContextKey(context.key)} type="button">
                      <span className="workshop-context-list__kind">{context.kind}</span>
                      <strong>{context.title}</strong>
                      <small>{context.state}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
        <main className="artifact-canvas" id="main-content" tabIndex={-1}>
          <div className="artifact-toolbar" aria-label="Durable room context"><span className="artifact-kind">Read-only room context</span></div>
          <article className="artifact-paper" aria-label={selectedContext === null ? "Durable room context" : "Selected durable context"}>
            {selectedContext === null ? <>
              <p className="eyebrow">Room context</p>
              <h2>Select a Move, Call, or Fracture.</h2>
              <p>Choose an item from Available durable work to inspect its accountable state. Pulse remains separate Mission history.</p>
            </> : <>
              <p className="eyebrow">{selectedContext.kind}</p>
              <h2>{selectedContext.title}</h2>
              <p>{selectedContext.detail}</p>
              <dl className="workshop-context-facts">
                <div><dt>State</dt><dd>{selectedContext.state}</dd></div>
                {selectedContext.kind === "Call" ? <div><dt>Joined participants</dt><dd>{selectedContext.joinedCount} / {selectedContext.maxParticipants}</dd></div> : null}
                {selectedContext.kind === "Fracture" ? <><div><dt>Severity</dt><dd>{selectedContext.severity}</dd></div><div><dt>Linked Move</dt><dd>{selectedContext.linkedMoveTitle ?? "None"}</dd></div></> : null}
                <div><dt>Version</dt><dd>{selectedContext.version}</dd></div>
                <div><dt>Updated</dt><dd>{selectedUpdatedAt}</dd></div>
              </dl>
              {selectedContext.kind === "Move" && canAskForHelp ? <button className="secondary-button" onClick={() => onAskForHelp(selectedContext.moveId)} type="button">Ask for help</button> : null}
              {selectedContext.kind === "Move" && canReportFracture ? <button className="secondary-button" onClick={() => onReportFracture(selectedContext.moveId)} type="button">Report a Fracture</button> : null}
              {selectedContext.kind === "Move" && canSubmitProof ? <button className="secondary-button" onClick={() => onSubmitProof(selectedContext.moveId)} type="button">Submit Proof</button> : null}
              {selectedContext.kind === "Call" ? <button className="secondary-button" onClick={() => onOpenCall(selectedContext.callId)} type="button">Open Call</button> : null}
              {selectedContext.kind === "Fracture" ? <button className="secondary-button" onClick={() => onOpenFracture(selectedContext.fractureId)} type="button">Open Fracture</button> : null}
            </>}
          </article>
        </main>
        <aside className="workshop-inspector" aria-label="Durable context guide">
          <p className="eyebrow">Read-only context</p>
          <h2>Inspect, then act in the Mission World.</h2>
          <p>Workshop does not create or change work. Use the Mission World controls to make a durable Move, Call, or Fracture.</p>
          <p>Joined participant counts are durable participation records, not live presence.</p>
        </aside>
      </div>
      {mission.role === "observer" ? null : <PulseSurface mission={mission} />}
    </div>
  );
}

function PreferencePanel({
  preferences,
  onChange,
  onClose,
}: Readonly<{
  preferences: Preferences;
  onChange: (next: Preferences) => void;
  onClose: () => void;
}>) {
  return (
    <section className="preference-panel" aria-labelledby="preferences-title" role="dialog" aria-modal="false">
      <div className="preference-panel__header"><div><p className="eyebrow">Your view</p><h2 id="preferences-title">World preferences</h2></div><button className="icon-button" aria-label="Close preferences" onClick={onClose} type="button"><Icon name="close" /></button></div>
      <p className="preference-panel__intro">These choices stay on this device. They change presentation, never Mission truth.</p>
      <fieldset>
        <legend>Density</legend>
        <div className="choice-row">
          {(["focus", "standard", "compact"] as const).map((density) => <button aria-pressed={preferences.density === density} key={density} onClick={() => onChange({ ...preferences, density })} type="button">{density}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>World accent</legend>
        <div className="choice-row choice-row--swatches">
          {(["blue", "teal", "violet"] as const).map((accent) => <button aria-label={`${accent} accent`} aria-pressed={preferences.accent === accent} className={`accent-swatch accent-swatch--${accent}`} key={accent} onClick={() => onChange({ ...preferences, accent })} type="button"><span />{accent}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>Starting view</legend>
        <div className="choice-row">
          {(["map", "list"] as const).map((defaultView) => <button aria-pressed={preferences.defaultView === defaultView} key={defaultView} onClick={() => onChange({ ...preferences, defaultView })} type="button">{defaultView === "map" ? "Map" : "Room directory"}</button>)}
        </div>
      </fieldset>
      <label className="preference-toggle"><span><strong>Reduced decoration</strong><small>Quiet contours, routes, and shadows.</small></span><input checked={preferences.reducedDecoration} onChange={(event) => onChange({ ...preferences, reducedDecoration: event.target.checked })} type="checkbox" /></label>
      <CallsignSettings />
    </section>
  );
}

export type MissionWorldProps = Readonly<{
  developmentAblyClientFactory?: AblyClientFactory;
}>;

export function MissionWorld({ developmentAblyClientFactory }: MissionWorldProps = {}) {
  const templateOptions = [{ key: "companySprint", label: "Company sprint" }, { key: "classroomProject", label: "Classroom project" }, { key: "contentProduction", label: "Content production" }, { key: "openChallenge", label: "Open challenge" }, { key: "blankCanvas", label: "Blank canvas" }] as const;
  const missions = useQuery(api.missions.listMyMissions, {});
  const profile = useQuery(api.profiles.getMine, {});
  const [selectedMissionId, setSelectedMissionId] = useState<Id<"missions"> | null>(null);
  const [selectionReady, setSelectionReady] = useState(false);
  const activeMission = selectedMissionId === null ? undefined : missions?.find((mission) => mission._id === selectedMissionId);
  const isObserver = activeMission?.role === "observer";
  const canManageCanvas = activeMission?.lifecycle === "active" && ["owner", "steward", "builder"].includes(activeMission.role);
  const roomRecords = useQuery(api.canvas.roomLayouts, activeMission === undefined ? "skip" : { missionId: activeMission._id });
  const missionMoves = useQuery(api.moves.listMissionMoves, activeMission === undefined ? "skip" : { missionId: activeMission._id });
  const missionCalls = useQuery(api.calls.listMissionCalls, activeMission === undefined ? "skip" : { missionId: activeMission._id });
  const missionFractures = useQuery(api.fractures.listMissionFractures, activeMission === undefined || isObserver ? "skip" : { missionId: activeMission._id });
  const launch = useMutation(api.launch.createMissionFromTemplate);
  const createRoomMutation = useMutation(api.canvas.createRoom);
  const updateRoomLayout = useMutation(api.canvas.updateRoomLayout);
  const renameRoomMutation = useMutation(api.canvas.renameRoom);
  const archiveRoomMutation = useMutation(api.canvas.archiveRoom);
  const developmentRealtimeTransportFactory = useMemo(
    () => createDevelopmentAblyTransportFactory(
      developmentAblyClientFactory === undefined
        ? undefined
        : { environment: "development", clientFactory: developmentAblyClientFactory },
    ),
    [developmentAblyClientFactory],
  );
  const issueRealtimeTokenRequest = useAction(api.realtime.issueTokenRequest);
  const requestAuthenticatedRealtimeToken = useCallback(async ({ missionId, roomId }: { missionId: string; roomId: string }) => {
    const response = await issueRealtimeTokenRequest({
      missionId: missionId as Id<"missions">,
      roomId: roomId as Id<"rooms">,
    });
    return { ...response, missionId, roomId };
  }, [issueRealtimeTokenRequest]);
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<RoomId>("");
  const [view, setView] = useState<"world" | "workshop">("world");
  const [showDirectory, setShowDirectory] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [newMissionOpen, setNewMissionOpen] = useState(false);
  const [createMoveRequest, setCreateMoveRequest] = useState<{ roomId: Id<"rooms">; nonce: string } | null>(null);
  const [createCallRequest, setCreateCallRequest] = useState<{ roomId: Id<"rooms">; moveId: Id<"moves">; nonce: string } | null>(null);
  const [createFractureRequest, setCreateFractureRequest] = useState<{ roomId: Id<"rooms">; moveId: Id<"moves">; nonce: string } | null>(null);
  const [createProofRequest, setCreateProofRequest] = useState<{ roomId: Id<"rooms">; moveId: Id<"moves">; nonce: string } | null>(null);
  const [inspectCallRequest, setInspectCallRequest] = useState<{ callId: Id<"calls">; roomId: Id<"rooms">; nonce: string } | null>(null);
  const [inspectFractureRequest, setInspectFractureRequest] = useState<{ fractureId: Id<"fractures">; roomId: Id<"rooms">; nonce: string } | null>(null);
  const [workshopContextRequest, setWorkshopContextRequest] = useState<{ roomId: Id<"rooms">; key: string } | null>(null);
  const [loadedPreferencesMissionId, setLoadedPreferencesMissionId] = useState<Id<"missions"> | null>(null);
  const [canvas, setCanvas] = useState<CanvasState>(defaultCanvasState);
  const [newRoomName, setNewRoomName] = useState("");
  const [roomError, setRoomError] = useState<string | null>(null);
  const handleCreateMoveRequestHandled = useCallback(() => setCreateMoveRequest(null), [setCreateMoveRequest]);
  const handleCreateMoveRequestUnavailable = useCallback(() => setRoomError("That room is no longer available."), [setRoomError]);
  const handleCreateCallRequestHandled = useCallback(() => setCreateCallRequest(null), [setCreateCallRequest]);
  const handleCreateCallRequestUnavailable = useCallback(() => {
    setCreateCallRequest(null);
    setRoomError("That work is no longer available.");
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }, [setCreateCallRequest, setRoomError]);
  const handleCreateFractureRequestHandled = useCallback(() => setCreateFractureRequest(null), [setCreateFractureRequest]);
  const handleCreateFractureRequestUnavailable = useCallback(() => {
    setCreateFractureRequest(null);
    setRoomError("That work is no longer available.");
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }, [setCreateFractureRequest, setRoomError]);
  const handleCreateProofRequestHandled = useCallback(() => setCreateProofRequest(null), [setCreateProofRequest]);
  const handleCreateProofRequestUnavailable = useCallback(() => {
    setCreateProofRequest(null);
    setRoomError("That work is no longer available.");
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }, [setCreateProofRequest, setRoomError]);
  const handleInspectCallRequestHandled = useCallback(() => setInspectCallRequest(null), [setInspectCallRequest]);
  const handleInspectCallRequestUnavailable = useCallback(() => {
    setInspectCallRequest(null);
    setRoomError("That work is no longer available.");
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }, [setInspectCallRequest, setRoomError]);
  const handleInspectFractureRequestHandled = useCallback(() => setInspectFractureRequest(null), [setInspectFractureRequest]);
  const handleInspectFractureRequestUnavailable = useCallback(() => {
    setInspectFractureRequest(null);
    setRoomError("That work is no longer available.");
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }, [setInspectFractureRequest, setRoomError]);
  const canvasRooms = roomRecords?.map((room) => canvasRoom(room, roomMoveSignal(room._id, missionMoves))) ?? [];
  const selectedRoomRecord = canvasRooms.find((room) => room.id === selectedRoomId);
  const selectedRoom = selectedRoomRecord ?? canvasRooms[0];
  const latestSelectedRoomMove = missionMoves === undefined || selectedRoom === undefined
    ? undefined
    : missionMoves
      .filter((move) => move.roomId === selectedRoom.id)
      .reduce<(typeof missionMoves)[number] | undefined>((latest, move) => latest === undefined || move.updatedAt > latest.updatedAt || (move.updatedAt === latest.updatedAt && String(move._id).localeCompare(String(latest._id)) > 0) ? move : latest, undefined);
  const realtimeRoomReadiness = useQuery(
    api.missions.getRealtimeRoomReadiness,
    activeMission?.lifecycle === "active" && selectedRoom !== undefined
      ? { missionId: activeMission._id, roomId: selectedRoom.id as Id<"rooms"> }
      : "skip",
  );
  const selectedRoomHash = selectedRoom?.id;
  const visibleRooms = canvasRooms;

  useEffect(() => {
    if (!isObserver) return;
    const frame = window.requestAnimationFrame(() => {
      setCreateFractureRequest(null);
      setCreateProofRequest(null);
      setInspectFractureRequest(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isObserver]);

  useEffect(() => {
    if (missions === undefined || selectionReady) return;
    const frame = window.requestAnimationFrame(() => {
      const storedMissionId = window.localStorage.getItem(selectedMissionStorageKey) as Id<"missions"> | null;
      const accessibleStoredMissionId = storedMissionId !== null && missions.some((mission) => mission._id === storedMissionId)
        ? storedMissionId
        : null;
      setSelectedMissionId(accessibleStoredMissionId ?? missions[0]?._id ?? null);
      setSelectionReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [missions, selectionReady]);

  useEffect(() => {
    if (!selectionReady || missions === undefined || selectedMissionId !== null || missions.length === 0) return;
    const frame = window.requestAnimationFrame(() => setSelectedMissionId(missions[0]!._id));
    return () => window.cancelAnimationFrame(frame);
  }, [missions, selectedMissionId, selectionReady]);

  useEffect(() => {
    if (!selectionReady || selectedMissionId === null) return;
    window.localStorage.setItem(selectedMissionStorageKey, selectedMissionId);
  }, [selectedMissionId, selectionReady]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        if (activeMission === undefined) return;
        setPreferences(defaultPreferences);
        setCanvas(defaultCanvasState);
        setShowDirectory(false);
        const stored = window.localStorage.getItem(missionWorldStorageKey(activeMission._id));
        if (stored) {
        const candidate = JSON.parse(stored) as Partial<Preferences> & { version?: number; preferences?: Partial<Preferences>; canvas?: Partial<CanvasState> };
        const storedPreferences = candidate.preferences ?? candidate;
        const next: Preferences = {
          density: storedPreferences.density === "focus" || storedPreferences.density === "compact" ? storedPreferences.density : "standard",
          accent: storedPreferences.accent === "teal" || storedPreferences.accent === "violet" ? storedPreferences.accent : "blue",
          reducedDecoration: storedPreferences.reducedDecoration === true,
          defaultView: storedPreferences.defaultView === "list" ? "list" : "map",
        };
        setPreferences(next);
        setShowDirectory(next.defaultView === "list");
        if (candidate.canvas) setCanvas({ zoom: clamp(candidate.canvas.zoom ?? 1, 0.7, 1.35), panX: clamp(candidate.canvas.panX ?? 0, -18, 18), panY: clamp(candidate.canvas.panY ?? 0, -18, 18), locked: candidate.canvas.locked === true });
        }
      } catch {
        // An unavailable or malformed local preference must never block the Mission World.
      } finally {
        if (activeMission !== undefined) setLoadedPreferencesMissionId(activeMission._id);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeMission]);

  useEffect(() => {
    if (activeMission !== undefined && loadedPreferencesMissionId === activeMission._id) {
      window.localStorage.setItem(missionWorldStorageKey(activeMission._id), JSON.stringify({ version: 3, preferences, canvas }));
    }
  }, [activeMission, canvas, loadedPreferencesMissionId, preferences]);

  useEffect(() => {
    if (selectedRoomHash !== undefined) window.history.replaceState(null, "", view === "workshop" ? "#workshop" : `#${selectedRoomHash}`);
  }, [selectedRoomHash, view]);

  useEffect(() => {
    if (view !== "workshop" || roomRecords === undefined || selectedRoomRecord !== undefined) return;
    const frame = window.requestAnimationFrame(() => {
      setView("world");
      setRoomError("That room is no longer available.");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [roomRecords, selectedRoomRecord, view]);

  function enterRoom(roomId: RoomId) {
    setSelectedRoomId(roomId);
    if (canvasRooms.find((room) => room.id === roomId)?.position === "workshop") {
      setView("workshop");
      requestAnimationFrame(() => document.getElementById("main-content")?.focus());
    }
  }

  function createFirstMoveFromWorkshop() {
    if (selectedRoomRecord === undefined) return;
    setCreateMoveRequest({ roomId: selectedRoomRecord.id as Id<"rooms">, nonce: crypto.randomUUID() });
    setView("world");
  }

  function askForHelpFromWorkshop(moveId: Id<"moves">) {
    if (selectedRoomRecord === undefined) return;
    setCreateCallRequest({ roomId: selectedRoomRecord.id as Id<"rooms">, moveId, nonce: crypto.randomUUID() });
    setView("world");
  }

  function reportFractureFromWorkshop(moveId: Id<"moves">) {
    if (selectedRoomRecord === undefined) return;
    setCreateFractureRequest({ roomId: selectedRoomRecord.id as Id<"rooms">, moveId, nonce: crypto.randomUUID() });
    setView("world");
  }

  function submitProofFromWorkshop(moveId: Id<"moves">) {
    if (selectedRoomRecord === undefined) return;
    setCreateProofRequest({ roomId: selectedRoomRecord.id as Id<"rooms">, moveId, nonce: crypto.randomUUID() });
    setView("world");
  }

  function openCallFromWorkshop(callId: Id<"calls">) {
    if (selectedRoomRecord === undefined) return;
    setInspectCallRequest({ callId, roomId: selectedRoomRecord.id as Id<"rooms">, nonce: crypto.randomUUID() });
    setView("world");
  }

  function openFractureFromWorkshop(fractureId: Id<"fractures">) {
    if (selectedRoomRecord === undefined) return;
    setInspectFractureRequest({ fractureId, roomId: selectedRoomRecord.id as Id<"rooms">, nonce: crypto.randomUUID() });
    setView("world");
  }

  function inspectWorkshopContext(roomId: Id<"rooms">, key: string) {
    if (!canvasRooms.some((room) => room.id === roomId)) {
      setWorkshopContextRequest(null);
      setView("world");
      setRoomError("That room is no longer available.");
      requestAnimationFrame(() => document.getElementById("main-content")?.focus());
      return;
    }
    setWorkshopContextRequest({ roomId, key });
    setSelectedRoomId(roomId);
    setView("workshop");
    requestAnimationFrame(() => {
      setWorkshopContextRequest(null);
      document.getElementById("main-content")?.focus();
    });
  }

  function viewCreatedMoveInWorkshop({ roomId, moveId }: { roomId: Id<"rooms">; moveId: Id<"moves"> }) {
    inspectWorkshopContext(roomId, `move:${moveId}`);
  }

  function selectMission(missionId: Id<"missions">) {
    setSelectedMissionId(missionId);
    setSelectedRoomId("");
    setView("world");
    setCreateMoveRequest(null);
    setCreateCallRequest(null);
    setCreateFractureRequest(null);
    setCreateProofRequest(null);
    setInspectCallRequest(null);
    setInspectFractureRequest(null);
    setWorkshopContextRequest(null);
    setInvitePanelOpen(false);
    setRoomError(null);
  }

  async function launchMission(templateKey: (typeof templateOptions)[number]["key"], title: string) {
    if (launching !== null) return;
    setLaunching(templateKey);
    setLaunchError(null);
    try {
      const created = await launch({
        templateKey,
        slug: `${templateKey.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
        title,
        idempotencyKey: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
      });
      selectMission(created.missionId);
      setNewMissionOpen(false);
    } catch {
      setLaunchError("The Mission could not launch. Try again.");
    } finally {
      setLaunching(null);
    }
  }

  async function repositionRoom(roomId: RoomId, x: number, y: number) {
    if (!canManageCanvas) return;
    const room = canvasRooms.find((candidate) => candidate.id === roomId);
    if (!room?.layout || room.layoutVersion === undefined) return;
    setRoomError(null);
    try {
      await updateRoomLayout({ roomId: roomId as Id<"rooms">, expectedLayoutVersion: room.layoutVersion, layout: { ...room.layout, x: ((clamp(x, 5, 95) - 5) / 90) * 1200, y: ((clamp(y, 6, 92) - 6) / 86) * 800 }, idempotencyKey: crypto.randomUUID() });
    } catch {
      setRoomError("That room changed elsewhere. The live map has been refreshed.");
    }
  }

  async function createRoom() {
    if (!canManageCanvas) return;
    const name = newRoomName.trim();
    if (!name) return;
    if (activeMission === undefined) return;
    setRoomError(null);
    try {
      const created = await createRoomMutation({ missionId: activeMission._id, title: name, kind: "branchLab", layout: { x: 900, y: 500, width: 220, height: 140 }, idempotencyKey: crypto.randomUUID() });
      setSelectedRoomId(created.roomId);
      setNewRoomName("");
    } catch {
      setRoomError("The room could not be created. Check your Mission role and try again.");
    }
  }

  async function renameSelectedRoom(name: string) {
    const trimmed = name.trim();
    if (!trimmed || selectedRoom?.currentVersion === undefined || trimmed === selectedRoom.name) return;
    setRoomError(null);
    try {
      await renameRoomMutation({ roomId: selectedRoom.id as Id<"rooms">, expectedVersion: selectedRoom.currentVersion, title: trimmed, idempotencyKey: crypto.randomUUID() });
    } catch {
      setRoomError("That room changed elsewhere. The live map has been refreshed.");
    }
  }

  if (missions === undefined) {
    return <main id="main-content" className="foundation">Loading your Mission World…</main>;
  }

  if (profile === undefined) {
    return <main id="main-content" className="foundation" aria-live="polite">Loading your profile…</main>;
  }

  if (profile === null) {
    return <CallsignSetupGate purpose="Choose your callsign before you continue in the Mission World." />;
  }

  if (!selectionReady) {
    return <main id="main-content" className="foundation">Opening your selected Mission…</main>;
  }

  if (selectedMissionId !== null && activeMission === undefined) {
    return (
      <main id="main-content" className="foundation">
        <p className="wordmark">Realworld</p>
        <h1>This Mission is no longer available to you.</h1>
        <p>Your previous selection is preserved, but your access may have expired or been removed.</p>
        {missions.length > 0 ? <label className="mission-switcher mission-switcher--fallback">Choose another Mission<select aria-label="Choose another Mission" onChange={(event) => selectMission(event.target.value as Id<"missions">)} value=""><option disabled value="">Select a Mission</option>{missions.map((mission) => <option key={mission._id} value={mission._id}>{mission.title}{mission.lifecycle === "archived" ? " (archived)" : ""}</option>)}</select></label> : <p aria-live="polite">You do not currently have access to another Mission.</p>}
      </main>
    );
  }

  if (missions.length === 0) {
    return (
      <main id="main-content" className="foundation">
        <p className="wordmark">Realworld</p>
        <h1>Start a Mission with a real work shape.</h1>
        <p>Choose a room ecology for the work ahead.</p>
        {launchError === null ? null : <p aria-live="polite">{launchError}</p>}
        {templateOptions.map(({ key, label }) => (
          <button
            key={key}
            disabled={launching !== null}
            onClick={() => void launchMission(key, label)}
            type="button"
          >
            {launching === key ? "Launching…" : `Launch ${label}`}
          </button>
        ))}
      </main>
    );
  }

  if (roomRecords === undefined || activeMission === undefined) {
    return <main id="main-content" className="foundation">Loading your shared room map…</main>;
  }
  if (selectedRoom === undefined) {
    return <main id="main-content" className="foundation"><h1>This room is no longer available.</h1><p role="status">Your room access changed. Return to an available Mission room to continue.</p></main>;
  }
  const missionWritable = activeMission.lifecycle === "active";

  if (view === "workshop" && selectedRoomRecord !== undefined) {
    return <><AuthenticatedMissionRealtimeLifecycle authenticatedTokenRequester={requestAuthenticatedRealtimeToken} expectedMissionId={activeMission._id} expectedRoomId={selectedRoomRecord.id} membershipGrantVersion={activeMission.grantVersion} readiness={realtimeRoomReadiness} transportFactory={developmentRealtimeTransportFactory} /><Workshop calls={missionCalls} fractures={isObserver ? [] : missionFractures} initialSelectedContextKey={workshopContextRequest?.roomId === selectedRoomRecord.id ? workshopContextRequest.key : null} mission={activeMission} moves={missionMoves} onAskForHelp={askForHelpFromWorkshop} onCreateFirstMove={createFirstMoveFromWorkshop} onExit={() => setView("world")} onOpenCall={openCallFromWorkshop} onOpenFracture={openFractureFromWorkshop} onReportFracture={reportFractureFromWorkshop} onSubmitProof={submitProofFromWorkshop} roomId={selectedRoomRecord.id as Id<"rooms">} roomTitle={selectedRoomRecord.name} /></>;
  }

  return (
    <div className="mission-world" aria-label="Realworld Mission World" data-accent={preferences.accent} data-density={preferences.density} data-decoration={preferences.reducedDecoration ? "reduced" : "standard"}>
      <AuthenticatedMissionRealtimeLifecycle authenticatedTokenRequester={requestAuthenticatedRealtimeToken} expectedMissionId={activeMission._id} expectedRoomId={selectedRoom.id} membershipGrantVersion={activeMission.grantVersion} readiness={realtimeRoomReadiness} transportFactory={developmentRealtimeTransportFactory} />
      <header className="world-topbar">
        <a className="brand" href="#core" aria-label="Realworld Mission World"><Icon name="spark" /> <span>Realworld</span></a>
        <nav aria-label="Primary navigation">
          <a className="is-current" href="#world">Mission World</a>
          <a href="#missions">Missions</a>
          <a href="#surge">Surge</a>
        </nav>
        <label className="mission-switcher">
          <span>Mission</span>
          <select aria-label="Selected Mission" onChange={(event) => selectMission(event.target.value as Id<"missions">)} value={activeMission._id}>
            {missions.map((mission) => <option key={mission._id} value={mission._id}>{mission.title}{mission.lifecycle === "archived" ? " (archived)" : ""}</option>)}
          </select>
        </label>
        <button className="create-button" onClick={() => setNewMissionOpen(true)} type="button">
          <Icon name="plus" /> New Mission
        </button>
        {activeMission.role === "owner" && missionWritable ? (
          <button className="create-button" onClick={() => setInvitePanelOpen(true)} type="button">
            <Icon name="plus" /> Invite collaborators
          </button>
        ) : null}
        <MissionControls mission={activeMission} />
        <button className="icon-button" aria-label="Search" type="button"><Icon name="search" /></button>
        <button className="icon-button" aria-label="Notifications" type="button"><Icon name="bell" /></button>
        <button className="icon-button" aria-expanded={preferencesOpen} aria-label="Open world preferences" onClick={() => setPreferencesOpen(true)} type="button"><Icon name="settings" /></button>
        <CallsignBadge callsign={profile.displayName} />
        <SessionControl />
      </header>

      {preferencesOpen ? <PreferencePanel onChange={(next) => { setPreferences(next); if (next.defaultView !== preferences.defaultView) setShowDirectory(next.defaultView === "list"); }} onClose={() => setPreferencesOpen(false)} preferences={preferences} /> : null}
      {newMissionOpen ? (
        <div aria-labelledby="new-mission-title" aria-modal="true" className="preference-panel" role="dialog">
          <div className="preference-panel__header"><div><p className="eyebrow">New Mission</p><h2 id="new-mission-title">Choose a work shape</h2></div><button aria-label="Close new Mission" className="icon-button" disabled={launching !== null} onClick={() => setNewMissionOpen(false)} type="button"><Icon name="close" /></button></div>
          <p className="preference-panel__intro">Start another world without leaving the one you are in.</p>
          {launchError === null ? null : <p aria-live="polite">{launchError}</p>}
          <fieldset disabled={launching !== null}><legend>Templates</legend>{templateOptions.map(({ key, label }) => <button key={key} onClick={() => void launchMission(key, label)} type="button">{launching === key ? `Launching ${label}…` : `Launch ${label}`}</button>)}</fieldset>
        </div>
      ) : null}
      {invitePanelOpen ? (
        <div aria-label="Invite collaborators" aria-modal="true" className="preference-panel" role="dialog">
          <button aria-label="Close invitations" onClick={() => setInvitePanelOpen(false)} type="button">
            <Icon name="close" />
          </button>
          <OwnerInvitePanel missionId={activeMission._id} />
        </div>
      ) : null}

      <section className="mission-summary" aria-labelledby="mission-title">
        <p className="eyebrow">Mission</p>
        <h1 id="mission-title">{activeMission.title}</h1>
        <p>{missionWritable ? "Give humans and autonomous agents shared Missions, durable rooms, accountable Artifacts, and the tools to accomplish ambitious work together." : "This Mission is archived and read-only. Its owner can restore it from Manage Mission."}</p>
        <div className="mission-summary__facts"><span><i /> {missionWritable ? "Active" : "Archived"}</span><span>{activeMission.role}</span><span>Durable Mission</span><span>{missionWritable ? "Shared projection" : "Read-only projection"}</span></div>
        <ConstitutionControls mission={activeMission} />
        <MoveBoard
          createMoveRequest={createMoveRequest}
          key={activeMission._id}
          mission={activeMission}
          onCreateMoveRequestHandled={handleCreateMoveRequestHandled}
          onCreateMoveRequestUnavailable={handleCreateMoveRequestUnavailable}
          onViewCreatedMove={viewCreatedMoveInWorkshop}
          rooms={roomRecords.map((room) => ({ _id: room._id, title: room.title }))}
        />
      </section>

      <main className="world-stage" id="main-content" tabIndex={-1}>
        {missionWritable ? null : <p aria-label="Archived Mission read-only" role="status">Archived Mission — read-only. Restore it from Manage Mission to resume work.</p>}
        {roomError === null ? null : <p aria-live="polite">{roomError}</p>}
        <div className="stage-toolbar" aria-label="Mission World view controls">
          <button className={!showDirectory ? "is-active" : ""} onClick={() => setShowDirectory(false)} type="button">Map</button>
          <button className={showDirectory ? "is-active" : ""} onClick={() => setShowDirectory(true)} type="button">Room directory</button>
          <button aria-label="Zoom out" onClick={() => setCanvas((current) => ({ ...current, zoom: clamp(current.zoom - 0.1, 0.7, 1.35) }))} type="button">−</button>
          <button aria-label="Zoom in" onClick={() => setCanvas((current) => ({ ...current, zoom: clamp(current.zoom + 0.1, 0.7, 1.35) }))} type="button">+</button>
          <button onClick={() => setCanvas(defaultCanvasState)} type="button">Fit world</button>
          <button aria-pressed={canvas.locked} disabled={!canManageCanvas} onClick={() => setCanvas((current) => ({ ...current, locked: !current.locked }))} type="button">{canvas.locked ? "Layout locked" : "Layout unlocked"}</button>
          <span>Alt + arrows moves a focused Room</span>
        </div>
        {canManageCanvas ? <form className="room-create" onSubmit={(event) => { event.preventDefault(); void createRoom(); }}>
          <label htmlFor="new-room-name">New room</label><input id="new-room-name" onChange={(event) => setNewRoomName(event.target.value)} placeholder="e.g. Sound check" value={newRoomName} /><button type="submit">Create room</button>
        </form> : null}
        <div className="contours" aria-hidden="true" />
        {showDirectory ? (
          <section className="room-directory" aria-labelledby="directory-heading">
            <div><p className="eyebrow">Non-spatial alternative</p><h2 id="directory-heading">Mission rooms</h2><p>Every durable destination and safe action in reading order.</p></div>
            <ul>
              {visibleRooms.map((room) => (
                <li key={room.id} className={selectedRoom.id === room.id ? "is-selected" : ""}>
                  <button aria-label={`${room.description} ${roomMoveSignalLabel(room)}`} onClick={() => setSelectedRoomId(room.id)} type="button"><span className={`directory-icon directory-icon--${room.accent}`}><Icon name={room.icon} /></span><span><strong>{room.name}</strong><small>{room.description}</small><em>{moveSignalText(room.moveSignal)}</em></span></button>
                  <button className="directory-enter" disabled={!missionWritable && room.position !== "workshop"} onClick={() => enterRoom(room.id)} type="button">{room.action}</button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className={`world-map ${canvas.locked ? "is-locked" : ""}`} aria-label="Customizable spatial Mission canvas. Select a Room to inspect it; press Enter on the selected Room to enter it.">
            <div className="world-map__canvas" style={{ transform: `translate(${canvas.panX}%, ${canvas.panY}%) scale(${canvas.zoom})` }}>
              <svg className="world-routes" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {visibleRooms.filter((room) => room.id !== "core").map((room) => <path className={activeMission.lifecycle === "active" && room.moveSignal.hasNonterminalMove ? "world-routes__active" : undefined} d={`M ${visibleRooms.find((candidate) => candidate.id === "core")?.x ?? 50} ${visibleRooms.find((candidate) => candidate.id === "core")?.y ?? 46} L ${room.x} ${room.y}`} key={room.id} />)}
              </svg>
              {visibleRooms.map((room) => <RoomLandmark key={room.id} locked={canvas.locked || !canManageCanvas} navigationRooms={visibleRooms} onReposition={repositionRoom} room={room} selected={selectedRoom.id === room.id} onSelect={setSelectedRoomId} onEnter={enterRoom} />)}
              <CallSurface
                createCallRequest={createCallRequest}
                inspectCallRequest={inspectCallRequest}
                key={activeMission._id}
                mission={activeMission}
                onCreateCallRequestHandled={handleCreateCallRequestHandled}
                onCreateCallRequestUnavailable={handleCreateCallRequestUnavailable}
                onInspectCallRequestHandled={handleInspectCallRequestHandled}
                onInspectCallRequestUnavailable={handleInspectCallRequestUnavailable}
                moves={(missionMoves ?? []).map((move) => ({ _id: move._id, title: move.title, roomId: move.roomId }))}
                rooms={canvasRooms.map((room) => ({ _id: room.id as Id<"rooms">, title: room.name, x: room.x, y: room.y }))}
              />
              {isObserver ? null : <FractureSurface
                createFractureRequest={createFractureRequest}
                inspectFractureRequest={inspectFractureRequest}
                key={`fractures-${activeMission._id}`}
                mission={activeMission}
                moves={(missionMoves ?? []).map((move) => ({ _id: move._id, title: move.title, roomId: move.roomId }))}
                onCreateFractureRequestHandled={handleCreateFractureRequestHandled}
                onCreateFractureRequestUnavailable={handleCreateFractureRequestUnavailable}
                onInspectFractureRequestHandled={handleInspectFractureRequestHandled}
                onInspectFractureRequestUnavailable={handleInspectFractureRequestUnavailable}
                rooms={canvasRooms.map((room) => ({ _id: room.id as Id<"rooms">, title: room.name, x: room.x, y: room.y }))}
              />}
              {isObserver ? null : <ProofSurface
                createProofRequest={createProofRequest}
                key={`proofs-${activeMission._id}`}
                mission={activeMission}
                moves={(missionMoves ?? []).map((move) => ({ _id: move._id, title: move.title, roomId: move.roomId }))}
                onCreateProofRequestHandled={handleCreateProofRequestHandled}
                onCreateProofRequestUnavailable={handleCreateProofRequestUnavailable}
                rooms={canvasRooms.map((room) => ({ _id: room.id as Id<"rooms">, title: room.name, x: room.x, y: room.y }))}
              />}
            </div>
          </div>
        )}
        <aside className="world-inspector" aria-live="polite" aria-labelledby="inspector-title">
          <button className="inspector-close" aria-label="Clear room selection" onClick={() => setSelectedRoomId("core")} type="button"><Icon name="close" /></button>
          <p className="eyebrow">{selectedRoom.eyebrow}</p>
          <h2 id="inspector-title">{selectedRoom.name}</h2>
          <p>{selectedRoom.description}</p>
          <div className="inspector-status"><span>Presence not connected</span><span aria-label={roomMoveSignalLabel(selectedRoom)}>{moveSignalText(selectedRoom.moveSignal)}</span></div>
          <section className="latest-durable-move" aria-labelledby="latest-durable-move-heading">
            <h3 id="latest-durable-move-heading">Latest durable Move</h3>
            {missionMoves === undefined ? <p aria-live="polite">Loading durable Moves…</p> : latestSelectedRoomMove === undefined ? <p>No durable Moves in this room.</p> : <>
              <p><strong>{latestSelectedRoomMove.title}</strong><span>{moveStateLabel(latestSelectedRoomMove.state)}</span></p>
              <button className="secondary-button" onClick={() => inspectWorkshopContext(selectedRoom.id as Id<"rooms">, `move:${latestSelectedRoomMove._id}`)} type="button">Inspect in Workshop</button>
            </>}
          </section>
          <section><h3>Room activity</h3><p>Live occupants are not represented until a realtime presence provider is connected.</p></section>
          <section><h3>Artifacts</h3><p>No durable Artifacts are linked to this room yet.</p></section>
          {missionWritable && (activeMission.role === "owner" || activeMission.role === "steward" || activeMission.role === "builder") ? <section className="custom-room-tools"><h3>Room controls</h3><label htmlFor="rename-room">Room name</label><input defaultValue={selectedRoom.name} id="rename-room" key={`${selectedRoom.id}-${selectedRoom.currentVersion}`} onBlur={(event) => void renameSelectedRoom(event.target.value)} /><button className="archive-room" onClick={() => {
            if (selectedRoom.currentVersion === undefined) return;
            setRoomError(null);
            void archiveRoomMutation({ roomId: selectedRoom.id as Id<"rooms">, expectedVersion: selectedRoom.currentVersion, idempotencyKey: crypto.randomUUID() }).then(() => setSelectedRoomId("")).catch(() => setRoomError("That room changed elsewhere. The live map has been refreshed."));
          }} type="button">Archive room</button></section> : null}
          <button className="primary-button" disabled={!missionWritable && selectedRoom.position !== "workshop"} onClick={() => enterRoom(selectedRoom.id)} type="button">{selectedRoom.action}</button>
        </aside>
      </main>
      {isObserver ? null : <PulseSurface mission={activeMission} />}
    </div>
  );
}
