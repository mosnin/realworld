"use client";

import { useEffect } from "react";

import { createBrowserRealtimeComposition } from "@/lib/realtime/browser-realtime-composition";
import { createBrowserSignalPublicationPolicy } from "@/lib/realtime/browser-signal-policy";
import { createDomBrowserLifecycleSourceFromGlobals } from "@/lib/realtime/dom-browser-lifecycle";
import {
  createAuthenticatedRoomTokenProvider,
  type AuthenticatedRoomTokenRequester,
} from "./authenticated-room-token-provider";
import {
  createDurableRoomSessionFactory,
  type DurableRoomReadiness,
  type DurableRoomSessionFactory,
  type DurableRoomTokenProviderFactory,
  type DurableRoomTransportFactory,
} from "./durable-room-session-factory";
import type { RealtimeEnvelope, RoomSessionState } from "@/lib/realtime/room-session";

export type AuthenticatedMissionRealtimeLifecycleProps = Readonly<{
  /**
   * A future authenticated room integration may inject its disposable,
   * Mission-scoped session here. This boundary intentionally has no provider
   * client, token, or transport dependency of its own.
   */
  sessionFactory?: DurableRoomSessionFactory;
  tokenProviderFactory?: DurableRoomTokenProviderFactory;
  authenticatedTokenRequester?: AuthenticatedRoomTokenRequester;
  transportFactory?: DurableRoomTransportFactory;
  readiness?: unknown;
  membershipGrantVersion?: unknown;
  expectedMissionId?: unknown;
  expectedRoomId?: unknown;
  onStateChange?: (scope: DurableRoomReadiness, state: RoomSessionState) => void;
  onMessage?: (scope: DurableRoomReadiness, message: RealtimeEnvelope) => void;
}>;

export type { DurableRoomReadiness } from "./durable-room-session-factory";

function developmentRealtimeEnvironment(): "development" | "test" | "preview" | undefined {
  const environment = process.env.NEXT_PUBLIC_APP_ENV;
  if (process.env.NEXT_PUBLIC_REALTIME_LIFECYCLE !== "enabled") return undefined;
  return environment === "development" || environment === "test" || environment === "preview"
    ? environment
    : undefined;
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

function notifyActivePresentationCallback(active: () => boolean, callback: (() => unknown) | undefined) {
  if (!active() || callback === undefined) return;
  try {
    void Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // Presentation observers never control authenticated session lifecycle.
  }
}

/**
 * Mount only beneath the authenticated Mission World. It is inert by default:
 * no DOM source or session factory is touched until both an exact development
 * switch and a caller-provided session factory are present.
 */
export function AuthenticatedMissionRealtimeLifecycle({
  sessionFactory,
  tokenProviderFactory,
  authenticatedTokenRequester,
  transportFactory,
  readiness,
  membershipGrantVersion,
  expectedMissionId,
  expectedRoomId,
  onStateChange,
  onMessage,
}: AuthenticatedMissionRealtimeLifecycleProps) {
  const durableReadiness = isDurableRoomReadiness(readiness, membershipGrantVersion, expectedMissionId, expectedRoomId) ? readiness : undefined;
  const missionId = durableReadiness?.missionId;
  const roomId = durableReadiness?.roomId;
  const grantVersion = durableReadiness?.grantVersion;

  useEffect(() => {
    const realtimeEnvironment = developmentRealtimeEnvironment();
    if (realtimeEnvironment === undefined || !missionId || !roomId || grantVersion === undefined) return;
    const scopedReadiness: DurableRoomReadiness = {
      missionId,
      roomId,
      grantVersion,
      missionLifecycle: "active",
      roomState: "active",
    };

    const bridgeTokenProviderFactory = tokenProviderFactory === undefined && typeof authenticatedTokenRequester === "function"
      ? (candidate: DurableRoomReadiness) => createAuthenticatedRoomTokenProvider(candidate, authenticatedTokenRequester)
      : undefined;
    const resolvedTokenProviderFactory = tokenProviderFactory ?? bridgeTokenProviderFactory;
    let active = true;
    const guardedStateChange = (scope: DurableRoomReadiness, state: RoomSessionState) => {
      notifyActivePresentationCallback(() => active, () => onStateChange?.(scope, state));
    };
    const guardedMessage = (scope: DurableRoomReadiness, message: RealtimeEnvelope) => {
      notifyActivePresentationCallback(() => active, () => onMessage?.(scope, message));
    };
    const resolvedSessionFactory = sessionFactory ?? createDurableRoomSessionFactory({
      tokenProviderFactory: resolvedTokenProviderFactory,
      transportFactory,
      onStateChange: guardedStateChange,
      onMessage: guardedMessage,
    });
    if (typeof resolvedSessionFactory !== "function") return;

    const lifecycle = createBrowserRealtimeComposition({
      environment: realtimeEnvironment,
      rawEnabledFlag: "enabled",
      sourceFactory: createDomBrowserLifecycleSourceFromGlobals,
      sessionFactory: () => resolvedSessionFactory(scopedReadiness),
      publicationPolicy: createBrowserSignalPublicationPolicy(),
    });

    void lifecycle.start();
    return () => { active = false; void lifecycle.stop(); };
  }, [authenticatedTokenRequester, grantVersion, missionId, roomId, onMessage, onStateChange, sessionFactory, tokenProviderFactory, transportFactory]);

  return null;
}
