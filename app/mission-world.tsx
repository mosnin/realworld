"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SessionControl } from "@/app/auth/session-control";
import { OwnerInvitePanel } from "@/app/invitations/owner-invite-panel";
import { MissionControls } from "@/app/missions/mission-controls";
import { Icon, type IconName } from "@/app/ui/icons";

type RoomId = string;

type Room = {
  id: RoomId;
  name: string;
  eyebrow: string;
  description: string;
  active: number;
  agents: number;
  accent: string;
  icon: IconName;
  activity: string;
  action: string;
  position: string;
  x: number;
  y: number;
  custom?: boolean;
  archived?: boolean;
  layoutVersion?: number;
  currentVersion?: number;
  layout?: { x: number; y: number; width: number; height: number };
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

const rooms: Room[] = [
  {
    id: "core",
    name: "Mission Core",
    eyebrow: "Shared outcome",
    description: "Build Realworld into a production multiplayer work platform for humans and agents.",
    active: 5,
    agents: 2,
    accent: "blue",
    icon: "spark",
    activity: "Priya and SonicAgent are choosing the next Move.",
    action: "Open Mission brief",
    position: "core",
    x: 50,
    y: 46,
  },
  {
    id: "workshop",
    name: "Workshop",
    eyebrow: "Artifact in motion",
    description: "Shape the working artifact, hand off a Move, and prepare a Proof.",
    active: 4,
    agents: 1,
    accent: "azure",
    icon: "workshop",
    activity: "Priya is shaping the collaboration flow.",
    action: "Enter Workshop",
    position: "workshop",
    x: 74,
    y: 19,
  },
  {
    id: "observatory",
    name: "Research Observatory",
    eyebrow: "Evidence and questions",
    description: "Validate the assumptions behind the next release.",
    active: 3,
    agents: 1,
    accent: "teal",
    icon: "observatory",
    activity: "SonicAgent is validating latency evidence.",
    action: "Explore evidence",
    position: "observatory",
    x: 19,
    y: 47,
  },
  {
    id: "branch",
    name: "Branch Lab",
    eyebrow: "Parallel workstreams",
    description: "Compare two approaches before a durable merge.",
    active: 5,
    agents: 2,
    accent: "coral",
    icon: "branch",
    activity: "Marco needs a decision on the sync branch.",
    action: "Compare branches",
    position: "branch",
    x: 84,
    y: 50,
  },
  {
    id: "library",
    name: "Artifact Library",
    eyebrow: "Reusable outputs",
    description: "Keep the useful things this Mission has already learned.",
    active: 3,
    agents: 1,
    accent: "amber",
    icon: "library",
    activity: "A new interaction spec was added to the library.",
    action: "Browse artifacts",
    position: "library",
    x: 18,
    y: 82,
  },
  {
    id: "surge",
    name: "Surge Hall",
    eyebrow: "Focused together",
    description: "A voluntary, time-boxed push with a clear shared outcome.",
    active: 12,
    agents: 3,
    accent: "violet",
    icon: "surge",
    activity: "Surge opens in 01:24 with 12 people ready.",
    action: "Join Surge",
    position: "surge",
    x: 61,
    y: 84,
  },
];

type CanvasState = { zoom: number; panX: number; panY: number; locked: boolean };
const defaultCanvasState: CanvasState = { zoom: 1, panX: 0, panY: 0, locked: false };

function clamp(value: number, lower: number, upper: number) {
  return Math.min(upper, Math.max(lower, value));
}

function canvasRoom(record: { _id: Id<"rooms">; title: string; kind: string; layout: { x: number; y: number; width: number; height: number }; layoutVersion: number; currentVersion: number }): Room {
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
    ...(isCustom ? { active: 0, agents: 0, accent: "blue" as const, icon: "spark" as const, position: "custom" as const, description: "A room shaped for this Mission's next mode of work.", eyebrow: "Custom room", activity: "Ready for its first Move.", action: "Open room", custom: true } : {}),
  };
}

const people = ["Priya", "Marco", "Lina", "Aisha", "SonicAgent", "Ira", "Noah", "Tess"];

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
      aria-label={`${room.name}. ${room.active} active people, ${room.agents} agents. ${room.description}`}
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
        <small>{room.eyebrow}</small>
        <span className="landmark__presence">
          <i aria-hidden="true" /> {room.active} active <b aria-hidden="true">·</b> {room.agents} agent{room.agents === 1 ? "" : "s"}
        </span>
      </span>
    </button>
  );
}

function PersonToken({ name, index }: Readonly<{ name: string; index: number }>) {
  const isAgent = name.endsWith("Agent");
  return (
    <span className={`person-token ${isAgent ? "person-token--agent" : ""}`} title={name} aria-label={name}>
      {isAgent ? <Icon name="agent" /> : name.slice(0, 1)}
      <i className={`person-token__dot person-token__dot--${index % 3}`} aria-hidden="true" />
    </span>
  );
}

function Workshop({ onExit }: Readonly<{ onExit: () => void }>) {
  return (
    <div className="workshop-view" aria-labelledby="workshop-heading">
      <header className="room-topbar">
        <button className="text-button" onClick={onExit} type="button">
          <Icon name="arrow-left" /> Mission World
        </button>
        <span className="room-topbar__slash" aria-hidden="true">/</span>
        <strong>Workshop</strong>
        <span className="room-topbar__status"><i /> 4 active · 1 agent</span>
      </header>
      <div className="workshop-layout">
        <aside className="workshop-rail" aria-label="Workshop context">
          <p className="eyebrow">Current Move</p>
          <h1 id="workshop-heading">Make room entry feel instantly useful.</h1>
          <p>Turn the first room into a place where a team can produce a durable Artifact.</p>
          <div className="rail-people">
            <strong>In this room</strong>
            <span>{people.slice(0, 5).map((person, index) => <PersonToken key={person} name={person} index={index} />)}</span>
          </div>
          <ol className="room-feed">
            <li><b>Priya</b> made an interaction proposal</li>
            <li><b>SonicAgent</b> is checking room states</li>
            <li><b>Marco</b> asked for a review</li>
          </ol>
        </aside>
        <main className="artifact-canvas" id="main-content" tabIndex={-1}>
          <div className="artifact-toolbar" aria-label="Artifact tools">
            <span className="artifact-kind">Interaction brief</span>
            <button type="button">Share</button>
            <button type="button">Versions</button>
          </div>
          <article className="artifact-paper" aria-label="Room entry interaction brief">
            <p className="eyebrow">Draft · 3 contributors</p>
            <h2>A room should answer one useful question immediately.</h2>
            <p>
              The Workshop opens to the active Artifact, the current Move, and the people or agents
              who can help. Presence is room-scale by default. Saving stays explicit and attributable.
            </p>
            <blockquote>“Priya is shaping the collaboration flow.”</blockquote>
            <p>
              Next: make the entry action visible from both the map and the accessible room directory.
            </p>
          </article>
        </main>
        <aside className="workshop-inspector" aria-label="Selected Move">
          <p className="eyebrow">Selected Move</p>
          <h2>Review the room transition</h2>
          <p>Evidence: experience specification, map interaction model, keyboard path.</p>
          <div className="agent-status"><span aria-hidden="true"><Icon name="agent" /></span><div><strong>SonicAgent</strong><small>Waiting for review</small></div></div>
          <button className="primary-button" type="button">Review changes</button>
          <button className="secondary-button" type="button">Prepare Proof</button>
        </aside>
      </div>
      <PulseRail />
    </div>
  );
}

function PulseRail() {
  return (
    <footer className="pulse-rail" aria-label="Live Mission pulse">
      <div><strong>Pulse</strong><span>Live now</span></div>
      <div className="pulse-rail__route" aria-hidden="true" />
      <div className="pulse-rail__people">
        {people.map((person, index) => <PersonToken key={person} name={person} index={index} />)}
      </div>
      <span className="pulse-rail__count">25 people in world</span>
    </footer>
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
    </section>
  );
}

export function MissionWorld() {
  const templateOptions = [{ key: "companySprint", label: "Company sprint" }, { key: "classroomProject", label: "Classroom project" }, { key: "contentProduction", label: "Content production" }, { key: "openChallenge", label: "Open challenge" }];
  const missions = useQuery(api.missions.listMyMissions, {});
  const [selectedMissionId, setSelectedMissionId] = useState<Id<"missions"> | null>(null);
  const [selectionReady, setSelectionReady] = useState(false);
  const activeMission = selectedMissionId === null ? undefined : missions?.find((mission) => mission._id === selectedMissionId);
  const roomRecords = useQuery(api.canvas.roomLayouts, activeMission === undefined ? "skip" : { missionId: activeMission._id });
  const launch = useMutation(api.launch.createMissionFromTemplate);
  const createRoomMutation = useMutation(api.canvas.createRoom);
  const updateRoomLayout = useMutation(api.canvas.updateRoomLayout);
  const renameRoomMutation = useMutation(api.canvas.renameRoom);
  const archiveRoomMutation = useMutation(api.canvas.archiveRoom);
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<RoomId>("");
  const [view, setView] = useState<"world" | "workshop">("world");
  const [showDirectory, setShowDirectory] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [newMissionOpen, setNewMissionOpen] = useState(false);
  const [loadedPreferencesMissionId, setLoadedPreferencesMissionId] = useState<Id<"missions"> | null>(null);
  const [canvas, setCanvas] = useState<CanvasState>(defaultCanvasState);
  const [newRoomName, setNewRoomName] = useState("");
  const [roomError, setRoomError] = useState<string | null>(null);
  const canvasRooms = roomRecords?.map(canvasRoom) ?? [];
  const selectedRoom = canvasRooms.find((room) => room.id === selectedRoomId) ?? canvasRooms[0];
  const selectedRoomHash = selectedRoom?.id;
  const visibleRooms = canvasRooms;

  useEffect(() => {
    if (missions === undefined || selectionReady) return;
    const frame = window.requestAnimationFrame(() => {
      const storedMissionId = window.localStorage.getItem(selectedMissionStorageKey) as Id<"missions"> | null;
      setSelectedMissionId(storedMissionId ?? missions[0]?._id ?? null);
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

  function enterRoom(roomId: RoomId) {
    setSelectedRoomId(roomId);
    if (canvasRooms.find((room) => room.id === roomId)?.position === "workshop") {
      setView("workshop");
      requestAnimationFrame(() => document.getElementById("main-content")?.focus());
    }
  }

  function selectMission(missionId: Id<"missions">) {
    setSelectedMissionId(missionId);
    setSelectedRoomId("");
    setView("world");
    setInvitePanelOpen(false);
    setRoomError(null);
  }

  async function launchMission(templateKey: string, title: string) {
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

  if (roomRecords === undefined || selectedRoom === undefined || activeMission === undefined) {
    return <main id="main-content" className="foundation">Loading your shared room map…</main>;
  }
  const missionWritable = activeMission.lifecycle === "active";

  if (view === "workshop") {
    return <Workshop onExit={() => setView("world")} />;
  }

  return (
    <div className="mission-world" aria-label="Realworld Mission World" data-accent={preferences.accent} data-density={preferences.density} data-decoration={preferences.reducedDecoration ? "reduced" : "standard"}>
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
        <div className="momentum" aria-label="Mission Momentum: strong. One fracture. Surge opening in one minute and twenty-four seconds.">
          <span className="momentum__mark"><Icon name="spark" /></span><strong>Mission Momentum</strong><span className="momentum__bars" aria-hidden="true"><i /><i /><i /><i /><i /></span><b>Strong</b><span>Fractures <em>1</em></span><span>Surge opening <time>01:24</time></span>
        </div>
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
        <PersonToken name="Priya" index={0} />
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
        <p>{missionWritable ? "Give humans and autonomous agents shared Missions, live rooms, durable Artifacts, and the tools to accomplish ambitious work together." : "This Mission is archived and read-only. Its owner can restore it from Manage Mission."}</p>
        <div className="mission-summary__facts"><span><i /> {missionWritable ? "Active" : "Archived"}</span><span>{activeMission.role}</span><span>Durable Mission</span><span>{missionWritable ? "Live projection" : "Read-only projection"}</span></div>
        <div className="summary-pulse"><strong>Pulse</strong><svg viewBox="0 0 220 34" aria-hidden="true"><path d="M1 21 C20 30 26 6 45 17 S70 26 88 11 S113 9 130 22 S155 25 169 14 S194 12 219 9" /></svg></div>
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
          <button aria-pressed={canvas.locked} disabled={!missionWritable} onClick={() => setCanvas((current) => ({ ...current, locked: !current.locked }))} type="button">{canvas.locked ? "Layout locked" : "Layout unlocked"}</button>
          <span>Alt + arrows moves a focused Room</span>
        </div>
        {missionWritable ? <form className="room-create" onSubmit={(event) => { event.preventDefault(); void createRoom(); }}>
          <label htmlFor="new-room-name">New room</label><input id="new-room-name" onChange={(event) => setNewRoomName(event.target.value)} placeholder="e.g. Sound check" value={newRoomName} /><button type="submit">Create room</button>
        </form> : null}
        <div className="contours" aria-hidden="true" />
        {showDirectory ? (
          <section className="room-directory" aria-labelledby="directory-heading">
            <div><p className="eyebrow">Non-spatial alternative</p><h2 id="directory-heading">Mission rooms</h2><p>Every destination, live state, and safe action in reading order.</p></div>
            <ul>
              {visibleRooms.map((room) => (
                <li key={room.id} className={selectedRoom.id === room.id ? "is-selected" : ""}>
                  <button onClick={() => setSelectedRoomId(room.id)} type="button"><span className={`directory-icon directory-icon--${room.accent}`}><Icon name={room.icon} /></span><span><strong>{room.name}</strong><small>{room.description}</small><em>{room.active} active · {room.agents} agents</em></span></button>
                  <button className="directory-enter" disabled={!missionWritable} onClick={() => enterRoom(room.id)} type="button">{room.action}</button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className={`world-map ${canvas.locked ? "is-locked" : ""}`} aria-label="Customizable spatial Mission canvas. Select a Room to inspect it; press Enter on the selected Room to enter it.">
            <div className="world-map__canvas" style={{ transform: `translate(${canvas.panX}%, ${canvas.panY}%) scale(${canvas.zoom})` }}>
              <svg className="world-routes" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {visibleRooms.filter((room) => room.id !== "core").map((room) => <path d={`M ${visibleRooms.find((candidate) => candidate.id === "core")?.x ?? 50} ${visibleRooms.find((candidate) => candidate.id === "core")?.y ?? 46} L ${room.x} ${room.y}`} key={room.id} />)}
                <path className="world-routes__active" d={`M ${visibleRooms.find((room) => room.id === "core")?.x ?? 50} ${visibleRooms.find((room) => room.id === "core")?.y ?? 46} L ${visibleRooms.find((room) => room.id === "workshop")?.x ?? 74} ${visibleRooms.find((room) => room.id === "workshop")?.y ?? 19}`} />
              </svg>
              {visibleRooms.map((room) => <RoomLandmark key={room.id} locked={canvas.locked || !missionWritable} navigationRooms={visibleRooms} onReposition={repositionRoom} room={room} selected={selectedRoom.id === room.id} onSelect={setSelectedRoomId} onEnter={missionWritable ? enterRoom : () => undefined} />)}
              <div className="map-event map-event--call"><span><Icon name="spark" /></span><strong>Open Call</strong><small>UI/UX critique</small><button type="button">Join Call</button></div>
              <div className="map-event map-event--fracture"><span><Icon name="branch" /></span><strong>Fracture</strong><small>Auth session restoration stalls</small><button type="button">Review</button></div>
              <div className="map-event map-event--proof"><span>✓</span><strong>Proof complete</strong><small>Mission authorization contract verified</small></div>
            </div>
          </div>
        )}
        <aside className="world-inspector" aria-live="polite" aria-labelledby="inspector-title">
          <button className="inspector-close" aria-label="Clear room selection" onClick={() => setSelectedRoomId("core")} type="button"><Icon name="close" /></button>
          <p className="eyebrow">{selectedRoom.eyebrow}</p>
          <h2 id="inspector-title">{selectedRoom.name}</h2>
          <p>{selectedRoom.description}</p>
          <div className="inspector-status"><span><i /> {selectedRoom.active} active</span><span><Icon name="agent" /> {selectedRoom.agents} agent{selectedRoom.agents === 1 ? "" : "s"}</span></div>
          <section><h3>In this room</h3><ul className="inspector-people"><li><PersonToken name="Priya" index={0} /> Priya <small>shaping flow</small></li><li><PersonToken name="SonicAgent" index={1} /> SonicAgent <small>running evals</small></li><li><PersonToken name="Marco" index={2} /> Marco <small>reviewing Proof</small></li></ul></section>
          <section><h3>Recent artifacts</h3><ul className="artifact-list"><li>mission-world.tsx <small>UI component</small></li><li>realtime-room-protocol.md <small>systems contract</small></li><li>mission-kernel-contract.md <small>architecture</small></li></ul></section>
          {missionWritable && (activeMission.role === "owner" || activeMission.role === "steward" || activeMission.role === "builder") ? <section className="custom-room-tools"><h3>Room controls</h3><label htmlFor="rename-room">Room name</label><input defaultValue={selectedRoom.name} id="rename-room" key={`${selectedRoom.id}-${selectedRoom.currentVersion}`} onBlur={(event) => void renameSelectedRoom(event.target.value)} /><button className="archive-room" onClick={() => {
            if (selectedRoom.currentVersion === undefined) return;
            setRoomError(null);
            void archiveRoomMutation({ roomId: selectedRoom.id as Id<"rooms">, expectedVersion: selectedRoom.currentVersion, idempotencyKey: crypto.randomUUID() }).then(() => setSelectedRoomId("")).catch(() => setRoomError("That room changed elsewhere. The live map has been refreshed."));
          }} type="button">Archive room</button></section> : null}
          <button className="primary-button" disabled={!missionWritable} onClick={() => enterRoom(selectedRoom.id)} type="button">{selectedRoom.action}</button>
          <button className="secondary-button" type="button">Follow Priya</button>
        </aside>
      </main>
      <PulseRail />
    </div>
  );
}
