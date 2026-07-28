import {
  channelFamilyForKind,
  isSupportedRealtimeKind,
  type RealtimeChannelFamily,
  type SupportedRealtimeKind,
} from "./message-schema";

/** A deterministic clock seam for transient outbound-signal limits. */
export type RealtimePublishGovernorClock = Readonly<{
  now: () => number;
}>;

/**
 * A token bucket permits `capacity` immediate signals, then replenishes
 * `refillTokens` over `refillIntervalMs`. Values are normalized defensively.
 */
export type RealtimePublishBudget = Readonly<{
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
}>;

export type RealtimePublishBudgetOverrides = Readonly<{
  family?: Readonly<Partial<Record<RealtimeChannelFamily, Partial<RealtimePublishBudget>>>>;
  kind?: Readonly<Partial<Record<SupportedRealtimeKind, Partial<RealtimePublishBudget>>>>;
}>;

export type RealtimePublishGovernorOptions = Readonly<{
  clock?: RealtimePublishGovernorClock;
  budgets?: RealtimePublishBudgetOverrides;
  /** Maximum tracked sender/scope/kind buckets; clamped to a safe hard ceiling. */
  maxEntries?: number;
  /** Idle buckets are removed before admitting a new bucket. */
  idleEntryTtlMs?: number;
}>;

/** Only these compact fields are accepted at the private governance boundary. */
export type RealtimePublishGovernorRequest = Readonly<{
  missionId: string;
  roomId: string;
  sender: Readonly<{
    clientId: string;
    clientInstanceId: string;
  }>;
  kind: string;
}>;

export type RealtimePublishGovernorDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; retryAfterMs: number }>;

/** A local flow-control denial, not a transport or authorization failure. */
export class RealtimePublishRateLimitError extends Error {
  override readonly name = "RealtimePublishRateLimitError";
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Realtime signal publish rate exceeded");
    this.retryAfterMs = finiteIntegerWithin(retryAfterMs, invalidRequestRetryAfterMs, 1, maximumIdleEntryTtlMs);
  }
}

type PartialBudget = Partial<RealtimePublishBudget>;
type Bucket = { tokens: number; lastRefillAtMs: number; lastSeenAtMs: number };

const minimumIntervalMs = 100;
const maximumIntervalMs = 60_000;
const maximumCapacity = 60;
const maximumRefillTokens = 30;
const maximumEntries = 10_000;
const defaultMaximumEntries = 2_048;
const defaultIdleEntryTtlMs = 5 * 60_000;
const minimumIdleEntryTtlMs = 1_000;
const maximumIdleEntryTtlMs = 60 * 60_000;
const invalidRequestRetryAfterMs = 1_000;
const opaqueId = /^[A-Za-z0-9_-]{1,128}$/;

function frozenBudget(capacity: number, refillTokens: number, refillIntervalMs: number): RealtimePublishBudget {
  return Object.freeze({ capacity, refillTokens, refillIntervalMs });
}

/** Conservative family baselines; kind-specific defaults refine these below. */
export const defaultRealtimePublishFamilyBudgets: Readonly<Record<RealtimeChannelFamily, RealtimePublishBudget>> = Object.freeze({
  world: frozenBudget(2, 2, 1_000),
  presence: frozenBudget(2, 2, 5_000),
  interaction: frozenBudget(12, 12, 1_000),
  surge: frozenBudget(4, 4, 3_000),
  "agent-status": frozenBudget(1, 1, 5_000),
});

/**
 * Explicit per-kind budgets. Cursor and drag signals have the only higher
 * bounded bursts; public agent updates remain intentionally sparse.
 */
export const defaultRealtimePublishKindBudgets: Readonly<Record<SupportedRealtimeKind, RealtimePublishBudget>> = Object.freeze({
  "world.location": frozenBudget(3, 2, 1_000),
  "world.selection": frozenBudget(6, 6, 1_000),
  "world.transition": frozenBudget(1, 1, 2_000),
  "presence.heartbeat": frozenBudget(2, 1, 5_000),
  "presence.leave": frozenBudget(1, 1, 3_000),
  "interaction.cursor": frozenBudget(20, 20, 1_000),
  "interaction.selection": frozenBudget(6, 6, 1_000),
  "interaction.viewport": frozenBudget(8, 8, 1_000),
  "interaction.typing": frozenBudget(4, 4, 1_000),
  "interaction.drag": frozenBudget(24, 24, 1_000),
  "interaction.attention": frozenBudget(4, 4, 1_000),
  "surge.readiness": frozenBudget(3, 3, 5_000),
  "surge.clock": frozenBudget(2, 2, 1_000),
  "surge.reaction": frozenBudget(4, 4, 2_000),
  "agent.public-status": frozenBudget(1, 1, 5_000),
});

const defaultClock: RealtimePublishGovernorClock = { now: () => Date.now() };

function finiteIntegerWithin(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function normalizeBudget(base: RealtimePublishBudget, ...overrides: Array<PartialBudget | undefined>): RealtimePublishBudget {
  let capacity = base.capacity;
  let refillTokens = base.refillTokens;
  let refillIntervalMs = base.refillIntervalMs;
  for (const override of overrides) {
    if (!override || typeof override !== "object") continue;
    capacity = finiteIntegerWithin(override.capacity, capacity, 1, maximumCapacity);
    refillTokens = finiteIntegerWithin(override.refillTokens, refillTokens, 1, maximumRefillTokens);
    refillIntervalMs = finiteIntegerWithin(override.refillIntervalMs, refillIntervalMs, minimumIntervalMs, maximumIntervalMs);
  }
  return frozenBudget(capacity, refillTokens, refillIntervalMs);
}

function safeNow(clock: RealtimePublishGovernorClock): number | undefined {
  try {
    const now = clock.now();
    return typeof now === "number" && Number.isFinite(now) ? Math.floor(now) : undefined;
  } catch {
    return undefined;
  }
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && opaqueId.test(value);
}

function isValidRequest(request: RealtimePublishGovernorRequest): request is RealtimePublishGovernorRequest & { kind: SupportedRealtimeKind } {
  return typeof request === "object"
    && request !== null
    && isOpaqueId(request.missionId)
    && isOpaqueId(request.roomId)
    && typeof request.sender === "object"
    && request.sender !== null
    && isOpaqueId(request.sender.clientId)
    && isOpaqueId(request.sender.clientInstanceId)
    && typeof request.kind === "string"
    && isSupportedRealtimeKind(request.kind);
}

/**
 * Keeps disposable, outbound realtime signals within a local bounded rate.
 * It never calls a provider or stores durable state. Bucket identities remain
 * internal and are deliberately absent from decisions.
 */
export class RealtimePublishGovernor {
  private readonly clock: RealtimePublishGovernorClock;
  private readonly maxEntries: number;
  private readonly idleEntryTtlMs: number;
  private readonly budgets: Readonly<Record<SupportedRealtimeKind, RealtimePublishBudget>>;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RealtimePublishGovernorOptions = {}) {
    const safeOptions = options && typeof options === "object" ? options : {};
    this.clock = safeOptions.clock && typeof safeOptions.clock.now === "function" ? safeOptions.clock : defaultClock;
    this.maxEntries = finiteIntegerWithin(safeOptions.maxEntries, defaultMaximumEntries, 1, maximumEntries);
    this.idleEntryTtlMs = finiteIntegerWithin(safeOptions.idleEntryTtlMs, defaultIdleEntryTtlMs, minimumIdleEntryTtlMs, maximumIdleEntryTtlMs);
    this.budgets = this.createBudgets(safeOptions.budgets);
  }

  /** Attempts one outbound signal without revealing a tracked bucket identity. */
  acquire(request: RealtimePublishGovernorRequest): RealtimePublishGovernorDecision {
    const now = safeNow(this.clock);
    if (now === undefined || !isValidRequest(request)) return { allowed: false, retryAfterMs: invalidRequestRetryAfterMs };

    const budget = this.budgets[request.kind];
    // The authenticated client id is the rate identity. A caller must not
    // bypass aggregate limits by rotating its self-asserted tab instance id.
    const key = JSON.stringify([request.missionId, request.roomId, request.sender.clientId, request.kind]);
    this.evictIdleBuckets(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxEntries) return { allowed: false, retryAfterMs: this.idleEntryTtlMs };
      bucket = { tokens: budget.capacity, lastRefillAtMs: now, lastSeenAtMs: now };
      this.buckets.set(key, bucket);
    }

    // A backward wall clock must never mint tokens or make a bucket look idle.
    const effectiveNow = Math.max(now, bucket.lastRefillAtMs, bucket.lastSeenAtMs);
    const elapsedMs = effectiveNow - bucket.lastRefillAtMs;
    if (elapsedMs > 0) {
      bucket.tokens = Math.min(budget.capacity, bucket.tokens + ((elapsedMs * budget.refillTokens) / budget.refillIntervalMs));
      bucket.lastRefillAtMs = effectiveNow;
    }
    bucket.lastSeenAtMs = effectiveNow;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    const missingTokens = Math.max(0, 1 - bucket.tokens);
    const retryAfterMs = Math.max(1, Math.ceil((missingTokens * budget.refillIntervalMs) / budget.refillTokens));
    return { allowed: false, retryAfterMs };
  }

  private createBudgets(overrides: RealtimePublishBudgetOverrides | undefined): Readonly<Record<SupportedRealtimeKind, RealtimePublishBudget>> {
    const safeOverrides = overrides && typeof overrides === "object" ? overrides : undefined;
    const budgets = {} as Record<SupportedRealtimeKind, RealtimePublishBudget>;
    for (const kind of Object.keys(defaultRealtimePublishKindBudgets) as SupportedRealtimeKind[]) {
      const family = channelFamilyForKind(kind);
      // `kind` is drawn from the trusted default map, so a missing family is impossible; fail closed if changed.
      if (!family) continue;
      budgets[kind] = normalizeBudget(
        defaultRealtimePublishFamilyBudgets[family],
        defaultRealtimePublishKindBudgets[kind],
        safeOverrides?.family?.[family],
        safeOverrides?.kind?.[kind],
      );
    }
    return Object.freeze(budgets);
  }

  private evictIdleBuckets(now: number) {
    for (const [key, bucket] of this.buckets) {
      // Future timestamps are retained until time catches up instead of being evicted early.
      if (now >= bucket.lastSeenAtMs && now - bucket.lastSeenAtMs >= this.idleEntryTtlMs) {
        this.buckets.delete(key);
        continue;
      }
      // Map order is least-recently-used because every access moves its bucket.
      break;
    }
  }
}

export function createRealtimePublishGovernor(options?: RealtimePublishGovernorOptions): RealtimePublishGovernor {
  return new RealtimePublishGovernor(options);
}
