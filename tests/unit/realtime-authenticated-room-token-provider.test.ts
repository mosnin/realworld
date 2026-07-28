import { describe, expect, it, vi } from "vitest";

import { createAuthenticatedRoomTokenProvider } from "../../app/realtime/authenticated-room-token-provider";

const readiness = {
  missionId: "mission_a",
  roomId: "room_a",
  grantVersion: 3,
  missionLifecycle: "active" as const,
  roomState: "active" as const,
};

function issuedToken(overrides: Record<string, unknown> = {}) {
  const timestamp = Date.now();
  const ttl = 60_000;
  return {
    missionId: readiness.missionId,
    roomId: readiness.roomId,
    authorizationVersion: readiness.grantVersion,
    expiresAt: timestamp + ttl,
    tokenRequest: {
      keyName: "test.key",
      ttl,
      timestamp,
      nonce: "nonce-1234567890123456",
      capability: "{}",
      clientId: "rw_test",
      mac: "signed-mac",
    },
    ...overrides,
  };
}

describe("authenticated room token provider", () => {
  it("is lazy, requests only the exact bound scope, preserves a valid token request, and maps the durable grant", async () => {
    const response = issuedToken();
    const requester = vi.fn(async () => response);
    const provider = createAuthenticatedRoomTokenProvider(readiness, requester);

    expect(provider).toBeTypeOf("function");
    expect(requester).not.toHaveBeenCalled();
    const token = await provider?.({ missionId: "mission_a", roomId: "room_a" });

    expect(requester).toHaveBeenCalledTimes(1);
    expect(requester).toHaveBeenCalledWith({ missionId: "mission_a", roomId: "room_a" });
    expect(token).toEqual({
      tokenRequest: response.tokenRequest,
      expiresAt: response.expiresAt,
      authorizationVersion: 3,
    });
    expect(token?.tokenRequest).not.toBe(response.tokenRequest);
  });

  it("fails closed before requester invocation for malformed readiness/requester and a mismatched requested scope", async () => {
    const requester = vi.fn(async () => issuedToken());
    expect(createAuthenticatedRoomTokenProvider(undefined, requester)).toBeUndefined();
    expect(createAuthenticatedRoomTokenProvider({ ...readiness, grantVersion: 0 }, requester)).toBeUndefined();
    expect(createAuthenticatedRoomTokenProvider({ get missionId(): unknown { throw new Error("hostile readiness getter"); } }, requester)).toBeUndefined();
    expect(createAuthenticatedRoomTokenProvider(readiness, "not-a-requester")).toBeUndefined();

    const provider = createAuthenticatedRoomTokenProvider(readiness, requester);
    await expect(provider?.({ missionId: "mission_a", roomId: "other_room" })).rejects.toThrow("Realtime token request rejected");
    expect(requester).not.toHaveBeenCalled();
  });

  it("rejects scope/grant/TTL/expiry/malformed and hostile responses without returning a token", async () => {
    const overTtlTimestamp = Date.now();
    const overTtl = (5 * 60_000) + 1;
    const invalidResponses: unknown[] = [
      issuedToken({ missionId: "other_mission" }),
      issuedToken({ roomId: "other_room" }),
      issuedToken({ authorizationVersion: 4 }),
      issuedToken({ expiresAt: Date.now() - 1 }),
      issuedToken({
        expiresAt: overTtlTimestamp + overTtl,
        tokenRequest: { ...issuedToken().tokenRequest, timestamp: overTtlTimestamp, ttl: overTtl },
      }),
      issuedToken({ tokenRequest: { ...issuedToken().tokenRequest, ttl: 999 } }),
      issuedToken({ tokenRequest: null }),
      { get missionId(): unknown { throw new Error("hostile response getter"); } },
      issuedToken({
        tokenRequest: {
          get keyName(): unknown { throw new Error("hostile token getter"); },
          ttl: 60_000,
          timestamp: Date.now(),
          nonce: "nonce-1234567890123456",
          capability: "{}",
          clientId: "rw_test",
          mac: "signed-mac",
        },
      }),
    ];

    for (const response of invalidResponses) {
      const requester = vi.fn(async () => response);
      const provider = createAuthenticatedRoomTokenProvider(readiness, requester);
      await expect(provider?.({ missionId: "mission_a", roomId: "room_a" })).rejects.toThrow("Realtime token request rejected");
      expect(requester).toHaveBeenCalledTimes(1);
    }
  });

  it("normalizes synchronous and rejected requester failures, while concurrent requests stay independently scoped", async () => {
    const synchronousFailure = createAuthenticatedRoomTokenProvider(readiness, () => { throw new Error("sync requester failure"); });
    const rejectedFailure = createAuthenticatedRoomTokenProvider(readiness, async () => { throw new Error("async requester failure"); });
    await expect(synchronousFailure?.({ missionId: "mission_a", roomId: "room_a" })).rejects.toThrow("Realtime token request rejected");
    await expect(rejectedFailure?.({ missionId: "mission_a", roomId: "room_a" })).rejects.toThrow("Realtime token request rejected");

    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    const requester = vi.fn(() => new Promise<unknown>((resolve) => {
      if (!resolveFirst) resolveFirst = resolve;
      else resolveSecond = resolve;
    }));
    const provider = createAuthenticatedRoomTokenProvider(readiness, requester);
    const first = provider?.({ missionId: "mission_a", roomId: "room_a" });
    const second = provider?.({ missionId: "mission_a", roomId: "room_a" });
    expect(requester).toHaveBeenCalledTimes(2);
    expect(requester).toHaveBeenNthCalledWith(1, { missionId: "mission_a", roomId: "room_a" });
    expect(requester).toHaveBeenNthCalledWith(2, { missionId: "mission_a", roomId: "room_a" });
    resolveFirst?.(issuedToken());
    resolveSecond?.(issuedToken());
    const [firstToken, secondToken] = await Promise.all([first, second]);
    expect(firstToken).toEqual(secondToken);
    expect(firstToken).not.toBe(secondToken);
  });
});
