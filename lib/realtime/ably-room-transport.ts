/**
 * Development-only Ably bridge for disposable Mission-room signals.
 *
 * The adapter consumes a signed TokenRequest already issued by the trusted
 * Convex boundary. It deliberately does not read environment variables, mint
 * tokens, write durable state, or log provider data.
 */

import type { TokenRequest } from "ably";

import { channelFamilyForKind, isSupportedRealtimeKind, parseRealtimePayload } from "./message-schema";
import {
  validateRealtimeEnvelope,
  type RealtimeEnvelope,
  type RealtimeRoomScope,
  type RealtimeTransportAdapter,
  type RealtimeTransportSubscription,
} from "./room-session";

type AblyOperation = "publish" | "subscribe" | "presence";
type AblyDevelopmentEnvironment = "development" | "test" | "preview";
export type AblyAdapterEnvironment = AblyDevelopmentEnvironment | "production";

type AblyInboundMessage = Readonly<{ data: unknown; name?: string }>;
type AblyConnectionState = Readonly<{ current?: string; reason?: unknown }>;
export type AblyConnectionTimer = Readonly<{
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}>;

export type AblyRoomChannel = Readonly<{
  subscribe: (listener: (message: AblyInboundMessage) => void) => Promise<unknown>;
  unsubscribe: (listener: (message: AblyInboundMessage) => void) => void;
  publish: (name: string, data: unknown) => Promise<unknown>;
  detach: () => Promise<void>;
  presence: Readonly<{
    subscribe: (listener: (message: AblyInboundMessage) => void) => Promise<void>;
    unsubscribe: (listener: (message: AblyInboundMessage) => void) => void;
    enter: (data?: unknown) => Promise<void>;
    update: (data?: unknown) => Promise<void>;
    leave: (data?: unknown) => Promise<void>;
  }>;
}>;

export type AblyRealtimeClient = Readonly<{
  channels: Readonly<{ get: (name: string) => AblyRoomChannel }>;
  connection: Readonly<{
    on: (events: string | string[], listener: (state: AblyConnectionState) => void) => void;
    off: (events: string | string[], listener: (state: AblyConnectionState) => void) => void;
  }>;
  connect: () => void;
  close: () => void;
}>;

export type AblyClientFactory = (tokenRequest: TokenRequest) => Promise<AblyRealtimeClient>;

export type DevelopmentAblyRoomTransportOptions = Readonly<{
  environment: AblyAdapterEnvironment;
  clientFactory?: AblyClientFactory;
  connectionReadyTimeoutMs?: number;
  timer?: AblyConnectionTimer;
  now?: () => number;
}>;

type ChannelKind = "world" | "presence" | "interaction" | "surge" | "agent-status";
type GrantedChannel = Readonly<{ name: string; kind: ChannelKind; operations: ReadonlySet<AblyOperation> }>;

const connectionFailureEvents = ["failed", "suspended", "closed"];
const knownOperations = new Set<AblyOperation>(["publish", "subscribe", "presence"]);
const maximumOperationsByChannel: Readonly<Record<ChannelKind, ReadonlySet<AblyOperation>>> = {
  world: new Set(["publish", "subscribe"]),
  presence: new Set(["presence", "subscribe"]),
  interaction: new Set(["publish", "subscribe"]),
  surge: new Set(["publish", "subscribe"]),
  "agent-status": new Set(["subscribe"]),
};
const defaultConnectionReadyTimeoutMs = 10_000;
const maximumConnectionReadyTimeoutMs = 30_000;
const defaultTimer: AblyConnectionTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTokenRequest(value: unknown): value is TokenRequest {
  return isRecord(value)
    && isNonEmptyString(value.keyName)
    && isNonEmptyString(value.nonce)
    && isNonEmptyString(value.mac)
    && isNonEmptyString(value.capability)
    && typeof value.timestamp === "number"
    && Number.isFinite(value.timestamp)
    && (value.ttl === undefined || (typeof value.ttl === "number" && Number.isFinite(value.ttl) && value.ttl > 0))
    && (value.clientId === undefined || isNonEmptyString(value.clientId));
}

function channelNames(environment: AblyDevelopmentEnvironment, scope: RealtimeRoomScope): Record<ChannelKind, string> {
  const prefix = `rw:${environment}:mission:${scope.missionId}`;
  return {
    world: `${prefix}:world`,
    presence: `${prefix}:room:${scope.roomId}:presence`,
    interaction: `${prefix}:room:${scope.roomId}:interaction`,
    surge: `${prefix}:room:${scope.roomId}:surge`,
    "agent-status": `${prefix}:room:${scope.roomId}:agent-status`,
  };
}

function parseCapabilities(
  tokenRequest: TokenRequest,
  environment: AblyDevelopmentEnvironment,
  scope: RealtimeRoomScope,
): GrantedChannel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tokenRequest.capability);
  } catch {
    throw new Error("Realtime capability is malformed");
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error("Realtime capability is malformed");

  const names = channelNames(environment, scope);
  const nameToKind = new Map(Object.entries(names).map(([kind, name]) => [name, kind as ChannelKind]));
  const granted: GrantedChannel[] = [];
  for (const [name, rawOperations] of Object.entries(parsed)) {
    const kind = nameToKind.get(name);
    if (!kind || !Array.isArray(rawOperations) || rawOperations.length === 0) {
      throw new Error("Realtime capability exceeds the requested scope");
    }
    const operations = new Set<AblyOperation>();
    for (const operation of rawOperations) {
      if (typeof operation !== "string" || !knownOperations.has(operation as AblyOperation) || operations.has(operation as AblyOperation)) {
        throw new Error("Realtime capability contains an unsupported operation");
      }
      if (!maximumOperationsByChannel[kind].has(operation as AblyOperation)) {
        throw new Error("Realtime capability grants an operation outside this channel family");
      }
      operations.add(operation as AblyOperation);
    }
    if (kind === "presence" && operations.has("presence") && !isNonEmptyString(tokenRequest.clientId)) {
      throw new Error("Realtime presence requires a token-bound client id");
    }
    granted.push({ name, kind, operations });
  }
  if (granted.length === 0) throw new Error("Realtime capability grants no exact channel");
  return granted;
}

function isExactFamilyMessage(value: unknown, kind: ChannelKind, scope: RealtimeRoomScope, now: number): value is RealtimeEnvelope {
  const envelope = validateRealtimeEnvelope(value, now);
  return envelope !== undefined
    && isSupportedRealtimeKind(envelope.kind)
    && channelFamilyForKind(envelope.kind) === kind
    && envelope.missionId === scope.missionId
    && envelope.roomId === scope.roomId
    && parseRealtimePayload(envelope.kind, envelope.payload) !== undefined;
}

function targetForMessage(message: RealtimeEnvelope): ChannelKind | undefined {
  return isSupportedRealtimeKind(message.kind) ? channelFamilyForKind(message.kind) : undefined;
}

function errorFromConnectionState(state: AblyConnectionState): unknown {
  return state.reason ?? new Error(`Realtime connection entered ${state.current ?? "a failed"} state`);
}

function normalizedConnectionReadyTimeout(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? defaultConnectionReadyTimeoutMs
    : Math.max(1, Math.min(maximumConnectionReadyTimeoutMs, value));
}

async function defaultClientFactory(tokenRequest: TokenRequest): Promise<AblyRealtimeClient> {
  const { default: Ably } = await import("ably");
  const client = new Ably.Realtime({
    autoConnect: false,
    authCallback: (_params, callback) => callback(null, tokenRequest),
  });
  // The SDK exposes overloaded channel methods; the adapter intentionally uses
  // only the v2 promise forms represented by its narrow injected-client seam.
  return client as unknown as AblyRealtimeClient;
}

/**
 * Uses only non-production, exact token capabilities. Supplying a factory is
 * the intended test seam; no provider object is constructed until connect().
 */
export class DevelopmentAblyRoomTransport implements RealtimeTransportAdapter {
  private readonly clientFactory: AblyClientFactory;
  private readonly timer: AblyConnectionTimer;
  private readonly connectionReadyTimeoutMs: number;

  constructor(private readonly options: DevelopmentAblyRoomTransportOptions) {
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.timer = options.timer ?? defaultTimer;
    this.connectionReadyTimeoutMs = normalizedConnectionReadyTimeout(options.connectionReadyTimeoutMs);
  }

  async connect(input: Parameters<RealtimeTransportAdapter["connect"]>[0]): Promise<RealtimeTransportSubscription> {
    if (this.options.environment === "production") {
      throw new Error("Realtime Ably transport is unsupported in production");
    }
    if (!isTokenRequest(input.token.tokenRequest)) throw new Error("Realtime token request is malformed");

    const granted = parseCapabilities(input.token.tokenRequest, this.options.environment, input.scope);
    const client = await this.clientFactory(input.token.tokenRequest);
    const channels = new Map<ChannelKind, AblyRoomChannel>();
    const listeners: Array<Readonly<{ channel: AblyRoomChannel; listener: (message: AblyInboundMessage) => void; presence: boolean }>> = [];
    const enteredPresence = new Set<AblyRoomChannel>();
    let closed = false;

    const getChannel = (grant: GrantedChannel) => {
      const existing = channels.get(grant.kind);
      if (existing) return existing;
      const channel = client.channels.get(grant.name);
      channels.set(grant.kind, channel);
      return channel;
    };
    const connectionFailure = (state: AblyConnectionState) => {
      if (!closed) input.onFailure(errorFromConnectionState(state));
    };
    const waitForConnectionReady = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finish: ((error?: unknown) => void) | undefined;
      const connected = () => finish?.();
      const failed = (state: AblyConnectionState) => finish?.(errorFromConnectionState(state));
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          finish = (error) => {
            if (settled) return;
            settled = true;
            if (error === undefined) resolve();
            else reject(error);
          };
          client.connection.on("connected", connected);
          client.connection.on(connectionFailureEvents, failed);
          timer = this.timer.setTimeout(() => finish?.(new Error("Realtime connection readiness timed out")), this.connectionReadyTimeoutMs);
          try {
            client.connect();
          } catch (error) {
            finish(error);
          }
        });
      } finally {
        if (timer !== undefined) this.timer.clearTimeout(timer);
        client.connection.off("connected", connected);
        client.connection.off(connectionFailureEvents, failed);
      }
    };

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      const capture = async (operation: () => void | Promise<void>) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      await capture(() => client.connection.off(connectionFailureEvents, connectionFailure));
      for (const { channel, listener, presence } of listeners) {
        await capture(() => presence ? channel.presence.unsubscribe(listener) : channel.unsubscribe(listener));
      }
      for (const channel of enteredPresence) await capture(() => channel.presence.leave());
      for (const channel of channels.values()) await capture(() => channel.detach());
      await capture(() => client.close());
      if (errors[0] !== undefined) throw errors[0];
    };

    try {
      client.connection.on(connectionFailureEvents, connectionFailure);
      for (const grant of granted) {
        const channel = getChannel(grant);
        if (!grant.operations.has("subscribe")) continue;
        const listener = (message: AblyInboundMessage) => {
          if (!closed && isExactFamilyMessage(message.data, grant.kind, input.scope, this.options.now?.() ?? Date.now())) input.onMessage(message.data);
        };
        if (grant.kind === "presence") {
          await channel.presence.subscribe(listener);
          listeners.push({ channel, listener, presence: true });
        } else {
          await channel.subscribe(listener);
          listeners.push({ channel, listener, presence: false });
        }
      }
      await waitForConnectionReady();
    } catch (error) {
      try {
        await cleanup();
      } catch {
        // Preserve the connection/authentication failure that prevented startup.
      }
      throw error;
    }

    return {
      unsubscribe: cleanup,
      publish: async (message) => {
        if (closed) throw new Error("Realtime transport is closed");
        if (!isExactFamilyMessage(message, targetForMessage(message) ?? "world", input.scope, this.options.now?.() ?? Date.now())) {
          throw new Error("Realtime message is outside the active scope or family");
        }
        const target = targetForMessage(message);
        if (!target) throw new Error("Realtime message kind is unsupported");
        const grant = granted.find((candidate) => candidate.kind === target);
        if (!grant) throw new Error("Realtime message channel is not granted");
        const channel = getChannel(grant);
        if (target === "presence") {
          if (!grant.operations.has("presence")) throw new Error("Realtime presence is not granted");
          if (message.kind === "presence.leave") {
            if (enteredPresence.delete(channel)) await channel.presence.leave(message);
            return;
          }
          if (enteredPresence.has(channel)) await channel.presence.update(message);
          else {
            await channel.presence.enter(message);
            enteredPresence.add(channel);
          }
          return;
        }
        if (!grant.operations.has("publish")) throw new Error("Realtime publish is not granted");
        await channel.publish(message.kind, message);
      },
    };
  }
}

export function createDevelopmentAblyRoomTransport(options: DevelopmentAblyRoomTransportOptions) {
  return new DevelopmentAblyRoomTransport(options);
}
