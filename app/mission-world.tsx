"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { SessionControl } from "@/app/auth/session-control";
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

const missionWorldStorageKey = "realworld:mission-world-state:v2";
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

function isStoredRoom(value: unknown): value is Room {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Room>;
  return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.x === "number" && typeof candidate.y === "number";
}

const people = ["Priya", "Marco", "Lina", "Aisha", "SonicAgent", "Ira", "Noah", "Tess"];
const directionalRoomIds: Record<RoomId, Partial<Record<string, RoomId>>> = {
  core: { ArrowUp: "workshop", ArrowLeft: "observatory", ArrowRight: "branch", ArrowDown: "surge" },
  workshop: { ArrowDown: "core", ArrowLeft: "observatory", ArrowRight: "branch" },
  observatory: { ArrowRight: "core", ArrowDown: "library" },
  branch: { ArrowLeft: "core", ArrowDown: "surge" },
  library: { ArrowUp: "observatory", ArrowRight: "surge" },
  surge: { ArrowUp: "core", ArrowLeft: "library", ArrowRight: "branch" },
};

function RoomLandmark({
  room,
  selected,
  onSelect,
  onEnter,
  onReposition,
  locked,
}: Readonly<{
  room: Room;
  selected: boolean;
  onSelect: (id: RoomId) => void;
  onEnter: (id: RoomId) => void;
  onReposition: (id: RoomId, x: number, y: number) => void;
  locked: boolean;
}>) {
  const roomRef = useRef<HTMLButtonElement>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const nextRoom = directionalRoomIds[room.id]?.[event.key];
    if (nextRoom) {
      event.preventDefault();
      onSelect(nextRoom);
      requestAnimationFrame(() => document.getElementById(`room-${nextRoom}`)?.focus());
    }

    if (event.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      if (!locked) {
        const distance = event.shiftKey ? 5 : 2;
        onReposition(room.id, room.x + (event.key === "ArrowRight" ? distance : event.key === "ArrowLeft" ? -distance : 0), room.y + (event.key === "ArrowDown" ? distance : event.key === "ArrowUp" ? -distance : 0));
      }
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
        const move = (pointerEvent: PointerEvent) => {
          const bounds = canvas.getBoundingClientRect();
          onReposition(room.id, ((pointerEvent.clientX - bounds.left) / bounds.width) * 100, ((pointerEvent.clientY - bounds.top) / bounds.height) * 100);
        };
        const release = () => {
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
  const launch = useMutation(api.launch.createMissionFromTemplate);
  const [launching, setLaunching] = useState<string | null>(null);
  if (missions === undefined) return <main id="main-content" className="foundation">Loading your Mission World…</main>;
  if (missions.length === 0) return <main id="main-content" className="foundation"><p className="wordmark">Realworld</p><h1>Start a Mission with a real work shape.</h1><p>Choose a room ecology for the work ahead.</p>{templateOptions.map(({ key, label }) => <button key={key} disabled={launching !== null} onClick={async () => { setLaunching(key); try { await launch({ templateKey: key, slug: `${key}-${crypto.randomUUID().slice(0, 8)}`, title: label, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() }); } finally { setLaunching(null); } }} type="button">{launching === key ? "Launching…" : `Launch ${label}`}</button>)}</main>;
  const activeMission = missions[0]!;
  const [selectedRoomId, setSelectedRoomId] = useState<RoomId>("workshop");
  const [view, setView] = useState<"world" | "workshop">("world");
  const [showDirectory, setShowDirectory] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [canvasRooms, setCanvasRooms] = useState<Room[]>(rooms);
  const [canvas, setCanvas] = useState<CanvasState>(defaultCanvasState);
  const [newRoomName, setNewRoomName] = useState("");
  const selectedRoom = canvasRooms.find((room) => room.id === selectedRoomId && !room.archived) ?? canvasRooms.find((room) => !room.archived) ?? rooms[0]!;
  const visibleRooms = canvasRooms.filter((room) => !room.archived);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const stored = window.localStorage.getItem(missionWorldStorageKey);
        if (stored) {
        const candidate = JSON.parse(stored) as Partial<Preferences> & { version?: number; preferences?: Partial<Preferences>; canvas?: Partial<CanvasState>; rooms?: unknown[] };
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
        if (Array.isArray(candidate.rooms) && candidate.rooms.length > 0 && candidate.rooms.every(isStoredRoom)) setCanvasRooms(candidate.rooms.map((room) => ({ ...room, x: clamp(room.x, 4, 96), y: clamp(room.y, 5, 94) })));
        }
      } catch {
        // An unavailable or malformed local preference must never block the Mission World.
      } finally {
        setPreferencesLoaded(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (preferencesLoaded) {
      window.localStorage.setItem(missionWorldStorageKey, JSON.stringify({ version: 2, preferences, canvas, rooms: canvasRooms }));
    }
  }, [canvas, canvasRooms, preferences, preferencesLoaded]);

  useEffect(() => {
    window.history.replaceState(null, "", view === "workshop" ? "#workshop" : `#${selectedRoom.id}`);
  }, [selectedRoom.id, view]);

  function enterRoom(roomId: RoomId) {
    setSelectedRoomId(roomId);
    if (roomId === "workshop") {
      setView("workshop");
      requestAnimationFrame(() => document.getElementById("main-content")?.focus());
    }
  }

  function repositionRoom(roomId: RoomId, x: number, y: number) {
    setCanvasRooms((current) => current.map((room) => room.id === roomId ? { ...room, x: clamp(x, 5, 95), y: clamp(y, 6, 92) } : room));
  }

  function createRoom() {
    const name = newRoomName.trim();
    if (!name) return;
    const id = `custom-${Date.now()}`;
    const room: Room = { id, name, eyebrow: "Custom room", description: "A room shaped for this Mission's next mode of work.", active: 0, agents: 0, accent: "blue", icon: "spark", activity: "Ready for its first Move.", action: "Open room", position: "custom", x: 63, y: 66, custom: true };
    setCanvasRooms((current) => [...current, room]);
    setSelectedRoomId(id);
    setNewRoomName("");
  }

  function renameSelectedRoom(name: string) {
    const trimmed = name.trim();
    if (trimmed) setCanvasRooms((current) => current.map((room) => room.id === selectedRoom.id ? { ...room, name: trimmed } : room));
  }

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
        <div className="momentum" aria-label="Mission Momentum: strong. One fracture. Surge opening in one minute and twenty-four seconds.">
          <span className="momentum__mark"><Icon name="spark" /></span><strong>Mission Momentum</strong><span className="momentum__bars" aria-hidden="true"><i /><i /><i /><i /><i /></span><b>Strong</b><span>Fractures <em>1</em></span><span>Surge opening <time>01:24</time></span>
        </div>
        <button className="create-button" type="button"><Icon name="plus" /> Create / Join Mission</button>
        <button className="icon-button" aria-label="Search" type="button"><Icon name="search" /></button>
        <button className="icon-button" aria-label="Notifications" type="button"><Icon name="bell" /></button>
        <button className="icon-button" aria-expanded={preferencesOpen} aria-label="Open world preferences" onClick={() => setPreferencesOpen(true)} type="button"><Icon name="settings" /></button>
        <PersonToken name="Priya" index={0} />
        <SessionControl />
      </header>

      {preferencesOpen ? <PreferencePanel onChange={(next) => { setPreferences(next); if (next.defaultView !== preferences.defaultView) setShowDirectory(next.defaultView === "list"); }} onClose={() => setPreferencesOpen(false)} preferences={preferences} /> : null}

      <section className="mission-summary" aria-labelledby="mission-title">
        <p className="eyebrow">Mission</p>
        <h1 id="mission-title">{activeMission.title}</h1>
        <p>Give humans and autonomous agents shared Missions, live rooms, durable Artifacts, and the tools to accomplish ambitious work together.</p>
        <div className="mission-summary__facts"><span><i /> Active</span><span>18 humans</span><span>7 agents</span><span>Updated 2m ago</span></div>
        <div className="summary-pulse"><strong>Pulse</strong><svg viewBox="0 0 220 34" aria-hidden="true"><path d="M1 21 C20 30 26 6 45 17 S70 26 88 11 S113 9 130 22 S155 25 169 14 S194 12 219 9" /></svg></div>
      </section>

      <main className="world-stage" id="main-content" tabIndex={-1}>
        <div className="stage-toolbar" aria-label="Mission World view controls">
          <button className={!showDirectory ? "is-active" : ""} onClick={() => setShowDirectory(false)} type="button">Map</button>
          <button className={showDirectory ? "is-active" : ""} onClick={() => setShowDirectory(true)} type="button">Room directory</button>
          <button aria-label="Zoom out" onClick={() => setCanvas((current) => ({ ...current, zoom: clamp(current.zoom - 0.1, 0.7, 1.35) }))} type="button">−</button>
          <button aria-label="Zoom in" onClick={() => setCanvas((current) => ({ ...current, zoom: clamp(current.zoom + 0.1, 0.7, 1.35) }))} type="button">+</button>
          <button onClick={() => setCanvas(defaultCanvasState)} type="button">Fit world</button>
          <button aria-pressed={canvas.locked} onClick={() => setCanvas((current) => ({ ...current, locked: !current.locked }))} type="button">{canvas.locked ? "Layout locked" : "Layout unlocked"}</button>
          <span>Alt + arrows moves a focused Room</span>
        </div>
        <form className="room-create" onSubmit={(event) => { event.preventDefault(); createRoom(); }}>
          <label htmlFor="new-room-name">New room</label><input id="new-room-name" onChange={(event) => setNewRoomName(event.target.value)} placeholder="e.g. Sound check" value={newRoomName} /><button type="submit">Create room</button>
        </form>
        <div className="contours" aria-hidden="true" />
        {showDirectory ? (
          <section className="room-directory" aria-labelledby="directory-heading">
            <div><p className="eyebrow">Non-spatial alternative</p><h2 id="directory-heading">Mission rooms</h2><p>Every destination, live state, and safe action in reading order.</p></div>
            <ul>
              {visibleRooms.map((room) => (
                <li key={room.id} className={selectedRoom.id === room.id ? "is-selected" : ""}>
                  <button onClick={() => setSelectedRoomId(room.id)} type="button"><span className={`directory-icon directory-icon--${room.accent}`}><Icon name={room.icon} /></span><span><strong>{room.name}</strong><small>{room.description}</small><em>{room.active} active · {room.agents} agents</em></span></button>
                  <button className="directory-enter" onClick={() => enterRoom(room.id)} type="button">{room.action}</button>
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
              {visibleRooms.map((room) => <RoomLandmark key={room.id} locked={canvas.locked} onReposition={repositionRoom} room={room} selected={selectedRoom.id === room.id} onSelect={setSelectedRoomId} onEnter={enterRoom} />)}
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
          {selectedRoom.custom ? <section className="custom-room-tools"><h3>Customize room</h3><label htmlFor="rename-room">Room name</label><input defaultValue={selectedRoom.name} id="rename-room" onBlur={(event) => renameSelectedRoom(event.target.value)} /><button className="archive-room" onClick={() => { setCanvasRooms((current) => current.map((room) => room.id === selectedRoom.id ? { ...room, archived: true } : room)); setSelectedRoomId("core"); }} type="button">Archive room</button></section> : null}
          <button className="primary-button" onClick={() => enterRoom(selectedRoom.id)} type="button">{selectedRoom.action}</button>
          <button className="secondary-button" type="button">Follow Priya</button>
        </aside>
      </main>
      <PulseRail />
    </div>
  );
}
