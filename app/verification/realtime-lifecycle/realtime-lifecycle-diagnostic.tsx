"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { BrowserLifecycleEvent, BrowserLifecycleSource } from "@/lib/realtime/browser-lifecycle";
import { createBrowserRealtimeComposition } from "@/lib/realtime/browser-realtime-composition";
import { createBrowserSignalPublicationPolicy } from "@/lib/realtime/browser-signal-policy";
import { createDomBrowserLifecycleSourceFromGlobals } from "@/lib/realtime/dom-browser-lifecycle";
import type { RealtimeEnvelope } from "@/lib/realtime/room-session";

type Counts = { sourceFactory: number; sessionFactory: number; start: number; stop: number; publish: number };
type BrowserContext = { online: boolean; visible: boolean; focused: boolean };

const lifecycleEvents: readonly BrowserLifecycleEvent[] = ["online", "offline", "visibilitychange", "blur", "focus"];

function diagnosticEnvelope(): RealtimeEnvelope {
  return {
    v: 1,
    kind: "presence.heartbeat",
    messageId: "verification-heartbeat",
    sender: { clientId: "verification-client", clientInstanceId: "verification-tab", connectionEpoch: 1 },
    missionId: "verification-mission",
    roomId: "verification-room",
    issuedAtMs: Date.now(),
    expiresAtMs: Date.now() + 10_000,
    clientSeq: 1,
    payload: { activity: "away", privacy: "coarse", roomSequence: 1 },
  };
}

export function RealtimeLifecycleDiagnostic() {
  const [counts, setCounts] = useState<Counts>({ sourceFactory: 0, sessionFactory: 0, start: 0, stop: 0, publish: 0 });
  const [active, setActive] = useState(false);
  const [activationStarted, setActivationStarted] = useState(false);
  const [browserContext, setBrowserContext] = useState<BrowserContext>({ online: false, visible: false, focused: false });
  const disabled = useMemo(() => createBrowserRealtimeComposition({
    environment: "test",
    rawEnabledFlag: undefined,
    sourceFactory: () => {
      setCounts((value) => ({ ...value, sourceFactory: value.sourceFactory + 1 }));
      return createDomBrowserLifecycleSourceFromGlobals();
    },
    sessionFactory: () => {
      setCounts((value) => ({ ...value, sessionFactory: value.sessionFactory + 1 }));
      return { start: () => undefined, stop: () => undefined };
    },
    publicationPolicy: createBrowserSignalPublicationPolicy(),
  }), []);
  const activeController = useRef(disabled);
  const observersCleanup = useRef<() => void>(() => undefined);
  const hasEnabled = useRef(false);

  useEffect(() => {
    void disabled.start().then(() => setActive(disabled.active));
    return () => {
      observersCleanup.current();
      void activeController.current.stop();
    };
  }, [disabled]);

  async function enable() {
    if (hasEnabled.current) return;
    setActivationStarted(true);
    let source: BrowserLifecycleSource | undefined;
    const enabled = createBrowserRealtimeComposition({
      environment: "test",
      rawEnabledFlag: "enabled",
      sourceFactory: () => {
        setCounts((value) => ({ ...value, sourceFactory: value.sourceFactory + 1 }));
        source = createDomBrowserLifecycleSourceFromGlobals();
        return source;
      },
      sessionFactory: () => {
        setCounts((value) => ({ ...value, sessionFactory: value.sessionFactory + 1 }));
        return {
          start: async () => { setCounts((value) => ({ ...value, start: value.start + 1 })); },
          stop: async () => { setCounts((value) => ({ ...value, stop: value.stop + 1 })); },
          publish: async () => { setCounts((value) => ({ ...value, publish: value.publish + 1 })); return true; },
        };
      },
      publicationPolicy: createBrowserSignalPublicationPolicy({ hiddenPresenceHeartbeatPolicy: "allow-away-coarse" }),
    });
    if (!source) return;
    const refreshBrowserContext = () => {
      setBrowserContext(source!.getContext());
      // The lifecycle listener queues its start/stop work on the same DOM
      // event. Read the controller after that event turn instead of predicting
      // connection state from visibility or focus.
      window.setTimeout(() => setActive(activeController.current.active), 0);
    };
    for (const event of lifecycleEvents) source.addEventListener(event, refreshBrowserContext);
    observersCleanup.current = () => {
      for (const event of lifecycleEvents) source?.removeEventListener(event, refreshBrowserContext);
    };
    refreshBrowserContext();
    activeController.current = enabled;
    hasEnabled.current = true;
    await enabled.start();
    setActive(enabled.active);
  }

  async function sendHeartbeat() {
    await activeController.current.publish(diagnosticEnvelope());
    setActive(activeController.current.active);
  }

  return (
    <main id="main-content" aria-labelledby="verification-heading" style={{ maxWidth: 720, margin: "48px auto", fontFamily: "system-ui" }}>
      <h1 id="verification-heading">Realtime lifecycle verification</h1>
      <p>This test-only surface uses a browser lifecycle source and a fake disposable session. It never creates a provider client.</p>
      <dl aria-label="Fake session calls">
        <div><dt>Source factory calls</dt><dd data-testid="source-factory-count">{counts.sourceFactory}</dd></div>
        <div><dt>Session factory calls</dt><dd data-testid="session-factory-count">{counts.sessionFactory}</dd></div>
        <div><dt>Start calls</dt><dd data-testid="start-count">{counts.start}</dd></div>
        <div><dt>Stop calls</dt><dd data-testid="stop-count">{counts.stop}</dd></div>
        <div><dt>Publish calls</dt><dd data-testid="publish-count">{counts.publish}</dd></div>
      </dl>
      <p role="status" aria-label="Lifecycle state">{active ? "Lifecycle active" : "Lifecycle inactive"}</p>
      <dl aria-label="Observed DOM lifecycle context">
        <div><dt>Online</dt><dd data-testid="context-online">{String(browserContext.online)}</dd></div>
        <div><dt>Visible</dt><dd data-testid="context-visible">{String(browserContext.visible)}</dd></div>
        <div><dt>Focused</dt><dd data-testid="context-focused">{String(browserContext.focused)}</dd></div>
      </dl>
      <button type="button" onClick={() => void enable()} disabled={activationStarted}>Enable test lifecycle</button>
      <button type="button" onClick={() => void sendHeartbeat()}>Send neutral heartbeat</button>
    </main>
  );
}
