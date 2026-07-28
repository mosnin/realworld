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
  transportDisposalTimeoutMs?: number;
  transportPublishTimeoutMs?: number;
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

function snapshotClock(options: RoomSessionOptions): RealtimeClock {
  try {
    const clock = options.clock;
    if (clock === undefined) return defaultClock;
    if ((typeof clock !== "object" && typeof clock !== "function") || clock === null) return defaultClock;
    const now = clock.now;
    const setTimeout = clock.setTimeout;
    const clearTimeout = clock.clearTimeout;
    if (typeof now !== "function" || typeof setTimeout !== "function" || typeof clearTimeout !== "function") return defaultClock;
    type TimerGuard = { active: boolean; handle: unknown; usesDefaultClock: boolean };
    const guardsByHandle = new Map<unknown, Set<TimerGuard>>();
    const unregister = (guard: TimerGuard) => {
      const guards = guardsByHandle.get(guard.handle);
      if (!guards) return;
      guards.delete(guard);
      if (guards.size === 0) guardsByHandle.delete(guard.handle);
    };
    const deactivate = (guard: TimerGuard) => {
      if (!guard.active) return;
      guard.active = false;
      unregister(guard);
    };
    const schedule = (callback: () => void, delayMs: number, usesDefaultClock: boolean): ReturnType<typeof setTimeout> => {
      const guard: TimerGuard = { active: true, handle: undefined, usesDefaultClock };
      const wrapped = () => {
        if (!guard.active) return;
        deactivate(guard);
        callback();
      };
      let handle: ReturnType<typeof setTimeout>;
      try {
        handle = usesDefaultClock
          ? defaultClock.setTimeout(wrapped, delayMs)
          : Reflect.apply(setTimeout, clock, [wrapped, delayMs]) as ReturnType<typeof setTimeout>;
      } catch (error) {
        deactivate(guard);
        throw error;
      }
      guard.handle = handle;
      if (guard.active) {
        const guards = guardsByHandle.get(handle) ?? new Set<TimerGuard>();
        guards.add(guard);
        guardsByHandle.set(handle, guards);
      }
      return handle;
    };
    return {
      now: () => {
        try {
          const value = Reflect.apply(now, clock, []);
          return typeof value === "number" && Number.isFinite(value) ? value : defaultClock.now();
        } catch {
          return defaultClock.now();
        }
      },
      setTimeout: (callback, delayMs) => {
        try {
          return schedule(callback, delayMs, false);
        } catch {
          return schedule(callback, delayMs, true);
        }
      },
      clearTimeout: (timer) => {
        const guards = guardsByHandle.get(timer);
        const usesDefaultClock = guards !== undefined && [...guards].some((guard) => guard.usesDefaultClock);
        if (guards) for (const guard of [...guards]) deactivate(guard);
        try {
          if (usesDefaultClock) defaultClock.clearTimeout(timer);
          else Reflect.apply(clearTimeout, clock, [timer]);
        } catch {
          defaultClock.clearTimeout(timer);
        }
      },
    };
  } catch {
    return defaultClock;
  }
}
const defaultRefreshSkewMs = 30_000;
const defaultMinimumRefreshDelayMs = 1_000;
const defaultTokenAcquisitionTimeoutMs = 10_000;
const maximumTokenAcquisitionTimeoutMs = 30_000;
const defaultTransportConnectionTimeoutMs = 10_000;
const maximumTransportConnectionTimeoutMs = 30_000;
const defaultTransportDisposalTimeoutMs = 10_000;
const maximumTransportDisposalTimeoutMs = 30_000;
const defaultTransportPublishTimeoutMs = 10_000;
const maximumTransportPublishTimeoutMs = 30_000;
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

function snapshotBoundedPositive(read: () => unknown, fallback: number, maximum: number) {
  try {
    const value = read();
    if (typeof value === "number") return normalizedBoundedPositive(value, fallback, maximum);
    observeAsyncResult(value);
    return fallback;
  } catch {
    return fallback;
  }
}

function snapshotNonNegative(read: () => unknown, fallback: number) {
  try {
    const value = read();
    if (typeof value === "number") return normalizedNonNegative(value, fallback);
    observeAsyncResult(value);
    return fallback;
  } catch {
    return fallback;
  }
}

function snapshotPositive(read: () => unknown, fallback: number) {
  try {
    const value = read();
    if (typeof value === "number") return normalizedPositive(value, fallback);
    observeAsyncResult(value);
    return fallback;
  } catch {
    return fallback;
  }
}

function snapshotAttemptLimit(read: () => unknown, fallback: number) {
  try {
    const value = read();
    if (typeof value === "number") return normalizedAttemptLimit(value, fallback);
    observeAsyncResult(value);
    return fallback;
  } catch {
    return fallback;
  }
}

function snapshotRefreshTiming(options: RoomSessionOptions) {
  return {
    refreshSkew: snapshotNonNegative(() => options.refreshSkewMs, defaultRefreshSkewMs),
    minimumRefreshDelay: snapshotPositive(() => options.minimumRefreshDelayMs, defaultMinimumRefreshDelayMs),
  };
}

function snapshotMessageAcceptanceLimits(options: RoomSessionOptions) {
  return {
    maxMessageTtl: snapshotPositive(() => options.maxMessageTtlMs, defaultMaxMessageTtlMs),
    maxFutureIssuedAt: snapshotNonNegative(() => options.maxFutureIssuedAtMs, defaultMaxFutureIssuedAtMs),
    maxSerializedPayloadBytes: snapshotPositive(() => options.maxSerializedPayloadBytes, defaultMaxSerializedPayloadBytes),
  };
}

function snapshotReceiverCacheBounds(options: RoomSessionOptions) {
  return {
    maxTrackedMessageIds: snapshotBoundedPositive(
      () => options.maxTrackedMessageIds,
      defaultMaxTrackedMessageIds,
      maximumMaxTrackedMessageIds,
    ),
    maxTrackedSenderStreams: snapshotBoundedPositive(
      () => options.maxTrackedSenderStreams,
      defaultMaxTrackedSenderStreams,
      maximumMaxTrackedSenderStreams,
    ),
  };
}

function snapshotOperationTimeouts(options: RoomSessionOptions) {
  return {
    tokenAcquisition: snapshotBoundedPositive(
      () => options.tokenAcquisitionTimeoutMs,
      defaultTokenAcquisitionTimeoutMs,
      maximumTokenAcquisitionTimeoutMs,
    ),
    transportConnection: snapshotBoundedPositive(
      () => options.transportConnectionTimeoutMs,
      defaultTransportConnectionTimeoutMs,
      maximumTransportConnectionTimeoutMs,
    ),
    transportDisposal: snapshotBoundedPositive(
      () => options.transportDisposalTimeoutMs,
      defaultTransportDisposalTimeoutMs,
      maximumTransportDisposalTimeoutMs,
    ),
    transportPublish: snapshotBoundedPositive(
      () => options.transportPublishTimeoutMs,
      defaultTransportPublishTimeoutMs,
      maximumTransportPublishTimeoutMs,
    ),
  };
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

function isObjectOrFunction(value: unknown): value is object | ((...args: never[]) => unknown) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function observeAsyncResult(value: unknown) {
  if (!isObjectOrFunction(value)) return;
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // Recovery policy callbacks are synchronous; contain hostile thenables.
  }
}

function synchronousNumber(value: unknown): number {
  if (typeof value === "number") return value;
  observeAsyncResult(value);
  return Number.NaN;
}

function snapshotRandom(options: RoomSessionOptions): () => number {
  try {
    const random = options.random;
    if (typeof random !== "function") {
      return Math.random;
    }

    return () => {
      try {
        return synchronousNumber(Reflect.apply(random, options, []));
      } catch {
        return Math.random();
      }
    };
  } catch {
    return Math.random;
  }
}

function snapshotReconnectDelay(
  options: RoomSessionOptions,
  random: () => number,
): (attempt: number) => number {
  const fallback = (attempt: number) => defaultReconnectDelay(attempt, random);

  try {
    const reconnectDelayMs = options.reconnectDelayMs;
    if (typeof reconnectDelayMs !== "function") {
      return fallback;
    }

    return (attempt) => {
      try {
        const result = Reflect.apply(reconnectDelayMs, options, [attempt]);
        if (typeof result === "number") return result;
        if (isObjectOrFunction(result)) {
          observeAsyncResult(result);
          return fallback(attempt);
        }
        return Number.NaN;
      } catch {
        return fallback(attempt);
      }
    };
  } catch {
    return fallback;
  }
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

function snapshotObserver<Arguments extends unknown[]>(
  receiver: object,
  read: () => unknown,
): ((...args: Arguments) => void) | undefined {
  try {
    const callback = read();
    if (typeof callback !== "function") return undefined;
    return (...args) => {
      try {
        void Promise.resolve(Reflect.apply(callback, receiver, args)).catch(() => undefined);
      } catch {
        // Observers are optional side effects and never control session state.
      }
    };
  } catch {
    return undefined;
  }
}

function invokeUnauthorizedClassifier(classifier: (...args: unknown[]) => unknown, receiver: unknown, error: unknown): boolean {
  let decision: unknown;
  try {
    decision = Reflect.apply(classifier, receiver, [error]);
  } catch {
    return false;
  }
  if (typeof decision === "boolean") return decision;
  if ((typeof decision === "object" && decision !== null) || typeof decision === "function") {
    try {
      void Promise.resolve(decision).catch(() => undefined);
    } catch {
      // Classifier thenables are advisory and never control recovery.
    }
  }
  return false;
}

function snapshotUnauthorizedClassifier(
  receiver: object,
  read: () => unknown,
): (error: unknown) => boolean {
  try {
    const classifier = read();
    if (classifier === undefined) return (error) => invokeUnauthorizedClassifier(defaultUnauthorizedError, undefined, error);
    if (typeof classifier !== "function") return () => false;
    return (error) => invokeUnauthorizedClassifier(classifier as (...args: unknown[]) => unknown, receiver, error);
  } catch {
    return () => false;
  }
}

function rejectedTokenProvider(): Promise<RealtimeToken> {
  return Promise.reject(new Error("Realtime token acquisition failed"));
}

function snapshotTokenProvider(options: RoomSessionOptions): RealtimeTokenProvider {
  try {
    const provider = options.tokenProvider;
    if (typeof provider !== "function") return () => rejectedTokenProvider();
    return (scope) => {
      try {
        return Promise.resolve(Reflect.apply(provider, options, [scope]) as Promise<RealtimeToken>);
      } catch {
        return rejectedTokenProvider();
      }
    };
  } catch {
    return () => rejectedTokenProvider();
  }
}

function rejectedTransportConnection(): Promise<RealtimeTransportSubscription> {
  return Promise.reject(new Error("Realtime transport connection failed"));
}

function snapshotTransportConnect(options: RoomSessionOptions): RealtimeTransportAdapter["connect"] {
  try {
    const transport = options.transport;
    if ((typeof transport !== "object" && typeof transport !== "function") || transport === null) return () => rejectedTransportConnection();
    const connect = transport.connect;
    if (typeof connect !== "function") return () => rejectedTransportConnection();
    return (input) => {
      try {
        return Promise.resolve(Reflect.apply(connect, transport, [input]) as Promise<RealtimeTransportSubscription>);
      } catch {
        return rejectedTransportConnection();
      }
    };
  } catch {
    return () => rejectedTransportConnection();
  }
}

type TransportSubscriptionSnapshot = Readonly<{
  subscription?: RealtimeTransportSubscription;
  disposable?: RealtimeTransportSubscription;
}>;

function snapshotTransportSubscription(value: unknown): TransportSubscriptionSnapshot | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const unsubscribe = value.unsubscribe;
    if (typeof unsubscribe !== "function") return undefined;
    let disposal: Promise<void> | undefined;
    const dispose = () => {
      if (disposal) return disposal;
      try {
        disposal = Promise.resolve(Reflect.apply(unsubscribe, value, [])).catch(() => {
          throw new Error("Realtime transport disposal failed");
        });
      } catch {
        disposal = Promise.reject(new Error("Realtime transport disposal failed"));
      }
      return disposal;
    };
    let publish: unknown;
    try {
      publish = value.publish;
    } catch {
      return { disposable: { unsubscribe: dispose } };
    }
    if (publish !== undefined && typeof publish !== "function") {
      return { disposable: { unsubscribe: dispose } };
    }
    const subscription: RealtimeTransportSubscription = {
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
    return { subscription, disposable: subscription };
  } catch {
    return undefined;
  }
}

function disposeTransportSubscription(
  subscription: RealtimeTransportSubscription,
  clock: RealtimeClock,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = clock.setTimeout(
      () => finish(new Error("Realtime transport disposal timed out")),
      timeoutMs,
    );
    let disposal: void | Promise<void>;
    try {
      disposal = subscription.unsubscribe();
    } catch {
      finish(new Error("Realtime transport disposal failed"));
      return;
    }
    void Promise.resolve(disposal).then(
      () => finish(),
      () => finish(new Error("Realtime transport disposal failed")),
    );
  });
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
  private readonly tokenProvider: RealtimeTokenProvider;
  private readonly transportConnect: RealtimeTransportAdapter["connect"];
  private readonly tokenAcquisitionTimeoutMs: number;
  private readonly transportConnectionTimeoutMs: number;
  private readonly transportDisposalTimeoutMs: number;
  private readonly transportPublishTimeoutMs: number;
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
  private readonly onStateChange: ((state: RoomSessionState) => void) | undefined;
  private readonly onMessage: ((message: RealtimeEnvelope) => void) | undefined;
  private readonly onTransientMessageExpired: ((message: RealtimeEnvelope) => void) | undefined;
  private readonly onTransientStateCleared: ((reason: "authorization-changed" | "reconnect" | "scope-changed" | "stopped") => void) | undefined;
  private readonly onTransportFailure: ((error: unknown) => void) | undefined;
  private stateValue: RoomSessionState = "idle";
  private scopeValue: RealtimeRoomScope | undefined;
  private subscription: RealtimeTransportSubscription | undefined;
  private token: RealtimeToken | undefined;
  private generation = 0;
  private reconnectAttempt = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectInFlight: Promise<void> | undefined;
  private connectRequestSerial = 0;
  private cancelTokenAcquisition: (() => void) | undefined;
  private cancelTransportConnection: (() => void) | undefined;
  private readonly cancelPublications = new Set<() => void>();
  private readonly disposalObservations = new WeakMap<RealtimeTransportSubscription, Promise<void>>();
  private readonly seenMessageExpiry = new Map<string, number>();
  private readonly messageExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly senderEpoch = new Map<string, number>();
  private readonly senderSequence = new Map<string, number>();
  private isNotifyingTransientClear = false;

  constructor(options: RoomSessionOptions) {
    this.tokenProvider = snapshotTokenProvider(options);
    this.transportConnect = snapshotTransportConnect(options);
    const operationTimeouts = snapshotOperationTimeouts(options);
    const refreshTiming = snapshotRefreshTiming(options);
    const messageAcceptanceLimits = snapshotMessageAcceptanceLimits(options);
    const receiverCacheBounds = snapshotReceiverCacheBounds(options);
    this.onStateChange = snapshotObserver(options, () => options.onStateChange);
    this.onMessage = snapshotObserver(options, () => options.onMessage);
    this.onTransientMessageExpired = snapshotObserver(options, () => options.onTransientMessageExpired);
    this.onTransientStateCleared = snapshotObserver(options, () => options.onTransientStateCleared);
    this.onTransportFailure = snapshotObserver(options, () => options.onTransportFailure);
    this.clock = snapshotClock(options);
    this.tokenAcquisitionTimeoutMs = operationTimeouts.tokenAcquisition;
    this.transportConnectionTimeoutMs = operationTimeouts.transportConnection;
    this.transportDisposalTimeoutMs = operationTimeouts.transportDisposal;
    this.transportPublishTimeoutMs = operationTimeouts.transportPublish;
    this.refreshSkewMs = refreshTiming.refreshSkew;
    this.minimumRefreshDelayMs = refreshTiming.minimumRefreshDelay;
    const random = snapshotRandom(options);
    this.reconnectDelayMs = snapshotReconnectDelay(options, random);
    this.maxReconnectAttempts = snapshotAttemptLimit(() => options.maxReconnectAttempts, defaultMaxReconnectAttempts);
    this.maxMessageTtlMs = messageAcceptanceLimits.maxMessageTtl;
    this.maxFutureIssuedAtMs = messageAcceptanceLimits.maxFutureIssuedAt;
    this.maxSerializedPayloadBytes = messageAcceptanceLimits.maxSerializedPayloadBytes;
    this.maxTrackedMessageIds = receiverCacheBounds.maxTrackedMessageIds;
    this.maxTrackedSenderStreams = receiverCacheBounds.maxTrackedSenderStreams;
    this.isUnauthorizedError = snapshotUnauthorizedClassifier(options, () => options.isUnauthorizedError);
  }

  get state() {
    return this.stateValue;
  }

  get scope() {
    return this.scopeValue;
  }

  async start(scope: RealtimeRoomScope): Promise<void> {
    if (this.scopeValue && (this.scopeValue.missionId !== scope.missionId || this.scopeValue.roomId !== scope.roomId)) {
      const handoffCompleted = await this.stopInternal("scope-changed", "idle");
      if (!handoffCompleted) return;
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
    const subscription = this.subscription;
    const scope = this.scopeValue;
    const generation = this.generation;
    if (!subscription?.publish || this.stateValue !== "live" || !this.token || this.token.expiresAt <= this.clock.now()) return false;
    const validated = parseEnvelope(message, this.clock.now(), {
      maxMessageTtlMs: this.maxMessageTtlMs,
      maxFutureIssuedAtMs: this.maxFutureIssuedAtMs,
      maxSerializedPayloadBytes: this.maxSerializedPayloadBytes,
    });
    if (!validated || validated.missionId !== scope?.missionId || validated.roomId !== scope.roomId) return false;
    const payload = parseRealtimePayload(validated.kind, validated.payload);
    if (!payload) return false;
    const typedMessage = { ...validated, payload };
    try {
      await this.publishWithDeadline(() => subscription.publish!(typedMessage));
      return generation === this.generation && scope === this.scopeValue && subscription === this.subscription && this.stateValue === "live";
    } catch (error) {
      if (error instanceof RealtimePublishRateLimitError) return false;
      if (generation === this.generation && scope === this.scopeValue && subscription === this.subscription) {
        this.cancelPendingPublications();
        this.handleFailure(error, generation);
      }
      return false;
    }
  }

  private setState(next: RoomSessionState) {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.onStateChange?.(next);
  }

  private clearTimers() {
    if (this.refreshTimer) this.clock.clearTimeout(this.refreshTimer);
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.refreshTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private cancelPendingPublications() {
    for (const cancel of [...this.cancelPublications]) cancel();
  }

  private clearTransient(reason: "authorization-changed" | "reconnect" | "scope-changed" | "stopped") {
    for (const timer of this.messageExpiryTimers.values()) this.clock.clearTimeout(timer);
    this.seenMessageExpiry.clear();
    this.messageExpiryTimers.clear();
    this.senderEpoch.clear();
    this.senderSequence.clear();
    if (this.isNotifyingTransientClear) return;
    this.isNotifyingTransientClear = true;
    try {
      this.onTransientStateCleared?.(reason);
    } finally {
      this.isNotifyingTransientClear = false;
    }
  }

  private detachSubscription(subscription = this.subscription) {
    if (!subscription) return;
    if (subscription === this.subscription) this.subscription = undefined;
    void this.observeSubscriptionDisposal(subscription).catch(() => undefined);
  }

  private observeSubscriptionDisposal(subscription: RealtimeTransportSubscription): Promise<void> {
    const existing = this.disposalObservations.get(subscription);
    if (existing) return existing;
    const observation = disposeTransportSubscription(subscription, this.clock, this.transportDisposalTimeoutMs);
    this.disposalObservations.set(subscription, observation);
    return observation;
  }

  private async stopInternal(reason: "scope-changed" | "stopped", nextState: RoomSessionState): Promise<boolean> {
    this.cancelTokenAcquisition?.();
    this.cancelTransportConnection?.();
    this.cancelPendingPublications();
    this.generation += 1;
    this.connectRequestSerial += 1;
    const lifecycleGeneration = this.generation;
    const lifecycleRequestSerial = this.connectRequestSerial;
    // A prior token/connect promise may still settle, but its generation is
    // invalid. Do not let it monopolize the next room's connection slot.
    this.connectInFlight = undefined;
    this.clearTimers();
    const previous = this.subscription;
    this.token = undefined;
    this.scopeValue = undefined;
    this.reconnectAttempt = 0;
    this.clearTransient(reason);
    if (lifecycleGeneration !== this.generation || lifecycleRequestSerial !== this.connectRequestSerial) return false;
    this.detachSubscription(previous);
    this.setState(nextState);
    return true;
  }

  private requestConnect(nextState: "connecting" | "reconnecting") {
    if (this.connectInFlight) return this.connectInFlight;
    const requestSerial = ++this.connectRequestSerial;
    const attempt = this.connect(nextState);
    if (requestSerial !== this.connectRequestSerial) return attempt;
    this.connectInFlight = attempt;
    void attempt.finally(() => {
      if (requestSerial === this.connectRequestSerial && this.connectInFlight === attempt) this.connectInFlight = undefined;
    });
    return attempt;
  }

  private publishWithDeadline(operation: () => void | Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clock.clearTimeout(timer);
        this.cancelPublications.delete(cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(new Error("Realtime transport publish cancelled"));
      this.cancelPublications.add(cancel);
      timer = this.clock.setTimeout(
        () => finish(new Error("Realtime transport publish timed out")),
        this.transportPublishTimeoutMs,
      );
      let publication: Promise<void>;
      try {
        publication = Promise.resolve(operation());
      } catch (error) {
        finish(error instanceof RealtimePublishRateLimitError
          ? error
          : new Error("Realtime transport publish failed"));
        return;
      }
      void publication.then(
        () => finish(),
        (error: unknown) => finish(error instanceof RealtimePublishRateLimitError
          ? error
          : new Error("Realtime transport publish failed")),
      );
    });
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
        tokenPromise = Promise.resolve(this.tokenProvider(scope));
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
        connectionPromise = Promise.resolve(this.transportConnect(input));
      } catch {
        finish(new Error("Realtime transport connection failed"));
        return;
      }
      void connectionPromise.then(
        (candidate) => {
          const snapshot = snapshotTransportSubscription(candidate);
          if (settled) {
            if (snapshot?.disposable) void this.observeSubscriptionDisposal(snapshot.disposable).catch(() => undefined);
            return;
          }
          if (!snapshot?.subscription) {
            if (snapshot?.disposable) void this.observeSubscriptionDisposal(snapshot.disposable).catch(() => undefined);
            finish(new Error("Realtime transport connection failed"));
            return;
          }
          finish(undefined, snapshot.subscription);
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
      this.cancelPendingPublications();
      this.clearTransient("reconnect");
      this.detachSubscription(previous);
    }
    if (generation !== this.generation || this.scopeValue !== scope) return;
    this.setState(nextState);
    if (generation !== this.generation || this.scopeValue !== scope || this.stateValue !== nextState) return;
    try {
      const token = await this.acquireToken(scope);
      if (generation !== this.generation || this.scopeValue !== scope) return;
      if (!Number.isFinite(token.expiresAt) || token.expiresAt <= this.clock.now()) throw new Error("Realtime token is expired");
      const authorizationChanged = this.token !== undefined && this.token.authorizationVersion !== token.authorizationVersion;
      this.token = token;
      if (authorizationChanged) this.clearTransient("authorization-changed");
      if (generation !== this.generation || this.scopeValue !== scope || this.stateValue !== nextState) return;
      const subscription = await this.acquireTransportSubscription({
        scope,
        token,
        connectionEpoch: generation,
        onMessage: (message) => {
          if (generation !== this.generation) return;
          const accepted = this.acceptMessage(message);
          if (typeof accepted !== "string") this.onMessage?.(accepted);
        },
        onFailure: (error) => this.handleFailure(error, generation),
      });
      if (generation !== this.generation || this.scopeValue !== scope) {
        this.detachSubscription(subscription);
        return;
      }
      this.subscription = subscription;
      this.reconnectAttempt = 0;
      this.scheduleRefresh(token, generation);
      this.setState("live");
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
    this.cancelPendingPublications();
    const failureGeneration = ++this.generation;
    this.detachSubscription();
    this.clearTimers();
    const unauthorized = this.isUnauthorizedError(error);
    if (failureGeneration !== this.generation) return;
    if (unauthorized) {
      this.token = undefined;
      this.clearTransient("authorization-changed");
      this.setState("unauthorized");
      if (failureGeneration === this.generation) this.onTransportFailure?.(error);
      return;
    }
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.setState("degraded");
      if (failureGeneration === this.generation) this.onTransportFailure?.(error);
      return;
    }
    let requestedDelay: number;
    try {
      requestedDelay = this.reconnectDelayMs(this.reconnectAttempt);
    } catch {
      requestedDelay = maximumReconnectDelayMs;
    }
    if (failureGeneration !== this.generation) return;
    const delay = Number.isFinite(requestedDelay) ? Math.max(0, Math.min(maximumReconnectDelayMs, requestedDelay)) : maximumReconnectDelayMs;
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.clock.setTimeout(() => {
      if (failureGeneration !== this.generation || !this.scopeValue || this.stateValue === "stopped") return;
      this.setState("reconnecting");
      if (failureGeneration !== this.generation || !this.scopeValue || this.stateValue !== "reconnecting") return;
      void this.requestConnect("reconnecting");
    }, delay);
    this.setState("degraded");
    if (failureGeneration === this.generation) this.onTransportFailure?.(error);
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
      this.onTransientMessageExpired?.(message);
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
