import { describe, expect, it, vi } from "vitest";

import { createBrowserRealtimeLifecycle } from "../../lib/realtime/browser-lifecycle";
import { createBrowserSignalPublicationPolicy } from "../../lib/realtime/browser-signal-policy";
import type { RealtimeEnvelope } from "../../lib/realtime/room-session";

class FakeSource {
  context = { online: true, visible: true, focused: true };
  throwOnAddAt: number | undefined;
  private addCount = 0;
  private readonly listeners = new Map<string, Set<() => void>>();
  getContext = () => this.context;
  readonly addEventListener = vi.fn((event: string, listener: () => void) => {
    this.addCount += 1;
    if (this.throwOnAddAt === this.addCount) throw new Error("listener unavailable");
    const entries = this.listeners.get(event) ?? new Set<() => void>();
    entries.add(listener);
    this.listeners.set(event, entries);
  });
  readonly removeEventListener = vi.fn((event: string, listener: () => void) => this.listeners.get(event)?.delete(listener));
  emit(event: string) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(); }
}

function envelope(kind: string, payload: unknown, id = kind): RealtimeEnvelope {
  return {
    v: 1, kind, messageId: id,
    sender: { clientId: "client_a", clientInstanceId: "tab_a", connectionEpoch: 1 },
    missionId: "mission_a", roomId: "room_a", issuedAtMs: 1_000_000, expiresAtMs: 1_010_000, clientSeq: 1, payload,
  };
}

const cursor = () => envelope("interaction.cursor", { targetId: "target_a", x: 0.2, y: 0.8, mode: "map" });
const leave = () => envelope("presence.leave", { reason: "navigate" });
const heartbeat = (activity: "active" | "away" = "away") => envelope("presence.heartbeat", { activity, privacy: "coarse", roomSequence: 1 });
const agentStatus = () => envelope("agent.public-status", { runId: "run_a", state: "drafting", safeSummary: "No browser agent relay.", durableVersion: 1 });

async function flush() { await Promise.resolve(); await Promise.resolve(); }

describe("browser realtime lifecycle and signal policy", () => {
  it("is disabled by default and production fail-closed with zero listeners or session calls", async () => {
    const source = new FakeSource();
    const session = { start: vi.fn(), stop: vi.fn(), publish: vi.fn() };
    const disabled = createBrowserRealtimeLifecycle({ environment: "preview", source, session, publicationPolicy: createBrowserSignalPublicationPolicy() });
    const production = createBrowserRealtimeLifecycle({ environment: "production", enabled: true, source, session, publicationPolicy: createBrowserSignalPublicationPolicy() });
    expect(await disabled.start()).toBe(false);
    expect(await disabled.publish(cursor())).toBe(false);
    expect(await production.start()).toBe(false);
    expect(await production.publish(cursor())).toBe(false);
    await production.stop();
    expect(source.addEventListener).not.toHaveBeenCalled();
    expect(session.start).not.toHaveBeenCalled();
    expect(session.stop).not.toHaveBeenCalled();
    expect(session.publish).not.toHaveBeenCalled();
  });

  it("starts online, stops offline, restarts online, and cleans listeners idempotently", async () => {
    const source = new FakeSource();
    const session = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), publish: vi.fn(async () => true) };
    const lifecycle = createBrowserRealtimeLifecycle({ environment: "preview", enabled: true, source, session, publicationPolicy: createBrowserSignalPublicationPolicy() });
    expect(await lifecycle.start()).toBe(true);
    expect(lifecycle.active).toBe(true);
    source.context = { ...source.context, online: false };
    source.emit("offline");
    await flush();
    expect(lifecycle.active).toBe(false);
    expect(session.stop).toHaveBeenCalledTimes(1);
    source.context = { ...source.context, online: true };
    source.emit("online");
    await flush();
    expect(lifecycle.active).toBe(true);
    expect(session.start).toHaveBeenCalledTimes(2);
    await lifecycle.stop();
    await lifecycle.stop();
    const starts = session.start.mock.calls.length;
    source.emit("online");
    await flush();
    expect(session.start).toHaveBeenCalledTimes(starts);
    expect(source.removeEventListener).toHaveBeenCalledTimes(5);
  });

  it("uses the actual policy composition to deny hidden, unfocused, offline, agent, and normal-leave publishes without delegating", async () => {
    const source = new FakeSource();
    const session = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), publish: vi.fn(async () => true) };
    const lifecycle = createBrowserRealtimeLifecycle({ environment: "preview", enabled: true, source, session, publicationPolicy: createBrowserSignalPublicationPolicy() });
    await lifecycle.start();
    source.context = { online: true, visible: false, focused: true };
    source.emit("visibilitychange");
    expect(lifecycle.active).toBe(true);
    expect(await lifecycle.publish(cursor())).toBe(false);
    source.context = { online: true, visible: true, focused: false };
    source.emit("blur");
    expect(lifecycle.active).toBe(true);
    expect(await lifecycle.publish(cursor())).toBe(false);
    source.context = { online: false, visible: true, focused: true };
    expect(await lifecycle.publish(cursor())).toBe(false);
    source.context = { online: true, visible: true, focused: true };
    expect(await lifecycle.publish(agentStatus())).toBe(false);
    expect(await lifecycle.publish(leave())).toBe(false);
    expect(session.publish).not.toHaveBeenCalled();
  });

  it("allows only explicit lifecycle leave and explicit away/coarse hidden heartbeat without disconnecting", async () => {
    const source = new FakeSource();
    const session = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), publish: vi.fn(async () => true) };
    const lifecycle = createBrowserRealtimeLifecycle({
      environment: "preview", enabled: true, source, session,
      publicationPolicy: createBrowserSignalPublicationPolicy({ hiddenPresenceHeartbeatPolicy: "allow-away-coarse" }),
    });
    await lifecycle.start();
    expect(await lifecycle.publish(leave(), "lifecycle-exit")).toBe(true);
    source.context = { online: true, visible: false, focused: false };
    source.emit("visibilitychange");
    expect(lifecycle.active).toBe(true);
    expect(await lifecycle.publish(heartbeat("away"))).toBe(true);
    expect(await lifecycle.publish(heartbeat("active"))).toBe(false);
    expect(session.stop).not.toHaveBeenCalled();
    expect(session.publish).toHaveBeenCalledTimes(2);
  });

  it("rolls back a partial listener attachment with no session start", async () => {
    const source = new FakeSource();
    source.throwOnAddAt = 3;
    const session = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), publish: vi.fn(async () => true) };
    const lifecycle = createBrowserRealtimeLifecycle({ environment: "preview", enabled: true, source, session, publicationPolicy: createBrowserSignalPublicationPolicy() });
    expect(await lifecycle.start()).toBe(false);
    expect(session.start).not.toHaveBeenCalled();
    expect(source.removeEventListener).toHaveBeenCalledTimes(2);
    source.throwOnAddAt = undefined;
    source.emit("online");
    await flush();
    expect(session.start).not.toHaveBeenCalled();
  });

  it("serializes a rapid online-to-offline transition while start is in flight and fails publish closed", async () => {
    const source = new FakeSource();
    let resolveStart: (() => void) | undefined;
    const session = {
      start: vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve; })),
      stop: vi.fn(async () => undefined), publish: vi.fn(async () => true),
    };
    const lifecycle = createBrowserRealtimeLifecycle({ environment: "preview", enabled: true, source, session, publicationPolicy: createBrowserSignalPublicationPolicy() });
    const starting = lifecycle.start();
    await flush();
    source.context = { ...source.context, online: false };
    source.emit("offline");
    expect(await lifecycle.publish(cursor())).toBe(false);
    resolveStart?.();
    await starting;
    await flush();
    expect(lifecycle.active).toBe(false);
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(session.publish).not.toHaveBeenCalled();
  });

  it("preserves an offline teardown when online follows before the transition queue drains", async () => {
    const source = new FakeSource();
    const session = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      publish: vi.fn(async () => true),
    };
    const lifecycle = createBrowserRealtimeLifecycle({
      environment: "preview",
      enabled: true,
      source,
      session,
      publicationPolicy: createBrowserSignalPublicationPolicy(),
    });
    await lifecycle.start();

    source.context = { ...source.context, online: false };
    source.emit("offline");
    source.context = { ...source.context, online: true };
    source.emit("online");
    await flush();
    await flush();

    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(session.start).toHaveBeenCalledTimes(2);
    expect(lifecycle.active).toBe(true);
  });
});
