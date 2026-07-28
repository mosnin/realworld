import type { RealtimeRoomScope, RealtimeToken, RealtimeTokenProvider } from "@/lib/realtime/room-session";

import type { DurableRoomReadiness } from "./durable-room-session-factory";

const minimumTokenTtlMs = 1_000;
const maximumTokenTtlMs = 5 * 60 * 1_000;

export type AuthenticatedRoomTokenRequest = Readonly<{
  missionId: string;
  roomId: string;
}>;

/** A future authenticated caller owns the actual action/network invocation. */
export type AuthenticatedRoomTokenRequester = (request: AuthenticatedRoomTokenRequest) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDurableRoomReadiness(value: unknown): value is DurableRoomReadiness {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.missionId)
    && isNonEmptyString(value.roomId)
    && typeof value.grantVersion === "number"
    && Number.isSafeInteger(value.grantVersion)
    && value.grantVersion > 0
    && value.missionLifecycle === "active"
    && value.roomState === "active";
}

function sameScope(left: RealtimeRoomScope, right: AuthenticatedRoomTokenRequest) {
  return left.missionId === right.missionId && left.roomId === right.roomId;
}

function parseTokenResponse(
  value: unknown,
  expectedScope: AuthenticatedRoomTokenRequest,
  grantVersion: number,
  now: number,
): RealtimeToken | undefined {
  if (!isRecord(value)
    || value.missionId !== expectedScope.missionId
    || value.roomId !== expectedScope.roomId
    || value.authorizationVersion !== grantVersion
    || !Number.isSafeInteger(value.authorizationVersion)
    || typeof value.expiresAt !== "number"
    || !Number.isFinite(value.expiresAt)
    || !isRecord(value.tokenRequest)) return undefined;

  const request = value.tokenRequest;
  if (!isNonEmptyString(request.keyName)
    || !isNonEmptyString(request.nonce)
    || !isNonEmptyString(request.capability)
    || !isNonEmptyString(request.clientId)
    || !isNonEmptyString(request.mac)
    || typeof request.timestamp !== "number"
    || !Number.isFinite(request.timestamp)
    || typeof request.ttl !== "number"
    || !Number.isFinite(request.ttl)
    || request.ttl < minimumTokenTtlMs
    || request.ttl > maximumTokenTtlMs
    || value.expiresAt !== request.timestamp + request.ttl
    || value.expiresAt <= now
    || value.expiresAt - now > maximumTokenTtlMs) return undefined;

  return {
    tokenRequest: {
      keyName: request.keyName,
      ttl: request.ttl,
      timestamp: request.timestamp,
      nonce: request.nonce,
      capability: request.capability,
      clientId: request.clientId,
      mac: request.mac,
    },
    expiresAt: value.expiresAt,
    authorizationVersion: value.authorizationVersion,
  };
}

/**
 * Converts an authenticated, injected request function into the kernel's
 * token-provider contract. It never imports a backend client, reads runtime
 * configuration, or sends anything other than the exact Mission/room scope.
 */
export function createAuthenticatedRoomTokenProvider(
  readiness: unknown,
  requester: unknown,
): RealtimeTokenProvider | undefined {
  try {
    if (!isDurableRoomReadiness(readiness) || typeof requester !== "function") return undefined;
    const expectedScope = { missionId: readiness.missionId, roomId: readiness.roomId };
    const authenticatedRequester = requester as AuthenticatedRoomTokenRequester;

    return async (requestedScope) => {
      try {
        if (!sameScope(requestedScope, expectedScope)) throw new Error("Realtime token scope mismatch");
        const response = await authenticatedRequester({
          missionId: expectedScope.missionId,
          roomId: expectedScope.roomId,
        });
        const token = parseTokenResponse(response, expectedScope, readiness.grantVersion, Date.now());
        if (!token) throw new Error("Realtime token response is invalid");
        return token;
      } catch {
        throw new Error("Realtime token request rejected");
      }
    };
  } catch {
    return undefined;
  }
}
