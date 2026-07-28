import { describe, expect, it, vi } from "vitest";

import { channelFamilyForKind, isSupportedRealtimeKind, type SupportedRealtimeKind } from "../../lib/realtime/message-schema";
import {
  createRealtimePublishGovernor,
  defaultRealtimePublishFamilyBudgets,
  defaultRealtimePublishKindBudgets,
} from "../../lib/realtime/signal-governor";
import {
  createPrivacySafeRealtimeTelemetry,
  disabledRealtimeTelemetry,
  scrubRealtimeTelemetry,
} from "../../lib/realtime/privacy-telemetry";

class Clock {
  value = 1_000_000;
  now = () => this.value;
  advance(milliseconds: number) { this.value += milliseconds; }
}

function request(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    missionId: "mission_a",
    roomId: "room_a",
    sender: { clientId: "client_a", clientInstanceId: "tab_a" },
    kind,
    ...overrides,
  };
}

describe("realtime signal governance", () => {
  it("gives every supported kind an explicit bounded budget and known family", () => {
    const kinds = Object.keys(defaultRealtimePublishKindBudgets) as SupportedRealtimeKind[];
    expect(kinds).toHaveLength(15);
    for (const kind of kinds) {
      expect(isSupportedRealtimeKind(kind)).toBe(true);
      const family = channelFamilyForKind(kind);
      expect(family).toBeDefined();
      expect(defaultRealtimePublishFamilyBudgets[family!]).toEqual(expect.objectContaining({ capacity: expect.any(Number), refillTokens: expect.any(Number), refillIntervalMs: expect.any(Number) }));
      expect(defaultRealtimePublishKindBudgets[kind]).toEqual(expect.objectContaining({ capacity: expect.any(Number), refillTokens: expect.any(Number), refillIntervalMs: expect.any(Number) }));
      expect(defaultRealtimePublishKindBudgets[kind].capacity).toBeGreaterThan(0);
    }
  });

  it("enforces burst, deterministic refill and retry without coupling sender, scope, or kind buckets", () => {
    const clock = new Clock();
    const governor = createRealtimePublishGovernor({
      clock,
      budgets: { kind: { "interaction.cursor": { capacity: 2, refillTokens: 1, refillIntervalMs: 1_000 } } },
    });
    const cursor = request("interaction.cursor");
    expect(governor.acquire(cursor)).toEqual({ allowed: true });
    expect(governor.acquire(cursor)).toEqual({ allowed: true });
    expect(governor.acquire(cursor)).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(governor.acquire(request("interaction.cursor", { sender: { clientId: "client_a", clientInstanceId: "rotated_tab" } }))).toEqual({ allowed: false, retryAfterMs: 1_000 });
    clock.advance(500);
    expect(governor.acquire(cursor)).toEqual({ allowed: false, retryAfterMs: 500 });
    clock.advance(500);
    expect(governor.acquire(cursor)).toEqual({ allowed: true });

    expect(governor.acquire(request("interaction.cursor", { sender: { clientId: "client_b", clientInstanceId: "tab_a" } }))).toEqual({ allowed: true });
    expect(governor.acquire(request("interaction.cursor", { roomId: "room_b" }))).toEqual({ allowed: true });
    expect(governor.acquire(request("interaction.typing"))).toEqual({ allowed: true });
  });

  it("fails closed for unknown/invalid requests and never mints refill from a backward or nonfinite clock", () => {
    const clock = new Clock();
    const governor = createRealtimePublishGovernor({
      clock,
      budgets: { kind: { "presence.leave": { capacity: 1, refillTokens: 1, refillIntervalMs: 1_000 } } },
    });
    const leave = request("presence.leave");
    expect(governor.acquire(leave)).toEqual({ allowed: true });
    expect(governor.acquire(leave)).toEqual({ allowed: false, retryAfterMs: 1_000 });
    clock.value -= 100_000;
    expect(governor.acquire(leave)).toEqual({ allowed: false, retryAfterMs: 1_000 });
    clock.value = Number.NaN;
    expect(governor.acquire(leave)).toEqual({ allowed: false, retryAfterMs: 1_000 });
    clock.value = 1_000_000;
    expect(governor.acquire(request("unknown.kind"))).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(governor.acquire(request("interaction.cursor", { missionId: "bad/id" }))).toEqual({ allowed: false, retryAfterMs: 1_000 });
  });

  it("evicts only idle buckets and caps active cardinality", () => {
    const clock = new Clock();
    const governor = createRealtimePublishGovernor({
      clock,
      maxEntries: 1,
      idleEntryTtlMs: 1_000,
      budgets: { kind: { "world.transition": { capacity: 1, refillTokens: 1, refillIntervalMs: 1_000 } } },
    });
    expect(governor.acquire(request("world.transition"))).toEqual({ allowed: true });
    expect(governor.acquire(request("world.transition", { sender: { clientId: "client_b", clientInstanceId: "tab_b" } }))).toEqual({ allowed: false, retryAfterMs: 1_000 });
    clock.advance(1_000);
    expect(governor.acquire(request("world.transition", { sender: { clientId: "client_b", clientInstanceId: "tab_b" } }))).toEqual({ allowed: true });
  });

  it("allowlists telemetry classifications and bounded numbers while stripping payloads, ids, errors, and secrets", () => {
    const scrubbed = scrubRealtimeTelemetry({
      event: "signal_dropped", reason: "schema_invalid", kind: "interaction.cursor", family: "interaction", state: "live",
      count: 3, durationMs: 20, attempt: 1, subscriptions: 2,
      payload: { private: "never" }, missionId: "mission_a", roomId: "room_a", clientId: "client_a",
      error: new Error("provider secret"), token: "secret", capability: "private",
    });
    expect(scrubbed).toEqual({ event: "signal_dropped", reason: "schema_invalid", kind: "interaction.cursor", family: "interaction", state: "live", count: 3, durationMs: 20, attempt: 1, subscriptions: 2 });
    expect(JSON.stringify(scrubbed)).not.toMatch(/mission_a|client_a|secret|provider|payload/i);
    expect(scrubRealtimeTelemetry({ event: "signal_received", kind: "interaction.cursor", family: "presence" })).toBeUndefined();
    expect(scrubRealtimeTelemetry({ event: "unknown", count: 1 })).toBeUndefined();
    expect(scrubRealtimeTelemetry({ event: "cleanup", count: -1, durationMs: Infinity, subscriptions: 6 })).toEqual({ event: "cleanup" });
    expect(scrubRealtimeTelemetry(Object.defineProperty({}, "event", { get: () => { throw new Error("private getter"); } }))).toBeUndefined();
  });

  it("keeps telemetry sinks optional and exception-isolated", () => {
    const sink = vi.fn(() => { throw new Error("telemetry outage"); });
    const telemetry = createPrivacySafeRealtimeTelemetry({ enabled: true, sink });
    expect(() => telemetry.emit({ event: "connect_ready", payload: "private" })).not.toThrow();
    expect(sink).toHaveBeenCalledWith({ event: "connect_ready" });
    expect(disabledRealtimeTelemetry.enabled).toBe(false);
    expect(() => disabledRealtimeTelemetry.emit({ event: "connect_ready", secret: "never" })).not.toThrow();
  });
});
