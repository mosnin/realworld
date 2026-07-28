import type { BrowserRoomSession } from "@/lib/realtime/browser-lifecycle";
import {
  RealtimeRoomSession,
  type RealtimeRoomScope,
  type RealtimeToken,
  type RealtimeTokenProvider,
  type RealtimeTransportAdapter,
} from "@/lib/realtime/room-session";

/** The only durable scope a browser-origin room session may receive. */
export type DurableRoomReadiness = Readonly<{
  missionId: string;
  roomId: string;
  grantVersion: number;
  missionLifecycle: "active";
  roomState: "active";
}>;

/**
 * These factories are deliberately injected by a future authenticated
 * integration. This module never issues a token, imports a provider, or reads
 * runtime configuration.
 */
export type DurableRoomTokenProviderFactory = (readiness: DurableRoomReadiness) => unknown;
export type DurableRoomTransportFactory = (readiness: DurableRoomReadiness) => unknown;
export type DurableRoomSessionFactory = (readiness: DurableRoomReadiness) => BrowserRoomSession | undefined;

export type DurableRoomSessionFactoryOptions = Readonly<{
  tokenProviderFactory?: unknown;
  transportFactory?: unknown;
}>;

function isDurableRoomReadiness(value: unknown): value is DurableRoomReadiness {
  if (!value || typeof value !== "object") return false;
  const readiness = value as Partial<DurableRoomReadiness>;
  return typeof readiness.missionId === "string"
    && readiness.missionId.length > 0
    && typeof readiness.roomId === "string"
    && readiness.roomId.length > 0
    && typeof readiness.grantVersion === "number"
    && Number.isSafeInteger(readiness.grantVersion)
    && readiness.grantVersion > 0
    && readiness.missionLifecycle === "active"
    && readiness.roomState === "active";
}

function isRealtimeTokenProvider(value: unknown): value is RealtimeTokenProvider {
  return typeof value === "function";
}

function isRealtimeTransportAdapter(value: unknown): value is RealtimeTransportAdapter {
  return typeof value === "object"
    && value !== null
    && typeof (value as RealtimeTransportAdapter).connect === "function";
}

function isRealtimeToken(value: unknown, grantVersion: number): value is RealtimeToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<RealtimeToken>;
  return token.tokenRequest !== null
    && typeof token.tokenRequest === "object"
    && typeof token.expiresAt === "number"
    && Number.isFinite(token.expiresAt)
    && token.expiresAt > Date.now()
    && typeof token.authorizationVersion === "number"
    && Number.isSafeInteger(token.authorizationVersion)
    && token.authorizationVersion === grantVersion;
}

function sameScope(left: RealtimeRoomScope, right: RealtimeRoomScope) {
  return left.missionId === right.missionId && left.roomId === right.roomId;
}

/**
 * Binds one already-authorized durable room scope to the provider-independent
 * session kernel. Invalid factories or outputs return no session, allowing the
 * caller's existing fail-closed composition boundary to remain inert.
 */
export function createDurableRoomSessionFactory(
  options: DurableRoomSessionFactoryOptions | undefined,
): DurableRoomSessionFactory | undefined {
  try {
    if (!options
      || typeof options.tokenProviderFactory !== "function"
      || typeof options.transportFactory !== "function") return undefined;

    const tokenProviderFactory = options.tokenProviderFactory as DurableRoomTokenProviderFactory;
    const transportFactory = options.transportFactory as DurableRoomTransportFactory;

    return (readiness) => {
      try {
        if (!isDurableRoomReadiness(readiness)) return undefined;
        const tokenProvider = tokenProviderFactory(readiness);
        const transport = transportFactory(readiness);
        if (!isRealtimeTokenProvider(tokenProvider) || !isRealtimeTransportAdapter(transport)) return undefined;
        const validatedTokenProvider: RealtimeTokenProvider = tokenProvider;
        const validatedTransport: RealtimeTransportAdapter = transport;

        const scope = { missionId: readiness.missionId, roomId: readiness.roomId };
        const boundTokenProvider: RealtimeTokenProvider = async (requestedScope) => {
          if (!sameScope(requestedScope, scope)) throw new Error("Realtime token scope mismatch");
          const token = await validatedTokenProvider(requestedScope);
          if (!isRealtimeToken(token, readiness.grantVersion)) throw new Error("Realtime token is invalid for this membership grant");
          return token;
        };
        const session = new RealtimeRoomSession({ tokenProvider: boundTokenProvider, transport: validatedTransport });
        return {
          start: () => session.start(scope),
          stop: () => session.stop(),
          publish: (message) => session.publish(message),
        };
      } catch {
        return undefined;
      }
    };
  } catch {
    return undefined;
  }
}
