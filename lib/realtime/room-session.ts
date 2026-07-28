import { parseRealtimePayload } from "./message-schema";
import { RealtimePublishRateLimitError } from "./signal-governor";

/**
 * Provider-independent lifecycle for disposable room signals.
 *
 * It intentionally has no Convex or Ably dependency and never writes durable
 * state. Durable screens must continue to work when this session is degraded.
 */

export type RoomSessionState = "idle" | "connecting" | "live" | "degraded" | "reconnecting" | "unauthorized" | "stopped";

export type RealtimeRoomScope = Readonly<{ missionId: string; roomId: string }>;

export type RealtimeToken = Readonly<{
  tokenRequest: unknown;
  expiresAt: number;
  authorizationVersion: number;
}>;

export type RealtimeEnvelope<TPayload = unknown> = Readonly<{
  v: 1;
  kind: string;
  messageId: string;
  sender: Readonly<{
    clientId: string;
    clientInstanceId: string;
    connectionEpoch: number;
  }>;
  missionId: string;
  roomId?: string;
  issuedAtMs: number;
  expiresAtMs: number;
  clientSeq: number;
  payload: TPayload;
}>;

export type RealtimeTransportSubscription = Readonly<{
  unsubscribe: () => void | Promise<void>;
  publish?: (message: RealtimeEnvelope) => void | Promise<void>;
}>;

export type RealtimeTransportAdapter = Readonly<{
  connect: (input: Readonly<{
    scope: RealtimeRoomScope;
    token: RealtimeToken;
    connectionEpoch: number;
    onMessage: (message: unknown) => void;
    onFailure: (error: unknown) => void;
  }>) => Promise<RealtimeTransportSubscription>;
}>;

export type RealtimeTokenProvider = (scope: RealtimeRoomScope) => Promise<RealtimeToken>;

export type RealtimeClock = Readonly<{
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}>;

export type RoomSessionOptions = Readonly<{
  tokenProvider: RealtimeTokenProvider;
  transport: RealtimeTransportAdapter;
  onStateChange?: (state: RoomSessionState) => void;
  onMessage?: (message: RealtimeEnvelope) => void;
  onTransientMessageExpired?: (message: RealtimeEnvelope) => void;
  onTransientStateCleared?: (reason: "authorization-changed" | "reconnect" | "scope-changed" | "stopped") => void;
  onTransportFailure?: (error: unknown) => void;
  clock?: RealtimeClock;
  tokenAcquisitionTimeoutMs?: number;
  transportConnectionTimeoutMs?: number;
  refreshSkewMs?: number;
  minimumRefreshDelayMs?: number;
  reconnectDelayMs?: (attempt: number) => number;
  random?: () => number;
  maxReconnectAttempts?: number;
  maxMessageTtlMs?: number;
  maxFutureIssuedAtMs?: number;
  maxSerializedPayloadBytes?: number;
  maxTrackedMessageIds?: number;
  maxTrackedSenderStreams?: number;
  isUnauthorizedError?: (error: unknown) => boolean;
}>;

export type RealtimeMessageDecision = "accepted" | "duplicate" | "expired" | "malformed" | "out-of-scope" | "stale-epoch" | "stale-sequence" | "capacity" | "inactive";

const defaultClock: RealtimeClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};
const defaultRefreshSkewMs = 30_000;
const defaultMinimumRefreshDelayMs = 1_000;
const defaultTokenAcquisitionTimeoutMs = 10_000;
const maximumTokenAcquisitionTimeoutMs = 30_000;
const defaultTransportConnectionTimeoutMs = 10_000;
const maximumTransportConnectionTimeoutMs = 30_000;
const maximumReconnectDelayMs = 30_000;
const defaultMaxReconnectAttempts = 5;
const defaultMaxMessageTtlMs = 45_000;
const defaultMaxFutureIssuedAtMs = 5_000;
const defaultMaxSerializedPayloadBytes = 2_048;
const defaultMaxTrackedMessageIds = 4_096;
const maximumMaxTrackedMessageIds = 10_000;
const defaultMaxTrackedSenderStreams = 512;
const maximumMaxTrackedSenderStreams = 2_048;

function normalizedNonNegative(value: number | undefined, fallback: number) {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value);
}

function normalizedPositive(value: number | undefined, fallback: number) {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, value);
}

function normalizedAttemptLimit(value: number | undefined, fallback: number) {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

function normalizedBoundedPositive(value: number | undefined, fallback: number, maximum: number) {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(maximum, Math.max(1, Math.floor(value)));
}

function boundedRandom(random: () => number) {
  try {
    const value = random();
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
  } catch {
    return 0.5;
  }
}

function defaultReconnectDelay(attempt: number, random: () => number) {
  const cappedBase = Math.min(maximumReconnectDelayMs, 500 * (2 ** Math.min(attempt, 6)));
  return Math.min(maximumReconnectDelayMs, Math.floor(cappedBase * (0.75 + (0.5 * boundedRandom(random)))));
}

function defaultUnauthorizedError(error: unknown) {
  return error instanceof Error && (error.name === "RealtimeUnauthorizedError" || error.message === "Unauthorized" || error.message === "Not found");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function snapshotRealtimeToken(value: unknown): RealtimeToken | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const tokenRequest = value.tokenRequest;
    const expiresAt = value.expiresAt;
    const authorizationVersion = value.authorizationVersion;
    if (!isFiniteNumber(expiresAt) || !isFiniteNumber(authorizationVersion)) return undefined;
    return { tokenRequest, expiresAt, authorizationVersion };
  } catch {
    return undefined;
  }
}

function snapshotTransportSubscription(value: unknown): RealtimeTransportSubscription | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const unsubscribe = value.unsubscribe;
    if (typeof unsubscribe !== "function") return undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return Promise.resolve();
      disposed = true;
      try {
        return Promise.resolve(Reflect.apply(unsubscribe, value, [])).catch(() => {
          throw new Error("Realtime transport disposal failed");
        });
      } catch {
        return Promise.reject(new Error("Realtime transport disposal failed"));
      }
    };
    let publish: unknown;
    try {
      publish = value.publish;
    } catch {
      void dispose().catch(() => undefined);
      return undefined;
    }
    if (publish !== undefined && typeof publish !== "function") {
      void dispose().catch(() => undefined);
      return undefined;
    }
    return {
      unsubscribe: dispose,
      publish: publish === undefined
        ? undefined
        : (message) => {
          try {
            return Promise.resolve(Reflect.apply(publish, value, [message])).catch((error: unknown) => {
              if (error instanceof RealtimePublishRateLimitError) throw error;
              throw new Error("Realtime transport publish failed");
            });
          } catch (error) {
            if (error instanceof RealtimePublishRateLimitError) throw error;
            return Promise.reject(new Error("Realtime transport publish failed"));
          }
        },
    };
  } catch {
    return undefined;
  }
}

function disposeLateTransportSubscription(subscription: RealtimeTransportSubscription) {
  try {
    void Promise.resolve(subscription.unsubscribe()).catch(() => undefined);
  } catch {
    // A late subscription is never active and provider disposal stays contained.
  }
}

function hasSerializedPayloadWithinLimit(value: unknown, maxBytes: number) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && new TextEncoder().encode(serialized).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

function appearsExpired(value: unknown, now: number) {
  try {
    return isRecord(value) && typeof value.expiresAtMs === "number" && value.expiresAtMs <= now;
  } catch {
    return false;
  }
}

function parseEnvelope(
  value: unknown,
  now: number,
  limits: Readonly<{ maxMessageTtlMs: number; maxFutureIssuedAtMs: number; maxSerializedPayloadBytes: number }>,
): RealtimeEnvelope | undefined {
  try {
    return parseEnvelopeUnchecked(value, now, limits);
  } catch {
    return undefined;
  }
}

/**
 * Conservative public boundary for transport adapters that may be invoked
 * independently of a room session.
 */
export function validateRealtimeEnvelope(value: unknown, now: number = Date.now()): RealtimeEnvelope | undefined {
  return parseEnvelope(value, now, {
    maxMessageTtlMs: defaultMaxMessageTtlMs,
    maxFutureIssuedAtMs: defaultMaxFutureIssuedAtMs,
    maxSerializedPayloadBytes: defaultMaxSerializedPayloadBytes,
  });
}

function parseEnvelopeUnchecked(
  value: unknown,
  now: number,
  limits: Readonly<{ maxMessageTtlMs: number; maxFutureIssuedAtMs: number; maxSerializedPayloadBytes: number }>,
): RealtimeEnvelope | undefined {
  if (!isRecord(value) || !isRecord(value.sender)) return undefined;
  const sender = value.sender;
  const issuedAtMs = value.issuedAtMs;
  const expiresAtMs = value.expiresAtMs;
  const clientSeq = value.clientSeq;
  const connectionEpoch = sender.connectionEpoch;
  if (value.v !== 1
    || !isNonEmptyString(value.kind)
    || !isNonEmptyString(value.messageId)
    || !isNonEmptyString(value.missionId)
    || (value.roomId !== undefined && typeof value.roomId !== "string")
    || !isNonEmptyString(sender.clientId)
    || !isNonEmptyString(sender.clientInstanceId)
    || !isFiniteNumber(connectionEpoch) || !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 0
    || !isFiniteNumber(clientSeq) || !Number.isSafeInteger(clientSeq) || clientSeq < 0
    || !isFiniteNumber(issuedAtMs) || !isFiniteNumber(expiresAtMs)
    || issuedAtMs > now + limits.maxFutureIssuedAtMs
    || expiresAtMs < issuedAtMs
    || expiresAtMs - issuedAtMs > limits.maxMessageTtlMs
    || expiresAtMs <= now
    || !hasSerializedPayloadWithinLimit(value.payload, limits.maxSerializedPayloadBytes)) return undefined;
  return value as RealtimeEnvelope;
}

/**
 * A room session has one active Mission/room at a time. All connection work is
 * best effort: errors transition its state but are not thrown to durable paths.
 */
export class RealtimeRoomSession {
  private readonly clock: RealtimeClock;
  private readonly tokenAcquisitionTimeoutMs: number;
  private readonly transportConnectionTimeoutMs: number;
  private readonly refreshSkewMs: number;
  private readonly minimumRefreshDelayMs: number;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly maxReconnectAttempts: number;
  private readonly maxMessageTtlMs: number;
  private readonly maxFutureIssuedAtMs: number;
  private readonly maxSerializedPayloadBytes: number;
  private readonly maxTrackedMessageIds: number;
  private readonly maxTrackedSenderStreams: number;
  private readonly isUnauthorizedError: (error: unknown) => boolean;
  private stateValue: RoomSessionState = "idle";
  private scopeValue: RealtimeRoomScope | undefined;
  private subscription: RealtimeTransportSubscription | undefined;
  private token: RealtimeToken | undefined;
  private generation = 0;
  private reconnectAttempt = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectInFlight: Promise<void> | undefined;
  private cancelTokenAcquisition: (() => void) | undefined;
  private cancelTransportConnection: (() => void) | undefined;
  private readonly seenMessageExpiry = new Map<string, number>();
  private readonly messageExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly senderEpoch = new Map<string, number>();
  private readonly senderSequence = new Map<string, number>();

  constructor(private readonly options: RoomSessionOptions) {
    this.clock = options.clock ?? defaultClock;
    this.tokenAcquisitionTimeoutMs = normalizedBoundedPositive(
      options.tokenAcquisitionTimeoutMs,
      defaultTokenAcquisitionTimeoutMs,
      maximumTokenAcquisitionTimeoutMs,
    );
    this.transportConnectionTimeoutMs = normalizedBoundedPositive(
      options.transportConnectionTimeoutMs,
      defaultTransportConnectionTimeoutMs,
      maximumTransportConnectionTimeoutMs,
    );
    this.refreshSkewMs = normalizedNonNegative(options.refreshSkewMs, defaultRefreshSkewMs);
    this.minimumRefreshDelayMs = normalizedPositive(options.minimumRefreshDelayMs, defaultMinimumRefreshDelayMs);
    const random = options.random ?? Math.random;
    this.reconnectDelayMs = options.reconnectDelayMs ?? ((attempt) => defaultReconnectDelay(attempt, random));
    this.maxReconnectAttempts = normalizedAttemptLimit(options.maxReconnectAttempts, defaultMaxReconnectAttempts);
    this.maxMessageTtlMs = normalizedPositive(options.maxMessageTtlMs, defaultMaxMessageTtlMs);
    this.maxFutureIssuedAtMs = normalizedNonNegative(options.maxFutureIssuedAtMs, defaultMaxFutureIssuedAtMs);
    this.maxSerializedPayloadBytes = normalizedPositive(options.maxSerializedPayloadBytes, defaultMaxSerializedPayloadBytes);
    this.maxTrackedMessageIds = normalizedBoundedPositive(options.maxTrackedMessageIds, defaultMaxTrackedMessageIds, maximumMaxTrackedMessageIds);
    this.maxTrackedSenderStreams = normalizedBoundedPositive(options.maxTrackedSenderStreams, defaultMaxTrackedSenderStreams, maximumMaxTrackedSenderStreams);
    this.isUnauthorizedError = options.isUnauthorizedError ?? defaultUnauthorizedError;
  }

  get state() {
    return this.stateValue;
  }

  get scope() {
    return this.scopeValue;
  }

  async start(scope: RealtimeRoomScope): Promise<void> {
    if (this.scopeValue && (this.scopeValue.missionId !== scope.missionId || this.scopeValue.roomId !== scope.roomId)) {
      await this.stopInternal("scope-changed", "idle");
    }
    if (this.scopeValue && this.stateValue === "live") return;
    this.scopeValue = scope;
    await this.requestConnect("connecting");
  }

  async stop(): Promise<void> {
    await this.stopInternal("stopped", "stopped");
  }

  async refresh(): Promise<void> {
    if (!this.scopeValue || this.stateValue === "stopped" || this.stateValue === "unauthorized") return;
    await this.requestConnect("connecting");
  }

  /** Returns false rather than throwing when the transient channel is unavailable. */
  async publish(message: RealtimeEnvelope): Promise<boolean> {
    if (!this.subscription?.publish || this.stateValue !== "live" || !this.token || this.token.expiresAt <= this.clock.now()) return false;
    const validated = parseEnvelope(message, this.clock.now(), {
      maxMessageTtlMs: this.maxMessageTtlMs,
      maxFutureIssuedAtMs: this.maxFutureIssuedAtMs,
      maxSerializedPayloadBytes: this.maxSerializedPayloadBytes,
    });
    if (!validated || validated.missionId !== this.scopeValue?.missionId || validated.roomId !== this.scopeValue.roomId) return false;
    const payload = parseRealtimePayload(validated.kind, validated.payload);
    if (!payload) return false;
    const typedMessage = { ...validated, payload };
    try {
      await this.subscription.publish(typedMessage);
      return true;
    } catch (error) {
      if (error instanceof RealtimePublishRateLimitError) return false;
      this.handleFailure(error, this.generation);
      return false;
    }
  }

  private setState(next: RoomSessionState) {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.options.onStateChange?.(next);
  }

  private clearTimers() {
    if (this.refreshTimer) this.clock.clearTimeout(this.refreshTimer);
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.refreshTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private clearTransient(reason: "authorization-changed" | "reconnect" | "scope-changed" | "stopped") {
    for (const timer of this.messageExpiryTimers.values()) this.clock.clearTimeout(timer);
    this.seenMessageExpiry.clear();
    this.messageExpiryTimers.clear();
    this.senderEpoch.clear();
    this.senderSequence.clear();
    this.options.onTransientStateCleared?.(reason);
  }

  private detachSubscription(subscription = this.subscription) {
    if (!subscription) return;
    if (subscription === this.subscription) this.subscription = undefined;
    try {
      const result = subscription.unsubscribe();
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((error: unknown) => this.options.onTransportFailure?.(error));
      }
    } catch (error) {
      this.options.onTransportFailure?.(error);
    }
  }

  private async stopInternal(reason: "scope-changed" | "stopped", nextState: RoomSessionState) {
    this.cancelTokenAcquisition?.();
    this.cancelTransportConnection?.();
    this.generation += 1;
    // A prior token/connect promise may still settle, but its generation is
    // invalid. Do not let it monopolize the next room's connection slot.
    this.connectInFlight = undefined;
    this.clearTimers();
    const previous = this.subscription;
    this.token = undefined;
    this.scopeValue = undefined;
    this.reconnectAttempt = 0;
    this.clearTransient(reason);
    this.setState(nextState);
    this.detachSubscription(previous);
  }

  private requestConnect(nextState: "connecting" | "reconnecting") {
    if (this.connectInFlight) return this.connectInFlight;
    const attempt = this.connect(nextState);
    this.connectInFlight = attempt;
    void attempt.finally(() => {
      if (this.connectInFlight === attempt) this.connectInFlight = undefined;
    });
    return attempt;
  }

  private acquireToken(scope: RealtimeRoomScope): Promise<RealtimeToken> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    return new Promise<RealtimeToken>((resolve, reject) => {
      const finish = (error?: Error, token?: RealtimeToken) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clock.clearTimeout(timer);
        if (this.cancelTokenAcquisition === cancel) this.cancelTokenAcquisition = undefined;
        if (error) reject(error);
        else resolve(token as RealtimeToken);
      };
      const cancel = () => finish(new Error("Realtime token acquisition cancelled"));
      this.cancelTokenAcquisition = cancel;
      timer = this.clock.setTimeout(
        () => finish(new Error("Realtime token acquisition timed out")),
        this.tokenAcquisitionTimeoutMs,
      );
      let tokenPromise: Promise<RealtimeToken>;
      try {
        tokenPromise = Promise.resolve(this.options.tokenProvider(scope));
      } catch {
        finish(new Error("Realtime token acquisition failed"));
        return;
      }
      void tokenPromise.then(
        (candidate) => {
          if (settled) return;
          const token = snapshotRealtimeToken(candidate);
          if (!token) {
            finish(new Error("Realtime token acquisition failed"));
            return;
          }
          finish(undefined, token);
        },
        () => finish(new Error("Realtime token acquisition failed")),
      );
    });
  }

  private acquireTransportSubscription(input: Parameters<RealtimeTransportAdapter["connect"]>[0]): Promise<RealtimeTransportSubscription> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    return new Promise<RealtimeTransportSubscription>((resolve, reject) => {
      const finish = (error?: Error, subscription?: RealtimeTransportSubscription) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clock.clearTimeout(timer);
        if (this.cancelTransportConnection === cancel) this.cancelTransportConnection = undefined;
        if (error) reject(error);
        else resolve(subscription as RealtimeTransportSubscription);
      };
      const cancel = () => finish(new Error("Realtime transport connection cancelled"));
      this.cancelTransportConnection = cancel;
      timer = this.clock.setTimeout(
        () => finish(new Error("Realtime transport connection timed out")),
        this.transportConnectionTimeoutMs,
      );
      let connectionPromise: Promise<RealtimeTransportSubscription>;
      try {
        connectionPromise = Promise.resolve(this.options.transport.connect(input));
      } catch {
        finish(new Error("Realtime transport connection failed"));
        return;
      }
      void connectionPromise.then(
        (candidate) => {
          const subscription = snapshotTransportSubscription(candidate);
          if (settled) {
            if (subscription) disposeLateTransportSubscription(subscription);
            return;
          }
          if (!subscription) {
            finish(new Error("Realtime transport connection failed"));
            return;
          }
          finish(undefined, subscription);
        },
        () => finish(new Error("Realtime transport connection failed")),
      );
    });
  }

  private async connect(nextState: "connecting" | "reconnecting") {
    const scope = this.scopeValue;
    if (!scope) return;
    this.clearTimers();
    const generation = ++this.generation;
    const previous = this.subscription;
    if (previous) {
      this.clearTransient("reconnect");
      this.detachSubscription(previous);
    }
    this.setState(nextState);
    try {
      const token = await this.acquireToken(scope);
      if (generation !== this.generation || this.scopeValue !== scope) return;
      if (!Number.isFinite(token.expiresAt) || token.expiresAt <= this.clock.now()) throw new Error("Realtime token is expired");
      const authorizationChanged = this.token !== undefined && this.token.authorizationVersion !== token.authorizationVersion;
      this.token = token;
      if (authorizationChanged) this.clearTransient("authorization-changed");
      const subscription = await this.acquireTransportSubscription({
        scope,
        token,
        connectionEpoch: generation,
        onMessage: (message) => {
          if (generation !== this.generation) return;
          const accepted = this.acceptMessage(message);
          if (typeof accepted !== "string") this.options.onMessage?.(accepted);
        },
        onFailure: (error) => this.handleFailure(error, generation),
      });
      if (generation !== this.generation || this.scopeValue !== scope) {
        this.detachSubscription(subscription);
        return;
      }
      this.subscription = subscription;
      this.reconnectAttempt = 0;
      this.setState("live");
      this.scheduleRefresh(token, generation);
    } catch (error) {
      this.handleFailure(error, generation);
    }
  }

  private scheduleRefresh(token: RealtimeToken, generation: number) {
    const delay = Math.max(this.minimumRefreshDelayMs, token.expiresAt - this.clock.now() - this.refreshSkewMs);
    this.refreshTimer = this.clock.setTimeout(() => {
      if (generation !== this.generation || this.stateValue !== "live") return;
      void this.refresh();
    }, delay);
  }

  private handleFailure(error: unknown, generation: number) {
    if (generation !== this.generation || this.stateValue === "stopped") return;
    this.options.onTransportFailure?.(error);
    const failureGeneration = ++this.generation;
    this.detachSubscription();
    this.clearTimers();
    if (this.isUnauthorizedError(error)) {
      this.token = undefined;
      this.clearTransient("authorization-changed");
      this.setState("unauthorized");
      return;
    }
    this.setState("degraded");
    if (this.reconnectAttempt >= this.maxReconnectAttempts) return;
    let requestedDelay: number;
    try {
      requestedDelay = this.reconnectDelayMs(this.reconnectAttempt);
    } catch {
      requestedDelay = maximumReconnectDelayMs;
    }
    const delay = Number.isFinite(requestedDelay) ? Math.max(0, Math.min(maximumReconnectDelayMs, requestedDelay)) : maximumReconnectDelayMs;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.clock.setTimeout(() => {
      if (failureGeneration !== this.generation || !this.scopeValue || this.stateValue === "stopped") return;
      this.setState("reconnecting");
      void this.requestConnect("reconnecting");
    }, delay);
  }

  private acceptMessage(value: unknown): RealtimeEnvelope | Exclude<RealtimeMessageDecision, "accepted"> {
    const now = this.clock.now();
    if (this.stateValue !== "live" || !this.scopeValue) return "inactive";
    const message = parseEnvelope(value, now, {
      maxMessageTtlMs: this.maxMessageTtlMs,
      maxFutureIssuedAtMs: this.maxFutureIssuedAtMs,
      maxSerializedPayloadBytes: this.maxSerializedPayloadBytes,
    });
    if (!message) return appearsExpired(value, now) ? "expired" : "malformed";
    if (message.missionId !== this.scopeValue.missionId || message.roomId !== this.scopeValue.roomId) return "out-of-scope";
    const payload = parseRealtimePayload(message.kind, message.payload);
    if (!payload) return "malformed";
    const typedMessage = { ...message, payload };
    this.evictExpiredMessageIds(now);
    if (this.seenMessageExpiry.has(typedMessage.messageId)) return "duplicate";
    if (this.seenMessageExpiry.size >= this.maxTrackedMessageIds) return "capacity";
    const senderKey = `${typedMessage.sender.clientId}:${typedMessage.sender.clientInstanceId}`;
    const priorEpoch = this.senderEpoch.get(senderKey);
    if (priorEpoch !== undefined && typedMessage.sender.connectionEpoch < priorEpoch) return "stale-epoch";
    const sequenceKey = `${senderKey}:${typedMessage.sender.connectionEpoch}:${typedMessage.kind}`;
    const priorSequence = this.senderSequence.get(sequenceKey);
    if (priorEpoch === typedMessage.sender.connectionEpoch && priorSequence !== undefined && typedMessage.clientSeq <= priorSequence) return "stale-sequence";
    if (priorEpoch === undefined && this.senderEpoch.size >= this.maxTrackedSenderStreams) {
      const oldestSenderKey = this.senderEpoch.keys().next().value as string | undefined;
      if (oldestSenderKey !== undefined) {
        this.senderEpoch.delete(oldestSenderKey);
        for (const key of this.senderSequence.keys()) {
          if (key.startsWith(`${oldestSenderKey}:`)) this.senderSequence.delete(key);
        }
      }
    }
    if (priorEpoch === undefined || typedMessage.sender.connectionEpoch > priorEpoch) {
      this.senderEpoch.set(senderKey, typedMessage.sender.connectionEpoch);
      for (const key of this.senderSequence.keys()) {
        if (key.startsWith(`${senderKey}:`)) this.senderSequence.delete(key);
      }
    }
    // Keep insertion order as least-recently-used for bounded stream eviction.
    this.senderEpoch.delete(senderKey);
    this.senderEpoch.set(senderKey, typedMessage.sender.connectionEpoch);
    this.senderSequence.set(sequenceKey, typedMessage.clientSeq);
    this.seenMessageExpiry.set(typedMessage.messageId, typedMessage.expiresAtMs);
    this.scheduleMessageExpiry(typedMessage);
    return typedMessage;
  }

  private scheduleMessageExpiry(message: RealtimeEnvelope) {
    const delay = Math.max(0, message.expiresAtMs - this.clock.now());
    const timer = this.clock.setTimeout(() => {
      if (this.seenMessageExpiry.get(message.messageId) !== message.expiresAtMs) return;
      this.seenMessageExpiry.delete(message.messageId);
      this.messageExpiryTimers.delete(message.messageId);
      this.options.onTransientMessageExpired?.(message);
    }, delay);
    this.messageExpiryTimers.set(message.messageId, timer);
  }

  private evictExpiredMessageIds(now: number) {
    for (const [messageId, expiresAt] of this.seenMessageExpiry) {
      if (expiresAt <= now) {
        this.seenMessageExpiry.delete(messageId);
        const timer = this.messageExpiryTimers.get(messageId);
        if (timer) this.clock.clearTimeout(timer);
        this.messageExpiryTimers.delete(messageId);
      }
    }
  }
}
