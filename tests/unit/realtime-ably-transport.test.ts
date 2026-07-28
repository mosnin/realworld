import { describe, expect, it, vi } from "vitest";

import { createDevelopmentAblyRoomTransport, type AblyRealtimeClient, type AblyRoomChannel } from "../../lib/realtime/ably-room-transport";
import { channelFamilyForKind, type SupportedRealtimeKind } from "../../lib/realtime/message-schema";
import { createPrivacySafeRealtimeTelemetry, type PrivacySafeRealtimeTelemetryEvent } from "../../lib/realtime/privacy-telemetry";
import type { RealtimeEnvelope, RealtimeToken } from "../../lib/realtime/room-session";
import { createRealtimePublishGovernor, RealtimePublishRateLimitError } from "../../lib/realtime/signal-governor";

const scope = { missionId: "mission_a", roomId: "room_a" };
const tokenRequest = (capability: Record<string, string[]>): RealtimeToken => ({
  tokenRequest: {
    keyName: "test.key", ttl: 300_000, timestamp: 1_000_000, nonce: "nonce-1234567890123456", clientId: "rw_test", mac: "signed-mac",
    capability: JSON.stringify(capability),
  },
  expiresAt: 1_300_000,
  authorizationVersion: 1,
});

function names() {
  const prefix = `rw:preview:mission:${scope.missionId}`;
  return {
    world: `${prefix}:world`,
    presence: `${prefix}:room:${scope.roomId}:presence`,
    interaction: `${prefix}:room:${scope.roomId}:interaction`,
    surge: `${prefix}:room:${scope.roomId}:surge`,
    "agent-status": `${prefix}:room:${scope.roomId}:agent-status`,
  } as const;
}

function payload(kind: SupportedRealtimeKind): unknown {
  const all: Record<SupportedRealtimeKind, unknown> = {
    "world.location": { roomId: "room_a", mode: "room", roomSequence: 1 },
    "world.selection": { targetId: "target_a", mode: "map" },
    "world.transition": { sourceRoomId: "room_a", targetRoomId: "room_a", effect: "highlight" },
    "presence.heartbeat": { activity: "active", privacy: "coarse", roomSequence: 1 },
    "presence.leave": { reason: "navigate" },
    "interaction.cursor": { targetId: "target_a", x: 0.1, y: 0.2, mode: "map" },
    "interaction.selection": { targetId: "target_a", selectionDigest: "digest_a", mode: "object" },
    "interaction.viewport": { x: 0.1, y: 0.2, zoom: 1 },
    "interaction.typing": { targetId: "target_a", isTyping: true },
    "interaction.drag": { targetId: "target_a", x: 0.1, y: 0.2, width: 0.3, height: 0.4, phase: "move" },
    "interaction.attention": { targetId: "target_a", reason: "review" },
    "surge.readiness": { surgeId: "surge_a", state: "ready" },
    "surge.clock": { surgeId: "surge_a", localTimeMs: 1_000_000, sampleSequence: 1 },
    "surge.reaction": { surgeId: "surge_a", reaction: "focus" },
    "agent.public-status": { runId: "run_a", state: "drafting", safeSummary: "Drafting safely.", durableVersion: 1 },
  };
  return all[kind];
}

function envelope(kind: SupportedRealtimeKind, id: string = kind): RealtimeEnvelope {
  return {
    v: 1, kind, messageId: id, sender: { clientId: "rw_test", clientInstanceId: "tab_a", connectionEpoch: 1 },
    missionId: scope.missionId, roomId: scope.roomId, issuedAtMs: 1_000_000, expiresAtMs: 1_010_000, clientSeq: 1, payload: payload(kind),
  };
}

function fakeClient(autoConnect = true) {
  const channels = new Map<string, AblyRoomChannel>();
  const listeners = new Map<string, Array<(message: { data: unknown; name?: string; clientId?: string }) => void>>();
  const presenceListeners = new Map<string, Array<(message: { data: unknown; name?: string; clientId?: string }) => void>>();
  const connectionListeners: Array<{ events: string | string[]; listener: (state: { current?: string; reason?: unknown }) => void }> = [];
  const get = vi.fn((name: string): AblyRoomChannel => {
    const existing = channels.get(name);
    if (existing) return existing;
    const channel: AblyRoomChannel = {
      subscribe: vi.fn(async (listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); }),
      unsubscribe: vi.fn((listener) => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener))),
      publish: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      presence: {
        subscribe: vi.fn(async (listener) => { presenceListeners.set(name, [...(presenceListeners.get(name) ?? []), listener]); }),
        unsubscribe: vi.fn((listener) => presenceListeners.set(name, (presenceListeners.get(name) ?? []).filter((item) => item !== listener))),
        enter: vi.fn(async () => undefined), update: vi.fn(async () => undefined), leave: vi.fn(async () => undefined),
      },
    };
    channels.set(name, channel);
    return channel;
  });
  const client: AblyRealtimeClient = {
    channels: { get },
    connection: {
      on: vi.fn((events, listener) => connectionListeners.push({ events, listener })),
      off: vi.fn((_events, listener) => { const index = connectionListeners.findIndex((item) => item.listener === listener); if (index >= 0) connectionListeners.splice(index, 1); }),
    },
    connect: vi.fn(() => {
      if (!autoConnect) return;
      for (const item of connectionListeners) {
        if ((Array.isArray(item.events) ? item.events : [item.events]).includes("connected")) item.listener({ current: "connected" });
      }
    }), close: vi.fn(),
  };
  const emit = (current: string, reason?: unknown) => {
    for (const item of [...connectionListeners]) {
      if ((Array.isArray(item.events) ? item.events : [item.events]).includes(current)) item.listener({ current, reason });
    }
  };
  return { client, channels, listeners, presenceListeners, connectionListeners, get, emit };
}

describe("development Ably room transport", () => {
  it("does not construct a client until connect and denies production, malformed tokens, and overbroad capabilities first", async () => {
    const fake = fakeClient();
    const factory = vi.fn(async () => fake.client);
    const adapter = createDevelopmentAblyRoomTransport({ environment: "preview", clientFactory: factory, now: () => 1_000_000 });
    expect(factory).not.toHaveBeenCalled();

    await expect(createDevelopmentAblyRoomTransport({ environment: "production", clientFactory: factory }).connect({
      scope, token: tokenRequest({}), connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn(),
    })).rejects.toThrow("unsupported in production");
    await expect(adapter.connect({ scope, token: { ...tokenRequest({}), tokenRequest: { capability: "{}" } }, connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn() })).rejects.toThrow("malformed");
    await expect(adapter.connect({ scope, token: tokenRequest({ "rw:preview:mission:other:world": ["subscribe"] }), connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn() })).rejects.toThrow("exceeds");
    await expect(adapter.connect({ scope, token: tokenRequest({ [names().world]: ["presence"] }), connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn() })).rejects.toThrow("outside this channel family");
    await expect(adapter.connect({ scope, token: tokenRequest({ [names().world]: ["subscribe", "subscribe"] }), connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn() })).rejects.toThrow("unsupported operation");
    const missingClientId = tokenRequest({ [names().presence]: ["presence"] });
    const rawMissingClientId = { ...(missingClientId.tokenRequest as Record<string, unknown>) };
    delete rawMissingClientId.clientId;
    await expect(adapter.connect({ scope, token: { ...missingClientId, tokenRequest: rawMissingClientId }, connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn() })).rejects.toThrow("token-bound client id");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects a failed connection before readiness and cleans up its fake client", async () => {
    const fake = fakeClient(false);
    const adapter = createDevelopmentAblyRoomTransport({ environment: "preview", clientFactory: async () => fake.client, now: () => 1_000_000 });
    const pending = adapter.connect({
      scope,
      token: tokenRequest({ [names().world]: ["subscribe"] }),
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    });
    await vi.waitFor(() => expect(fake.client.connect).toHaveBeenCalledTimes(1));
    fake.emit("suspended", new Error("network suspended"));
    await expect(pending).rejects.toThrow("network suspended");
    expect(fake.client.close).toHaveBeenCalledTimes(1);
  });

  it("routes every supported writer kind to its exact capability family and performs presence enter/update/leave", async () => {
    const fake = fakeClient();
    const factory = vi.fn(async () => fake.client);
    const namesByFamily = names();
    const capability = {
      [namesByFamily.world]: ["publish", "subscribe"],
      [namesByFamily.presence]: ["presence", "subscribe"],
      [namesByFamily.interaction]: ["publish", "subscribe"],
      [namesByFamily.surge]: ["publish", "subscribe"],
      [namesByFamily["agent-status"]]: ["subscribe"],
    };
    const adapter = createDevelopmentAblyRoomTransport({ environment: "preview", clientFactory: factory, now: () => 1_000_000 });
    const subscription = await adapter.connect({ scope, token: tokenRequest(capability), connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn() });
    expect(factory).toHaveBeenCalledTimes(1);

    const kinds = Object.keys({
      "world.location": 1, "world.selection": 1, "world.transition": 1, "presence.heartbeat": 1, "presence.leave": 1,
      "interaction.cursor": 1, "interaction.selection": 1, "interaction.viewport": 1, "interaction.typing": 1, "interaction.drag": 1, "interaction.attention": 1,
      "surge.readiness": 1, "surge.clock": 1, "surge.reaction": 1,
    }) as SupportedRealtimeKind[];
    for (const kind of kinds) await subscription.publish?.(envelope(kind));

    for (const kind of kinds.filter((value) => channelFamilyForKind(value) !== "presence")) {
      const family = channelFamilyForKind(kind)!;
      expect(fake.channels.get(namesByFamily[family])!.publish).toHaveBeenCalledWith(kind, expect.objectContaining({ kind }));
    }
    expect(fake.channels.get(namesByFamily.presence)!.presence.enter).toHaveBeenCalledTimes(1);
    expect(fake.channels.get(namesByFamily.presence)!.presence.leave).toHaveBeenCalledWith(expect.objectContaining({ kind: "presence.leave" }));
  });

  it("enforces observer subscribe-only access, agent-status publish denial, cross-scope denial, failures, and idempotent cleanup", async () => {
    const fake = fakeClient();
    const factory = vi.fn(async () => fake.client);
    const channelNames = names();
    const observerCapability = {
      [channelNames.world]: ["subscribe"], [channelNames.presence]: ["subscribe"], [channelNames.surge]: ["subscribe"], [channelNames["agent-status"]]: ["subscribe"],
    };
    const received = vi.fn();
    const failed = vi.fn();
    const adapter = createDevelopmentAblyRoomTransport({ environment: "preview", clientFactory: factory, now: () => 1_000_000 });
    const subscription = await adapter.connect({ scope, token: tokenRequest(observerCapability), connectionEpoch: 1, onMessage: received, onFailure: failed });
    expect(fake.get).not.toHaveBeenCalledWith(channelNames.interaction);
    await expect(subscription.publish?.(envelope("interaction.cursor"))).rejects.toThrow("not granted");
    await expect(subscription.publish?.(envelope("agent.public-status"))).rejects.toThrow("publish is not granted");
    await expect(subscription.publish?.({ ...envelope("world.transition"), roomId: "other_room" })).rejects.toThrow("outside");
    await expect(subscription.publish?.({ ...envelope("world.transition"), v: 2 as 1 })).rejects.toThrow("outside");
    await expect(subscription.publish?.({ ...envelope("world.transition"), payload: { sourceRoomId: "room_a" } })).rejects.toThrow("outside");

    for (const listener of fake.listeners.get(channelNames.world) ?? []) listener({ data: envelope("world.transition", "inbound"), clientId: "rw_test" });
    for (const listener of fake.listeners.get(channelNames.world) ?? []) listener({ data: envelope("world.transition", "spoofed"), clientId: "rw_other" });
    for (const listener of fake.listeners.get(channelNames.world) ?? []) listener({ data: envelope("world.transition", "unbound") });
    for (const listener of fake.listeners.get(channelNames.world) ?? []) listener({ data: { ...envelope("world.transition", "bad-envelope"), sender: {} }, clientId: "rw_test" });
    for (const listener of fake.listeners.get(channelNames.world) ?? []) listener({ data: { ...envelope("world.transition", "invalid"), payload: { sourceRoomId: "room_a" } }, clientId: "rw_test" });
    expect(received).toHaveBeenCalledTimes(1);
    fake.emit("failed", new Error("lost"));
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "lost" }));
    await subscription.unsubscribe();
    await subscription.unsubscribe();
    for (const listener of fake.listeners.get(channelNames.world) ?? []) listener({ data: envelope("world.transition", "after-close"), clientId: "rw_test" });
    expect(received).toHaveBeenCalledTimes(1);
    expect(fake.client.close).toHaveBeenCalledTimes(1);
  });

  it("enforces per-kind publish budgets and emits only classified telemetry without degrading the connection", async () => {
    const fake = fakeClient();
    const telemetryEvents: PrivacySafeRealtimeTelemetryEvent[] = [];
    let now = 1_000_000;
    const telemetry = createPrivacySafeRealtimeTelemetry({ enabled: true, sink: (event) => telemetryEvents.push(event) });
    const publishGovernor = createRealtimePublishGovernor({
      clock: { now: () => now },
      budgets: { kind: { "interaction.cursor": { capacity: 1, refillTokens: 1, refillIntervalMs: 1_000 } } },
    });
    const adapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => fake.client,
      now: () => now,
      publishGovernor,
      telemetry,
    });
    const subscription = await adapter.connect({
      scope,
      token: tokenRequest({ [names().interaction]: ["publish", "subscribe"] }),
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    });

    await expect(subscription.publish?.({
      ...envelope("interaction.cursor", "spoofed-outbound"),
      sender: { clientId: "rw_other", clientInstanceId: "tab_a", connectionEpoch: 1 },
    })).rejects.toThrow("outside");
    await expect(subscription.publish?.(envelope("interaction.cursor", "cursor-1"))).resolves.toBeUndefined();
    await expect(subscription.publish?.(envelope("interaction.cursor", "cursor-2"))).rejects.toBeInstanceOf(RealtimePublishRateLimitError);
    expect(fake.channels.get(names().interaction)!.publish).toHaveBeenCalledTimes(1);
    expect(telemetryEvents).toEqual(expect.arrayContaining([
      { event: "connect_requested", state: "connecting" },
      { event: "connect_ready", state: "live", subscriptions: 1 },
      { event: "signal_published", kind: "interaction.cursor", family: "interaction" },
      { event: "governor_limited", reason: "rate_limited", kind: "interaction.cursor", family: "interaction" },
    ]));
    expect(JSON.stringify(telemetryEvents)).not.toMatch(/mission_a|room_a|rw_test|tab_a|cursor-[12]/);

    now += 1_000;
    await expect(subscription.publish?.(envelope("interaction.cursor", "cursor-3"))).resolves.toBeUndefined();
    expect(fake.channels.get(names().interaction)!.publish).toHaveBeenCalledTimes(2);
  });
});
