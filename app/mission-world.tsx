"use client";

import { useEffect, useRef, useState } from "react";

import { SessionControl } from "@/app/auth/session-control";

type RoomId = "core" | "workshop" | "observatory" | "branch" | "library" | "surge";

type Room = {
  id: RoomId;
  name: string;
  eyebrow: string;
  description: string;
  active: number;
  agents: number;
  accent: string;
  landmark: string;
  activity: string;
  action: string;
  position: string;
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
    landmark: "✦",
    activity: "Priya and SonicAgent are choosing the next Move.",
    action: "Open Mission brief",
    position: "core",
  },
  {
    id: "workshop",
    name: "Workshop",
    eyebrow: "Artifact in motion",
    description: "Shape the working artifact, hand off a Move, and prepare a Proof.",
    active: 4,
    agents: 1,
    accent: "azure",
    landmark: "⌁",
    activity: "Priya is shaping the collaboration flow.",
    action: "Enter Workshop",
    position: "workshop",
  },
  {
    id: "observatory",
    name: "Research Observatory",
    eyebrow: "Evidence and questions",
    description: "Validate the assumptions behind the next release.",
    active: 3,
    agents: 1,
    accent: "teal",
    landmark: "◌",
    activity: "SonicAgent is validating latency evidence.",
    action: "Explore evidence",
    position: "observatory",
  },
  {
    id: "branch",
    name: "Branch Lab",
    eyebrow: "Parallel workstreams",
    description: "Compare two approaches before a durable merge.",
    active: 5,
    agents: 2,
    accent: "coral",
    landmark: "⌘",
    activity: "Marco needs a decision on the sync branch.",
    action: "Compare branches",
    position: "branch",
  },
  {
    id: "library",
    name: "Artifact Library",
    eyebrow: "Reusable outputs",
    description: "Keep the useful things this Mission has already learned.",
    active: 3,
    agents: 1,
    accent: "amber",
    landmark: "▣",
    activity: "A new interaction spec was added to the library.",
    action: "Browse artifacts",
    position: "library",
  },
  {
    id: "surge",
    name: "Surge Hall",
    eyebrow: "Focused together",
    description: "A voluntary, time-boxed push with a clear shared outcome.",
    active: 12,
    agents: 3,
    accent: "violet",
    landmark: "↗",
    activity: "Surge opens in 01:24 with 12 people ready.",
    action: "Join Surge",
    position: "surge",
  },
];

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
}: Readonly<{
  room: Room;
  selected: boolean;
  onSelect: (id: RoomId) => void;
  onEnter: (id: RoomId) => void;
}>) {
  const roomRef = useRef<HTMLButtonElement>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const nextRoom = directionalRoomIds[room.id][event.key];
    if (nextRoom) {
      event.preventDefault();
      onSelect(nextRoom);
      requestAnimationFrame(() => document.getElementById(`room-${nextRoom}`)?.focus());
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
      onClick={() => onSelect(room.id)}
      onDoubleClick={() => onEnter(room.id)}
      onKeyDown={handleKeyDown}
      type="button"
    >
      <span className="landmark__structure" aria-hidden="true">
        <span>{room.landmark}</span>
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
      {isAgent ? "◈" : name.slice(0, 1)}
      <i className={`person-token__dot person-token__dot--${index % 3}`} aria-hidden="true" />
    </span>
  );
}

function Workshop({ onExit }: Readonly<{ onExit: () => void }>) {
  return (
    <div className="workshop-view" aria-labelledby="workshop-heading">
      <header className="room-topbar">
        <button className="text-button" onClick={onExit} type="button">
          ← Mission World
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
          <div className="agent-status"><span aria-hidden="true">◈</span><div><strong>SonicAgent</strong><small>Waiting for review</small></div></div>
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

export function MissionWorld() {
  const [selectedRoomId, setSelectedRoomId] = useState<RoomId>("workshop");
  const [view, setView] = useState<"world" | "workshop">("world");
  const [showDirectory, setShowDirectory] = useState(false);
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? rooms[0]!;

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

  if (view === "workshop") {
    return <Workshop onExit={() => setView("world")} />;
  }

  return (
    <div className="mission-world" aria-label="Realworld Mission World">
      <header className="world-topbar">
        <a className="brand" href="#core" aria-label="Realworld Mission World">✦ <span>Realworld</span></a>
        <nav aria-label="Primary navigation">
          <a className="is-current" href="#world">Mission World</a>
          <a href="#missions">Missions</a>
          <a href="#surge">Surge</a>
        </nav>
        <div className="momentum" aria-label="Mission Momentum: strong. One fracture. Surge opening in one minute and twenty-four seconds.">
          <span className="momentum__mark">⌁</span><strong>Mission Momentum</strong><span className="momentum__bars" aria-hidden="true"><i /><i /><i /><i /><i /></span><b>Strong</b><span>Fractures <em>1</em></span><span>Surge opening <time>01:24</time></span>
        </div>
        <button className="create-button" type="button">＋ Create / Join Mission</button>
        <button className="icon-button" aria-label="Search" type="button">⌕</button>
        <button className="icon-button" aria-label="Notifications" type="button">♧</button>
        <PersonToken name="Priya" index={0} />
        <SessionControl />
      </header>

      <section className="mission-summary" aria-labelledby="mission-title">
        <p className="eyebrow">Mission</p>
        <h1 id="mission-title">Build Realworld into a living multiplayer work platform</h1>
        <p>Give humans and autonomous agents shared Missions, live rooms, durable Artifacts, and the tools to accomplish ambitious work together.</p>
        <div className="mission-summary__facts"><span><i /> Active</span><span>18 humans</span><span>7 agents</span><span>Updated 2m ago</span></div>
        <div className="summary-pulse"><strong>Pulse</strong><svg viewBox="0 0 220 34" aria-hidden="true"><path d="M1 21 C20 30 26 6 45 17 S70 26 88 11 S113 9 130 22 S155 25 169 14 S194 12 219 9" /></svg></div>
      </section>

      <main className="world-stage" id="main-content" tabIndex={-1}>
        <div className="stage-toolbar" aria-label="Mission World view controls">
          <button className={!showDirectory ? "is-active" : ""} onClick={() => setShowDirectory(false)} type="button">Map</button>
          <button className={showDirectory ? "is-active" : ""} onClick={() => setShowDirectory(true)} type="button">Room directory</button>
          <span>Use arrow keys to move between Rooms</span>
        </div>
        <div className="contours" aria-hidden="true" />
        <svg className="world-routes" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">
          <path d="M500 316 C470 220 640 180 715 210 M500 316 C370 290 220 330 175 390 M500 316 C620 330 780 380 790 410 M500 316 C470 420 370 480 280 470 M500 316 C530 430 590 520 590 540" />
          <path className="world-routes__active" d="M500 316 C470 220 640 180 715 210" />
        </svg>
        {showDirectory ? (
          <section className="room-directory" aria-labelledby="directory-heading">
            <div><p className="eyebrow">Non-spatial alternative</p><h2 id="directory-heading">Mission rooms</h2><p>Every destination, live state, and safe action in reading order.</p></div>
            <ul>
              {rooms.map((room) => (
                <li key={room.id} className={selectedRoom.id === room.id ? "is-selected" : ""}>
                  <button onClick={() => setSelectedRoomId(room.id)} type="button"><span className={`directory-icon directory-icon--${room.accent}`}>{room.landmark}</span><span><strong>{room.name}</strong><small>{room.description}</small><em>{room.active} active · {room.agents} agents</em></span></button>
                  <button className="directory-enter" onClick={() => enterRoom(room.id)} type="button">{room.action}</button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="world-map" aria-label="Spatial Mission map. Select a Room to inspect it; press Enter on the selected Room to enter it.">
            {rooms.map((room) => <RoomLandmark key={room.id} room={room} selected={selectedRoom.id === room.id} onSelect={setSelectedRoomId} onEnter={enterRoom} />)}
            <div className="map-event map-event--call"><span>⌁</span><strong>Open Call</strong><small>UI/UX critique</small><button type="button">Join Call</button></div>
            <div className="map-event map-event--fracture"><span>◈</span><strong>Fracture</strong><small>Auth session restoration stalls</small><button type="button">Review</button></div>
            <div className="map-event map-event--proof"><span>✓</span><strong>Proof complete</strong><small>Mission authorization contract verified</small></div>
          </div>
        )}
        <aside className="world-inspector" aria-live="polite" aria-labelledby="inspector-title">
          <button className="inspector-close" aria-label="Clear room selection" onClick={() => setSelectedRoomId("core")} type="button">×</button>
          <p className="eyebrow">{selectedRoom.eyebrow}</p>
          <h2 id="inspector-title">{selectedRoom.name}</h2>
          <p>{selectedRoom.description}</p>
          <div className="inspector-status"><span><i /> {selectedRoom.active} active</span><span>◈ {selectedRoom.agents} agent{selectedRoom.agents === 1 ? "" : "s"}</span></div>
          <section><h3>In this room</h3><ul className="inspector-people"><li><PersonToken name="Priya" index={0} /> Priya <small>shaping flow</small></li><li><PersonToken name="SonicAgent" index={1} /> SonicAgent <small>running evals</small></li><li><PersonToken name="Marco" index={2} /> Marco <small>reviewing Proof</small></li></ul></section>
          <section><h3>Recent artifacts</h3><ul className="artifact-list"><li>mission-world.tsx <small>UI component</small></li><li>realtime-room-protocol.md <small>systems contract</small></li><li>mission-kernel-contract.md <small>architecture</small></li></ul></section>
          <button className="primary-button" onClick={() => enterRoom(selectedRoom.id)} type="button">{selectedRoom.action}</button>
          <button className="secondary-button" type="button">Follow Priya</button>
        </aside>
      </main>
      <PulseRail />
    </div>
  );
}
