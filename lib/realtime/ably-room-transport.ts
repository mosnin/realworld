/**
 * Non-production Ably bridge for disposable Mission-room signals.
 *
 * The adapter consumes a signed TokenRequest already issued by the trusted
 * Convex boundary. It deliberately does not read environment variables, mint
 * tokens, write durable state, or log provider data.
 */

import type { TokenRequest } from "ably";

import { channelFamilyForKind, isSupportedRealtimeKind, parseRealtimePayload } from "./message-schema";
import {
  disabledRealtimeTelemetry,
  type PrivacySafeRealtimeTelemetry,
} from "./privacy-telemetry";
import {
  validateRealtimeEnvelope,
  type RealtimeEnvelope,
  type RealtimeRoomScope,
  type RealtimeTransportAdapter,
  type RealtimeTransportSubscription,
} from "./room-session";
import {
  createRealtimePublishGovernor,
  RealtimePublishRateLimitError,
  type RealtimePublishGovernor,
} from "./signal-governor";

type AblyOperation = "publish" | "subscribe" | "presence";
type AblyDevelopmentEnvironment = "development" | "test" | "preview";
export type AblyAdapterEnvironment = AblyDevelopmentEnvironment | "production";

export type AblyInboundMessage = Readonly<{ data: unknown; name?: string; clientId?: string }>;
export type AblyConnectionState = Readonly<{ current?: string; reason?: unknown }>;
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
  clientFactory: AblyClientFactory;
  connectionReadyTimeoutMs?: number;
  providerOperationTimeoutMs?: number;
  timer?: AblyConnectionTimer;
  now?: () => number;
  publishGovernor?: Pick<RealtimePublishGovernor, "acquire">;
  telemetry?: PrivacySafeRealtimeTelemetry;
}>;

type ChannelKind = "world" | "presence" | "interaction" | "surge" | "agent-status";
type GrantedChannel = Readonly<{ name: string; kind: ChannelKind; operations: ReadonlySet<AblyOperation> }>;
type ValidatedProviderClient = Readonly<{
  client: AblyRealtimeClient;
  channels: ReadonlyMap<ChannelKind, AblyRoomChannel>;
}>;

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
const defaultProviderOperationTimeoutMs = 10_000;
const maximumProviderOperationTimeoutMs = 30_000;
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
    if ((operations.has("publish") || operations.has("presence")) && !isNonEmptyString(tokenRequest.clientId)) {
      throw new Error("Realtime publishing requires a token-bound client id");
    }
    granted.push({ name, kind, operations });
  }
  if (granted.length === 0) throw new Error("Realtime capability grants no exact channel");
  return granted;
}

function isExactFamilyMessage(
  value: unknown,
  kind: ChannelKind,
  scope: RealtimeRoomScope,
  now: number,
  authenticatedClientId?: string,
): value is RealtimeEnvelope {
  const envelope = validateRealtimeEnvelope(value, now);
  return envelope !== undefined
    && isNonEmptyString(authenticatedClientId)
    && envelope.sender.clientId === authenticatedClientId
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
  void state;
  return new Error("Realtime connection is unavailable");
}

function bindProviderMethod<Arguments extends unknown[], Result>(
  receiver: object,
  method: (...args: Arguments) => Result,
): (...args: Arguments) => Result {
  return (...args) => Reflect.apply(method, receiver, args) as Result;
}

type ProviderOperation = "connection" | "subscription" | "publish" | "cleanup";

function providerOperationError(operation: ProviderOperation): Error {
  switch (operation) {
    case "connection": return new Error("Realtime connection is unavailable");
    case "subscription": return new Error("Realtime subscription is unavailable");
    case "publish": return new Error("Realtime publish is unavailable");
    case "cleanup": return new Error("Realtime cleanup failed");
  }
}

async function awaitProvider<Return>(operation: ProviderOperation, callback: () => Return | Promise<Return>): Promise<Return> {
  try {
    return await callback();
  } catch {
    throw providerOperationError(operation);
  }
}

async function awaitBoundedProvider<Return>(
  operation: ProviderOperation,
  callback: () => Return | Promise<Return>,
  options: Readonly<{
    timer: AblyConnectionTimer;
    timeoutMs: number;
    undoOnFailure?: () => void | Promise<void>;
    undoLateSuccess?: (value: Return) => void | Promise<void>;
  }>,
): Promise<Return> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let timedOut = false;
  const undoOnFailure = () => {
    if (!options.undoOnFailure) return;
    void (async () => {
      try {
        await awaitBoundedProvider("cleanup", options.undoOnFailure!, {
          timer: options.timer,
          timeoutMs: options.timeoutMs,
        });
      } catch {
        // The original operation is already failed or has settled elsewhere.
      }
    })();
  };
  try {
    return await new Promise<Return>((resolve, reject) => {
      const finish = (error?: unknown, value?: Return) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve(value as Return);
        else reject(error);
      };
      timer = options.timer.setTimeout(() => {
        timedOut = true;
        finish(providerOperationError(operation));
        undoOnFailure();
      }, options.timeoutMs);
      void (async () => {
        try {
          const value = await awaitProvider(operation, callback);
          if (settled) {
            if (timedOut && options.undoLateSuccess) {
              void (async () => {
                try {
                  await awaitBoundedProvider("cleanup", () => options.undoLateSuccess!(value), {
                    timer: options.timer,
                    timeoutMs: options.timeoutMs,
                  });
                } catch {
                  // The caller already received the bounded generic failure.
                }
              })();
            }
            return;
          }
          finish(undefined, value);
        } catch (error) {
          if (!settled) undoOnFailure();
          finish(error);
        }
      })();
    });
  } finally {
    if (timer !== undefined) options.timer.clearTimeout(timer);
  }
}

type CapturedProviderClose = () => unknown;

function captureProviderClose(candidate: unknown): CapturedProviderClose | undefined {
  try {
    if (!isRecord(candidate)) return undefined;
    const close = candidate.close;
    return typeof close === "function" ? () => Reflect.apply(close, candidate, []) : undefined;
  } catch {
    return undefined;
  }
}

async function closeCapturedProviderClient(
  close: CapturedProviderClose | undefined,
  timer: AblyConnectionTimer,
  timeoutMs: number,
) {
  try {
    if (!close) return;
    await awaitBoundedProvider("cleanup", close, { timer, timeoutMs });
  } catch {
    // The discarded client is never used, and provider details stay contained.
  }
}

/**
 * The provider client is supplied by application code. Check its complete
 * surface, including every granted channel, before it can register a listener
 * or mutate presence.
 */
function validateProviderClientContract(
  candidate: unknown,
  granted: readonly GrantedChannel[],
  close: CapturedProviderClose | undefined,
): ValidatedProviderClient | undefined {
  try {
    if (!isRecord(candidate)) return undefined;

    const channels = candidate.channels;
    const connection = candidate.connection;
    const connect = candidate.connect;
    if (!isRecord(channels) || !isRecord(connection)
      || typeof connect !== "function"
      || !close) {
      return undefined;
    }

    const get = channels.get;
    const on = connection.on;
    const off = connection.off;
    if (typeof get !== "function" || typeof on !== "function" || typeof off !== "function") return undefined;

    const validatedChannels = new Map<ChannelKind, AblyRoomChannel>();
    for (const grant of granted) {
      const channel = bindProviderMethod(channels, get as AblyRealtimeClient["channels"]["get"])(grant.name);
      if (!isRecord(channel)) return undefined;

      const subscribe = channel.subscribe;
      const unsubscribe = channel.unsubscribe;
      const publish = channel.publish;
      const detach = channel.detach;
      const presence = channel.presence;
      if (!isRecord(presence)
        || typeof subscribe !== "function"
        || typeof unsubscribe !== "function"
        || typeof publish !== "function"
        || typeof detach !== "function") {
        return undefined;
      }

      const presenceSubscribe = presence.subscribe;
      const presenceUnsubscribe = presence.unsubscribe;
      const presenceEnter = presence.enter;
      const presenceUpdate = presence.update;
      const presenceLeave = presence.leave;
      if (typeof presenceSubscribe !== "function"
        || typeof presenceUnsubscribe !== "function"
        || typeof presenceEnter !== "function"
        || typeof presenceUpdate !== "function"
        || typeof presenceLeave !== "function") {
        return undefined;
      }

      validatedChannels.set(grant.kind, {
        subscribe: bindProviderMethod(channel, subscribe as AblyRoomChannel["subscribe"]),
        unsubscribe: bindProviderMethod(channel, unsubscribe as AblyRoomChannel["unsubscribe"]),
        publish: bindProviderMethod(channel, publish as AblyRoomChannel["publish"]),
        detach: bindProviderMethod(channel, detach as AblyRoomChannel["detach"]),
        presence: {
          subscribe: bindProviderMethod(presence, presenceSubscribe as AblyRoomChannel["presence"]["subscribe"]),
          unsubscribe: bindProviderMethod(presence, presenceUnsubscribe as AblyRoomChannel["presence"]["unsubscribe"]),
          enter: bindProviderMethod(presence, presenceEnter as AblyRoomChannel["presence"]["enter"]),
          update: bindProviderMethod(presence, presenceUpdate as AblyRoomChannel["presence"]["update"]),
          leave: bindProviderMethod(presence, presenceLeave as AblyRoomChannel["presence"]["leave"]),
        },
      });
    }

    return {
      client: {
        channels: {
          get: (name) => {
            for (const grant of granted) {
              if (grant.name === name) {
                const channel = validatedChannels.get(grant.kind);
                if (channel) return channel;
              }
            }
            throw new Error("Realtime client contract is invalid");
          },
        },
        connection: {
          on: bindProviderMethod(connection, on as AblyRealtimeClient["connection"]["on"]),
          off: bindProviderMethod(connection, off as AblyRealtimeClient["connection"]["off"]),
        },
        connect: bindProviderMethod(candidate, connect as AblyRealtimeClient["connect"]),
        close: close as AblyRealtimeClient["close"],
      },
      channels: validatedChannels,
    };
  } catch {
    return undefined;
  }
}

function normalizedConnectionReadyTimeout(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? defaultConnectionReadyTimeoutMs
    : Math.max(1, Math.min(maximumConnectionReadyTimeoutMs, value));
}

function normalizedProviderOperationTimeout(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? defaultProviderOperationTimeoutMs
    : Math.max(1, Math.min(maximumProviderOperationTimeoutMs, value));
}

/**
 * Uses only non-production, exact token capabilities. A client factory is
 * required and injected; no provider object is constructed until connect().
 */
export class DevelopmentAblyRoomTransport implements RealtimeTransportAdapter {
  private readonly options: DevelopmentAblyRoomTransportOptions;
  private readonly clientFactory: AblyClientFactory;
  private readonly timer: AblyConnectionTimer;
  private readonly connectionReadyTimeoutMs: number;
  private readonly providerOperationTimeoutMs: number;
  private readonly publishGovernor: Pick<RealtimePublishGovernor, "acquire">;
  private readonly telemetry: PrivacySafeRealtimeTelemetry;

  constructor(options: DevelopmentAblyRoomTransportOptions) {
    let clientFactory: unknown;
    try {
      clientFactory = options?.clientFactory;
    } catch {
      throw new Error("Realtime client factory is required");
    }
    if (typeof clientFactory !== "function") throw new Error("Realtime client factory is required");
    this.options = options;
    this.clientFactory = clientFactory as AblyClientFactory;
    this.timer = options.timer ?? defaultTimer;
    this.connectionReadyTimeoutMs = normalizedConnectionReadyTimeout(options.connectionReadyTimeoutMs);
    this.providerOperationTimeoutMs = normalizedProviderOperationTimeout(options.providerOperationTimeoutMs);
    this.publishGovernor = options.publishGovernor ?? createRealtimePublishGovernor({
      clock: { now: options.now ?? (() => Date.now()) },
    });
    this.telemetry = options.telemetry ?? disabledRealtimeTelemetry;
  }

  private emitTelemetry(candidate: unknown) {
    try {
      this.telemetry.emit(candidate);
    } catch {
      // Even a nonconforming injected telemetry implementation is nonfatal.
    }
  }

  async connect(input: Parameters<RealtimeTransportAdapter["connect"]>[0]): Promise<RealtimeTransportSubscription> {
    this.emitTelemetry({ event: "connect_requested", state: "connecting" });
    if (this.options.environment === "production") {
      this.emitTelemetry({ event: "connect_failed", reason: "authorization_denied", state: "unauthorized" });
      throw new Error("Realtime Ably transport is unsupported in production");
    }
    const tokenRequest = input.token.tokenRequest;
    if (!isTokenRequest(tokenRequest)) {
      this.emitTelemetry({ event: "connect_failed", reason: "authorization_denied", state: "unauthorized" });
      throw new Error("Realtime token request is malformed");
    }

    let granted: GrantedChannel[];
    try {
      granted = parseCapabilities(tokenRequest, this.options.environment, input.scope);
    } catch (error) {
      this.emitTelemetry({ event: "connect_failed", reason: "capability_denied", state: "unauthorized" });
      throw error;
    }
    let unvalidatedClient: unknown;
    try {
      unvalidatedClient = await awaitBoundedProvider(
        "connection",
        () => this.clientFactory(tokenRequest),
        {
          timer: this.timer,
          timeoutMs: this.providerOperationTimeoutMs,
          undoLateSuccess: (candidate) => closeCapturedProviderClient(
            captureProviderClose(candidate),
            this.timer,
            this.providerOperationTimeoutMs,
          ),
        },
      );
    } catch {
      this.emitTelemetry({ event: "connect_failed", reason: "connection_unavailable", state: "degraded" });
      throw new Error("Realtime client contract is invalid");
    }
    const capturedRawClose = captureProviderClose(unvalidatedClient);
    const validatedProvider = validateProviderClientContract(unvalidatedClient, granted, capturedRawClose);
    if (!validatedProvider) {
      this.emitTelemetry({ event: "connect_failed", reason: "connection_unavailable", state: "degraded" });
      await closeCapturedProviderClient(capturedRawClose, this.timer, this.providerOperationTimeoutMs);
      throw new Error("Realtime client contract is invalid");
    }
    const client = validatedProvider.client;
    const channels = validatedProvider.channels;
    const awaitProviderOperation = <Return>(
      operation: ProviderOperation,
      callback: () => Return | Promise<Return>,
      undoLateSuccess?: () => void | Promise<void>,
    ) => awaitBoundedProvider(operation, callback, {
      timer: this.timer,
      timeoutMs: this.providerOperationTimeoutMs,
      undoOnFailure: undoLateSuccess,
      undoLateSuccess: () => undoLateSuccess?.(),
    });
    const listeners: Array<Readonly<{ channel: AblyRoomChannel; listener: (message: AblyInboundMessage) => void; presence: boolean }>> = [];
    const enteredPresence = new Set<AblyRoomChannel>();
    let closed = false;
    let ready = false;

    const getChannel = (grant: GrantedChannel) => {
      const channel = channels.get(grant.kind);
      if (!channel) throw new Error("Realtime client contract is invalid");
      return channel;
    };
    const connectionFailure = (state: AblyConnectionState) => {
      if (!closed) {
        if (ready) this.emitTelemetry({ event: "connect_failed", reason: "connection_unavailable", state: "degraded" });
        input.onFailure(errorFromConnectionState(state));
      }
    };
    const awaitStartupConnectionOperation = async (
      operation: () => void | Promise<void>,
      undoLateOperation: () => void | Promise<void>,
    ) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            if (error === undefined) resolve();
            else reject(error);
          };
          timer = this.timer.setTimeout(
            () => finish(providerOperationError("connection")),
            this.connectionReadyTimeoutMs,
          );
          void (async () => {
            try {
              await awaitProvider("connection", operation);
              if (settled) {
                try {
                  await awaitProvider("connection", undoLateOperation);
                } catch {
                  // Startup already failed; contain late provider teardown errors.
                }
                return;
              }
              finish();
            } catch (error) {
              finish(error);
            }
          })();
        });
      } finally {
        if (timer !== undefined) this.timer.clearTimeout(timer);
      }
    };
    const waitForConnectionReady = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finish: ((error?: unknown) => void) | undefined;
      let primaryFailure: unknown;
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
          timer = this.timer.setTimeout(() => finish?.(new Error("Realtime connection readiness timed out")), this.connectionReadyTimeoutMs);
          void (async () => {
            const removeLateListener = async (events: string | string[], listener: (state: AblyConnectionState) => void) => {
              try {
                await awaitProvider("connection", () => client.connection.off(events, listener));
              } catch {
                // Startup is already settled; never surface a late teardown failure.
              }
            };
            try {
              if (settled) return;
              await awaitProvider("connection", () => client.connection.on("connected", connected));
              if (settled) {
                await removeLateListener("connected", connected);
                return;
              }
              await awaitProvider("connection", () => client.connection.on(connectionFailureEvents, failed));
              if (settled) {
                await removeLateListener(connectionFailureEvents, failed);
                return;
              }
              await awaitProvider("connection", () => client.connect());
              if (settled) return;
            } catch (error) {
              finish(error);
            }
          })();
        });
      } catch (error) {
        primaryFailure = error;
        throw error;
      } finally {
        if (timer !== undefined) this.timer.clearTimeout(timer);
        let removalFailed = false;
        try {
          await awaitProvider("connection", () => client.connection.off("connected", connected));
        } catch {
          removalFailed = true;
        }
        try {
          await awaitProvider("connection", () => client.connection.off(connectionFailureEvents, failed));
        } catch {
          removalFailed = true;
        }
        if (primaryFailure === undefined && removalFailed) throw providerOperationError("connection");
      }
    };

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      const capture = async (operation: () => void | Promise<void>) => {
        try {
          await awaitProviderOperation("cleanup", operation);
        } catch {
          errors.push(providerOperationError("cleanup"));
        }
      };
      const listenerCleanupOperations: Array<() => void | Promise<void>> = [
        () => client.connection.off(connectionFailureEvents, connectionFailure),
      ];
      for (const { channel, listener, presence } of listeners) {
        listenerCleanupOperations.push(() => presence ? channel.presence.unsubscribe(listener) : channel.unsubscribe(listener));
      }
      await Promise.all(listenerCleanupOperations.map(capture));

      await Promise.all([...enteredPresence].map((channel) => capture(() => channel.presence.leave())));
      await Promise.all([...channels.values()].map((channel) => capture(() => channel.detach())));
      await capture(() => client.close());
      this.emitTelemetry({ event: "cleanup", state: "stopped", subscriptions: listeners.length });
      if (errors[0] !== undefined) throw errors[0];
    };

    try {
      await awaitStartupConnectionOperation(
        () => client.connection.on(connectionFailureEvents, connectionFailure),
        () => client.connection.off(connectionFailureEvents, connectionFailure),
      );
      for (const grant of granted) {
        const channel = getChannel(grant);
        if (!grant.operations.has("subscribe")) continue;
        const listener = (message: AblyInboundMessage) => {
          if (closed) return;
          if (isExactFamilyMessage(message.data, grant.kind, input.scope, this.options.now?.() ?? Date.now(), message.clientId)) {
            const envelope = message.data;
            this.emitTelemetry({ event: "signal_received", kind: envelope.kind, family: grant.kind });
            input.onMessage(envelope);
          } else {
            this.emitTelemetry({ event: "signal_dropped", reason: "malformed", family: grant.kind });
          }
        };
        if (grant.kind === "presence") {
          await awaitProviderOperation(
            "subscription",
            () => channel.presence.subscribe(listener),
            () => channel.presence.unsubscribe(listener),
          );
          listeners.push({ channel, listener, presence: true });
        } else {
          await awaitProviderOperation(
            "subscription",
            () => channel.subscribe(listener),
            () => channel.unsubscribe(listener),
          );
          listeners.push({ channel, listener, presence: false });
        }
      }
      await waitForConnectionReady();
      ready = true;
      this.emitTelemetry({ event: "connect_ready", state: "live", subscriptions: listeners.length });
    } catch (error) {
      this.emitTelemetry({ event: "connect_failed", reason: "connection_unavailable", state: "degraded" });
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
        if (closed) {
          this.emitTelemetry({ event: "signal_dropped", reason: "closed" });
          throw new Error("Realtime transport is closed");
        }
        if (!isExactFamilyMessage(
          message,
          targetForMessage(message) ?? "world",
          input.scope,
          this.options.now?.() ?? Date.now(),
          tokenRequest.clientId,
        )) {
          this.emitTelemetry({ event: "signal_dropped", reason: "malformed" });
          throw new Error("Realtime message is outside the active scope or family");
        }
        const target = targetForMessage(message);
        if (!target) throw new Error("Realtime message kind is unsupported");
        const grant = granted.find((candidate) => candidate.kind === target);
        if (!grant) {
          this.emitTelemetry({ event: "signal_dropped", reason: "capability_denied", kind: message.kind, family: target });
          throw new Error("Realtime message channel is not granted");
        }
        const channel = getChannel(grant);
        if (target === "presence" && !grant.operations.has("presence")) {
          this.emitTelemetry({ event: "signal_dropped", reason: "capability_denied", kind: message.kind, family: target });
          throw new Error("Realtime presence is not granted");
        }
        if (target !== "presence" && !grant.operations.has("publish")) {
          this.emitTelemetry({ event: "signal_dropped", reason: "capability_denied", kind: message.kind, family: target });
          throw new Error("Realtime publish is not granted");
        }
        const governorDecision = this.publishGovernor.acquire({
          missionId: message.missionId,
          roomId: message.roomId ?? "",
          sender: message.sender,
          kind: message.kind,
        });
        if (!governorDecision.allowed) {
          this.emitTelemetry({ event: "governor_limited", reason: "rate_limited", kind: message.kind, family: target });
          throw new RealtimePublishRateLimitError(governorDecision.retryAfterMs);
        }
        if (target === "presence") {
          if (message.kind === "presence.leave") {
            if (enteredPresence.has(channel)) {
              await awaitProviderOperation("publish", () => channel.presence.leave(message));
              enteredPresence.delete(channel);
              this.emitTelemetry({ event: "signal_published", kind: message.kind, family: target });
            }
            return;
          }
          if (enteredPresence.has(channel)) {
            try {
              await awaitProviderOperation(
                "publish",
                () => channel.presence.update(message),
                () => channel.presence.leave(),
              );
            } catch (error) {
              throw error;
            }
          } else {
            await awaitProviderOperation(
              "publish",
              () => channel.presence.enter(message),
              () => channel.presence.leave(),
            );
            enteredPresence.add(channel);
          }
          this.emitTelemetry({ event: "signal_published", kind: message.kind, family: target });
          return;
        }
        await awaitProviderOperation("publish", () => channel.publish(message.kind, message));
        this.emitTelemetry({ event: "signal_published", kind: message.kind, family: target });
      },
    };
  }
}

export function createDevelopmentAblyRoomTransport(options: DevelopmentAblyRoomTransportOptions) {
  return new DevelopmentAblyRoomTransport(options);
}
