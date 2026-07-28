import {
  createDevelopmentAblyRoomTransport,
  type AblyAdapterEnvironment,
  type AblyClientFactory,
} from "@/lib/realtime/ably-room-transport";
import type { RealtimeTransportAdapter } from "@/lib/realtime/room-session";

import type {
  DurableRoomReadiness,
  DurableRoomTransportFactory,
} from "./durable-room-session-factory";

type DevelopmentAblyEnvironment = Exclude<AblyAdapterEnvironment, "production">;

export type DevelopmentAblyTransportFactoryOptions = Readonly<{
  environment?: unknown;
  clientFactory?: unknown;
}>;

function isDevelopmentAblyEnvironment(value: unknown): value is DevelopmentAblyEnvironment {
  return value === "development" || value === "test" || value === "preview";
}

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

function hasBoundConnectScope(
  value: unknown,
  readiness: DurableRoomReadiness,
): value is Parameters<RealtimeTransportAdapter["connect"]>[0] {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<Parameters<RealtimeTransportAdapter["connect"]>[0]>;
  return typeof input.scope === "object"
    && input.scope !== null
    && input.scope.missionId === readiness.missionId
    && input.scope.roomId === readiness.roomId
    && typeof input.token === "object"
    && input.token !== null
    && typeof input.token.authorizationVersion === "number"
    && Number.isSafeInteger(input.token.authorizationVersion)
    && input.token.authorizationVersion > 0
    && input.token.authorizationVersion === readiness.grantVersion;
}

/**
 * Injected development-only provider composition for the Ably adapter. A client
 * factory must be injected; no ambient environment, key, or client is read or
 * created until a future room-session factory invokes this result.
 */
export function createDevelopmentAblyTransportFactory(
  options: DevelopmentAblyTransportFactoryOptions | undefined,
): DurableRoomTransportFactory | undefined {
  try {
    if (!options
      || !isDevelopmentAblyEnvironment(options.environment)
      || typeof options.clientFactory !== "function") return undefined;
    const environment = options.environment;
    const clientFactory = options.clientFactory as AblyClientFactory;

    return (readiness) => {
      try {
        if (!isDurableRoomReadiness(readiness)) return undefined;
        const adapter = createDevelopmentAblyRoomTransport({ environment, clientFactory });
        return {
          connect: async (input: Parameters<RealtimeTransportAdapter["connect"]>[0]) => {
            try {
              if (!hasBoundConnectScope(input, readiness)) throw new Error("invalid");
            } catch {
              throw new Error("Realtime transport connection rejected");
            }
            return await adapter.connect(input);
          },
        };
      } catch {
        return undefined;
      }
    };
  } catch {
    return undefined;
  }
}
