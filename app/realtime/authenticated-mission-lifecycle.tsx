"use client";

import { useEffect } from "react";

import type { BrowserRoomSession } from "@/lib/realtime/browser-lifecycle";
import { createBrowserRealtimeComposition } from "@/lib/realtime/browser-realtime-composition";
import { createBrowserSignalPublicationPolicy } from "@/lib/realtime/browser-signal-policy";
import { createDomBrowserLifecycleSourceFromGlobals } from "@/lib/realtime/dom-browser-lifecycle";

export type AuthenticatedMissionRealtimeLifecycleProps = Readonly<{
  /**
   * A future authenticated room integration may inject its disposable,
   * Mission-scoped session here. This boundary intentionally has no provider
   * client, token, or transport dependency of its own.
   */
  sessionFactory?: () => BrowserRoomSession;
}>;

function developmentRealtimeIsExplicitlyEnabled() {
  return process.env.NEXT_PUBLIC_APP_ENV === "development"
    && process.env.NEXT_PUBLIC_REALTIME_LIFECYCLE === "enabled";
}

/**
 * Mount only beneath the authenticated Mission World. It is inert by default:
 * no DOM source or session factory is touched until both an exact development
 * switch and a caller-provided session factory are present.
 */
export function AuthenticatedMissionRealtimeLifecycle({
  sessionFactory,
}: AuthenticatedMissionRealtimeLifecycleProps) {
  useEffect(() => {
    if (!developmentRealtimeIsExplicitlyEnabled() || typeof sessionFactory !== "function") return;

    const lifecycle = createBrowserRealtimeComposition({
      environment: "development",
      rawEnabledFlag: "enabled",
      sourceFactory: createDomBrowserLifecycleSourceFromGlobals,
      sessionFactory,
      publicationPolicy: createBrowserSignalPublicationPolicy(),
    });

    void lifecycle.start();
    return () => { void lifecycle.stop(); };
  }, [sessionFactory]);

  return null;
}
