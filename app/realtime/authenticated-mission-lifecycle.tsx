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
  sessionFactory?: (readiness: DurableRoomReadiness) => BrowserRoomSession;
  readiness?: unknown;
  membershipGrantVersion?: unknown;
  expectedMissionId?: unknown;
  expectedRoomId?: unknown;
}>;

export type DurableRoomReadiness = Readonly<{
  missionId: string;
  roomId: string;
  grantVersion: number;
  missionLifecycle: "active";
  roomState: "active";
}>;

function developmentRealtimeIsExplicitlyEnabled() {
  return process.env.NEXT_PUBLIC_APP_ENV === "development"
    && process.env.NEXT_PUBLIC_REALTIME_LIFECYCLE === "enabled";
}

function isDurableRoomReadiness(
  value: unknown,
  membershipGrantVersion: unknown,
  expectedMissionId: unknown,
  expectedRoomId: unknown,
): value is DurableRoomReadiness {
  if (!value || typeof value !== "object") return false;
  const readiness = value as Partial<DurableRoomReadiness>;
  return typeof readiness.missionId === "string"
    && readiness.missionId.length > 0
    && typeof readiness.roomId === "string"
    && readiness.roomId.length > 0
    && typeof readiness.grantVersion === "number"
    && Number.isSafeInteger(readiness.grantVersion)
    && readiness.grantVersion > 0
    && readiness.grantVersion === membershipGrantVersion
    && readiness.missionId === expectedMissionId
    && readiness.roomId === expectedRoomId
    && readiness.missionLifecycle === "active"
    && readiness.roomState === "active";
}

/**
 * Mount only beneath the authenticated Mission World. It is inert by default:
 * no DOM source or session factory is touched until both an exact development
 * switch and a caller-provided session factory are present.
 */
export function AuthenticatedMissionRealtimeLifecycle({
  sessionFactory,
  readiness,
  membershipGrantVersion,
  expectedMissionId,
  expectedRoomId,
}: AuthenticatedMissionRealtimeLifecycleProps) {
  const durableReadiness = isDurableRoomReadiness(readiness, membershipGrantVersion, expectedMissionId, expectedRoomId) ? readiness : undefined;
  const missionId = durableReadiness?.missionId;
  const roomId = durableReadiness?.roomId;
  const grantVersion = durableReadiness?.grantVersion;

  useEffect(() => {
    if (!developmentRealtimeIsExplicitlyEnabled() || !missionId || !roomId || grantVersion === undefined || typeof sessionFactory !== "function") return;
    const scopedReadiness: DurableRoomReadiness = {
      missionId,
      roomId,
      grantVersion,
      missionLifecycle: "active",
      roomState: "active",
    };

    const lifecycle = createBrowserRealtimeComposition({
      environment: "development",
      rawEnabledFlag: "enabled",
      sourceFactory: createDomBrowserLifecycleSourceFromGlobals,
      sessionFactory: () => sessionFactory(scopedReadiness),
      publicationPolicy: createBrowserSignalPublicationPolicy(),
    });

    void lifecycle.start();
    return () => { void lifecycle.stop(); };
  }, [grantVersion, missionId, roomId, sessionFactory]);

  return null;
}
