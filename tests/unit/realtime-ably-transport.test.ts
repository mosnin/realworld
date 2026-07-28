import { readFile } from "node:fs/promises";

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
  const on = vi.fn((events: string | string[], listener: (state: { current?: string; reason?: unknown }) => void) => connectionListeners.push({ events, listener }));
  const off = vi.fn((_events: string | string[], listener: (state: { current?: string; reason?: unknown }) => void) => {
    const index = connectionListeners.findIndex((item) => item.listener === listener);
    if (index >= 0) connectionListeners.splice(index, 1);
  });
  const client: AblyRealtimeClient = {
    channels: { get },
    connection: {
      on,
      off,
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
  return { client, channels, listeners, presenceListeners, connectionListeners, get, on, off, emit };
}

async function expectGenericProviderFailure(action: () => Promise<unknown>, providerSecret: string) {
  const failure = await action().catch((error: unknown) => error);
  expect(failure).toEqual(expect.objectContaining({ message: expect.stringMatching(/^Realtime /) }));
  expect(String(failure)).not.toContain(providerSecret);
}

function controlledTimer() {
  let nextId = 0;
  const pending = new Map<number, { callback: () => void; delayMs: number; cleared: boolean }>();
  return {
    timer: {
      setTimeout: vi.fn((callback: () => void, delayMs: number) => {
        const id = ++nextId;
        pending.set(id, { callback, delayMs, cleared: false });
        return id as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn((handle: ReturnType<typeof setTimeout>) => {
        const task = pending.get(handle as unknown as number);
        if (task) task.cleared = true;
      }),
    },
    fire(delayMs: number) {
      const task = [...pending.values()].find((candidate) => candidate.delayMs === delayMs && !candidate.cleared);
      if (!task) throw new Error(`missing controlled timer for ${delayMs}ms`);
      task.cleared = true;
      task.callback();
    },
  };
}

function deferred<T = void>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("development Ably room transport", () => {
  it("requires an explicitly injected client factory and never falls back to an SDK or network path", async () => {
    const hostileFactoryOptions = Object.defineProperty({ environment: "preview" }, "clientFactory", {
      get: () => { throw new Error("hostile factory getter"); },
    });
    const malformedFactoryOptions = { environment: "preview", clientFactory: "not-a-factory" };

    expect(() => createDevelopmentAblyRoomTransport({ environment: "preview" } as never)).toThrow(/client factory/i);
    expect(() => createDevelopmentAblyRoomTransport(malformedFactoryOptions as never)).toThrow(/client factory/i);
    expect(() => createDevelopmentAblyRoomTransport(hostileFactoryOptions as never)).toThrow(/client factory/i);

    const source = await readFile(new URL("../../lib/realtime/ably-room-transport.ts", import.meta.url), "utf8");
    expect(source).toMatch(/^import type \{ TokenRequest \} from "ably";$/m);
    expect(source).not.toMatch(/^import\s+(?!type\s).*from\s+["']ably["'];?$/m);
    expect(source).not.toMatch(/import\s*\(\s*["']ably["']\s*\)/);
    expect(source).not.toMatch(/\bnew\s+Ably\./);
  });

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

    const signedToken = tokenRequest({ [names().world]: ["subscribe"] });
    const subscription = await adapter.connect({ scope, token: signedToken, connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn() });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(signedToken.tokenRequest);
    await subscription.unsubscribe();
  });

  it("rejects malformed or hostile injected clients before listeners, subscriptions, or presence work", async () => {
    const capability = {
      [names().world]: ["subscribe"],
      [names().presence]: ["subscribe"],
    };
    const connect = async (candidate: unknown, fake?: ReturnType<typeof fakeClient>) => {
      const factory = vi.fn(async () => candidate as AblyRealtimeClient);
      const adapter = createDevelopmentAblyRoomTransport({ environment: "preview", clientFactory: factory, now: () => 1_000_000 });

      await expect(adapter.connect({
        scope,
        token: tokenRequest(capability),
        connectionEpoch: 1,
        onMessage: vi.fn(),
        onFailure: vi.fn(),
      })).rejects.toThrow("Realtime client contract is invalid");
      expect(factory).toHaveBeenCalledTimes(1);
      if (!fake) return;
      expect(fake.connectionListeners).toEqual([]);
      expect(fake.listeners).toEqual(new Map());
      expect(fake.presenceListeners).toEqual(new Map());
      for (const channel of fake.channels.values()) {
        expect(channel.subscribe as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
        expect(channel.presence.subscribe as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
        expect(channel.presence.enter as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      }
    };

    await connect({});
    await connect(new Proxy({}, {
      get: (_target, key) => {
        if (key === "then") return undefined;
        throw new Error("hostile client getter");
      },
    }));

    const malformedChannels = fakeClient();
    await connect({ ...malformedChannels.client, channels: {} }, malformedChannels);
    const hostileChannels = fakeClient();
    await connect(Object.defineProperty({ ...hostileChannels.client }, "channels", {
      get: () => { throw new Error("hostile channels getter"); },
    }), hostileChannels);

    const malformedChannel = fakeClient();
    await connect({ ...malformedChannel.client, channels: { get: vi.fn(() => ({})) } }, malformedChannel);
    const hostileChannel = fakeClient();
    await connect({ ...hostileChannel.client, channels: { get: vi.fn(() => new Proxy({}, {
      get: () => { throw new Error("hostile channel getter"); },
    })) } }, hostileChannel);

    const malformedPresence = fakeClient();
    const channelWithoutPresence = {
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(),
      publish: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      presence: {},
    };
    await connect({ ...malformedPresence.client, channels: { get: vi.fn(() => channelWithoutPresence) } }, malformedPresence);
    expect(channelWithoutPresence.subscribe).not.toHaveBeenCalled();

    const hostilePresence = fakeClient();
    const channelWithHostilePresence = {
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(),
      publish: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      get presence() { throw new Error("hostile presence getter"); },
    };
    await connect({ ...hostilePresence.client, channels: { get: vi.fn(() => channelWithHostilePresence) } }, hostilePresence);
    expect(channelWithHostilePresence.subscribe).not.toHaveBeenCalled();

    const malformedConnection = fakeClient();
    await connect({ ...malformedConnection.client, connection: {} }, malformedConnection);
    const hostileConnection = fakeClient();
    await connect(Object.defineProperty({ ...hostileConnection.client }, "connection", {
      get: () => { throw new Error("hostile connection getter"); },
    }), hostileConnection);
  });

  it("turns an immediate preflight getter failure into a generic error without leaking provider text or starting live work", async () => {
    const fake = fakeClient();
    const providerSecret = "provider-secret-preflight";
    const candidate = Object.defineProperty({ ...fake.client }, "connection", {
      get: () => { throw new Error(providerSecret); },
    });
    const adapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => candidate as AblyRealtimeClient,
      now: () => 1_000_000,
    });

    const failure = await adapter.connect({
      scope,
      token: tokenRequest({ [names().world]: ["subscribe"], [names().presence]: ["subscribe"] }),
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    }).catch((error: unknown) => error);

    expect(failure).toEqual(expect.objectContaining({ message: "Realtime client contract is invalid" }));
    expect(String(failure)).not.toContain(providerSecret);
    expect(fake.connectionListeners).toEqual([]);
    expect(fake.listeners).toEqual(new Map());
    expect(fake.presenceListeners).toEqual(new Map());
  });

  it("uses the preflight-captured client, connection, channel, and presence methods through connect and cleanup", async () => {
    const fake = fakeClient();
    const world = fake.get(names().world);
    const presence = fake.get(names().presence);
    const reads = new Map<string, number>();
    const providerSecret = "provider-secret-after-preflight";
    const once = <T,>(value: T, name: string): PropertyDescriptor => ({
      enumerable: true,
      get: () => {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        if (count > 1) throw new Error(`${providerSecret}:${name}`);
        return value;
      },
    });
    const unstablePresence = (source: AblyRoomChannel["presence"], name: string) => Object.defineProperties({}, {
      subscribe: once(source.subscribe, `${name}.subscribe`),
      unsubscribe: once(source.unsubscribe, `${name}.unsubscribe`),
      enter: once(source.enter, `${name}.enter`),
      update: once(source.update, `${name}.update`),
      leave: once(source.leave, `${name}.leave`),
    });
    const unstableChannel = (source: AblyRoomChannel, name: string) => Object.defineProperties({}, {
      subscribe: once(source.subscribe, `${name}.subscribe`),
      unsubscribe: once(source.unsubscribe, `${name}.unsubscribe`),
      publish: once(source.publish, `${name}.publish`),
      detach: once(source.detach, `${name}.detach`),
      presence: once(unstablePresence(source.presence, `${name}.presence`), `${name}.presence`),
    });
    const channels = {
      get: vi.fn((name: string) => name === names().world
        ? unstableChannel(world, "world")
        : name === names().presence
          ? unstableChannel(presence, "presence")
          : undefined),
    };
    const connection = Object.defineProperties({}, {
      on: once(fake.on, "connection.on"),
      off: once(fake.off, "connection.off"),
    });
    const candidate = Object.defineProperties({}, {
      channels: once(channels, "client.channels"),
      connection: once(connection, "client.connection"),
      connect: once(fake.client.connect, "client.connect"),
      close: once(fake.client.close, "client.close"),
    });
    const adapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => candidate as AblyRealtimeClient,
      now: () => 1_000_000,
    });

    const subscription = await adapter.connect({
      scope,
      token: tokenRequest({ [names().world]: ["publish", "subscribe"], [names().presence]: ["presence", "subscribe"] }),
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    });
    await subscription.publish?.(envelope("world.transition", "toctou-world"));
    await subscription.publish?.(envelope("presence.heartbeat", "toctou-presence"));
    await subscription.publish?.(envelope("presence.leave", "toctou-leave"));
    await subscription.unsubscribe();

    expect(Object.fromEntries(reads)).toEqual(expect.objectContaining({
      "client.channels": 1,
      "client.connection": 1,
      "client.connect": 1,
      "client.close": 1,
      "connection.on": 1,
      "connection.off": 1,
      "world.subscribe": 1,
      "world.unsubscribe": 1,
      "world.publish": 1,
      "world.detach": 1,
      "world.presence": 1,
      "world.presence.subscribe": 1,
      "world.presence.unsubscribe": 1,
      "world.presence.enter": 1,
      "world.presence.update": 1,
      "world.presence.leave": 1,
      "presence.subscribe": 1,
      "presence.unsubscribe": 1,
      "presence.publish": 1,
      "presence.detach": 1,
      "presence.presence": 1,
      "presence.presence.subscribe": 1,
      "presence.presence.unsubscribe": 1,
      "presence.presence.enter": 1,
      "presence.presence.update": 1,
      "presence.presence.leave": 1,
    }));
    expect(JSON.stringify([...reads])).not.toContain(providerSecret);
    expect(fake.client.close).toHaveBeenCalledTimes(1);
  });

  it("contains provider secrets from startup on, subscribe, presence subscribe, and connect failures", async () => {
    const cases: Array<{
      name: string;
      capability: Record<string, string[]>;
      configure: (fake: ReturnType<typeof fakeClient>, providerSecret: string) => AblyRealtimeClient;
    }> = [
      {
        name: "connection on",
        capability: { [names().world]: ["subscribe"] },
        configure: (fake, providerSecret) => ({
          ...fake.client,
          connection: { ...fake.client.connection, on: vi.fn(() => { throw new Error(providerSecret); }) },
        }),
      },
      {
        name: "channel subscribe",
        capability: { [names().world]: ["subscribe"] },
        configure: (fake, providerSecret) => {
          const world = fake.get(names().world) as unknown as { subscribe: (listener: unknown) => Promise<unknown> };
          world.subscribe = vi.fn(async () => { throw new Error(providerSecret); });
          return fake.client;
        },
      },
      {
        name: "presence subscribe",
        capability: { [names().presence]: ["subscribe"] },
        configure: (fake, providerSecret) => {
          const presence = fake.get(names().presence).presence as unknown as { subscribe: (listener: unknown) => Promise<void> };
          presence.subscribe = vi.fn(async () => { throw new Error(providerSecret); });
          return fake.client;
        },
      },
      {
        name: "connect",
        capability: { [names().world]: ["subscribe"] },
        configure: (fake, providerSecret) => ({ ...fake.client, connect: vi.fn(() => { throw new Error(providerSecret); }) }),
      },
    ];

    for (const { name, capability, configure } of cases) {
      const fake = fakeClient();
      const providerSecret = `provider-secret-startup-${name}`;
      const adapter = createDevelopmentAblyRoomTransport({
        environment: "preview",
        clientFactory: async () => configure(fake, providerSecret),
        now: () => 1_000_000,
      });
      await expectGenericProviderFailure(() => adapter.connect({
        scope,
        token: tokenRequest(capability),
        connectionEpoch: 1,
        onMessage: vi.fn(),
        onFailure: vi.fn(),
      }), providerSecret);
    }
  });

  it("contains rejected thenables from void on, connect, and off methods without hangs or unhandled provider rejections", async () => {
    const run = async (
      name: string,
      configure: (fake: ReturnType<typeof fakeClient>, providerSecret: string, cleanupSecret: string) => AblyRealtimeClient,
      expectedMessage = "Realtime connection is unavailable",
    ) => {
      const fake = fakeClient();
      const providerSecret = `provider-secret-thenable-${name}`;
      const cleanupSecret = `provider-secret-cleanup-thenable-${name}`;
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", observeUnhandled);
      try {
        const adapter = createDevelopmentAblyRoomTransport({
          environment: "preview",
          clientFactory: async () => configure(fake, providerSecret, cleanupSecret),
          connectionReadyTimeoutMs: 5,
          now: () => 1_000_000,
        });
        const failure = await adapter.connect({
          scope,
          token: tokenRequest({ [names().world]: ["subscribe"] }),
          connectionEpoch: 1,
          onMessage: vi.fn(),
          onFailure: vi.fn(),
        }).catch((error: unknown) => error);
        expect(failure).toEqual(expect.objectContaining({ message: expectedMessage }));
        expect(String(failure)).not.toContain(providerSecret);
        expect(String(failure)).not.toContain(cleanupSecret);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", observeUnhandled);
      }
    };

    await run("on-with-cleanup", (fake, providerSecret, cleanupSecret) => ({
      ...fake.client,
      connection: {
        ...fake.client.connection,
        on: vi.fn((events, listener) => {
          fake.on(events, listener);
          return Promise.reject(new Error(providerSecret));
        }),
        off: vi.fn(() => Promise.reject(new Error(cleanupSecret))),
      },
    }));
    await run("connect-with-cleanup", (fake, providerSecret, cleanupSecret) => ({
      ...fake.client,
      connect: vi.fn(() => Promise.reject(new Error(providerSecret))),
      connection: { ...fake.client.connection, off: vi.fn(() => Promise.reject(new Error(cleanupSecret))) },
    }));
    await run("off", (fake, _providerSecret, cleanupSecret) => ({
      ...fake.client,
      connection: { ...fake.client.connection, off: vi.fn(() => Promise.reject(new Error(cleanupSecret))) },
    }));
  });

  it("keeps a late connection-on thenable inert after the readiness deadline", async () => {
    const fake = fakeClient();
    const providerSecret = "provider-secret-late-connection-on";
    let resolveFirstOn: (() => void) | undefined;
    const firstOn = new Promise<void>((resolve) => { resolveFirstOn = resolve; });
    const on = vi.fn(() => {
      if (on.mock.calls.length === 1) return firstOn;
      throw new Error(providerSecret);
    });
    let deadline: (() => void) | undefined;
    const timer = {
      setTimeout: vi.fn((callback: () => void, delayMs: number) => {
        expect(delayMs).toBe(5);
        deadline = callback;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    };
    const adapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => ({ ...fake.client, connection: { ...fake.client.connection, on } }),
      connectionReadyTimeoutMs: 5,
      providerOperationTimeoutMs: 5,
      timer,
      now: () => 1_000_000,
    });
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const pending = adapter.connect({
        scope,
        token: tokenRequest({ [names().world]: ["subscribe"] }),
        connectionEpoch: 1,
        onMessage: vi.fn(),
        onFailure: vi.fn(),
      });
      await vi.waitFor(() => expect(on).toHaveBeenCalledTimes(1));
      deadline?.();
      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toEqual(expect.objectContaining({ message: "Realtime connection is unavailable" }));
      expect(String(failure)).not.toContain(providerSecret);

      resolveFirstOn?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(on).toHaveBeenCalledTimes(1);
      expect(fake.client.connect).not.toHaveBeenCalled();
      expect(fake.connectionListeners).toEqual([]);
      expect(fake.listeners).toEqual(new Map());
      expect(fake.presenceListeners).toEqual(new Map());
      await vi.waitFor(() => expect(fake.client.close).toHaveBeenCalledTimes(1));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("bounds a never-settling provider subscribe and contains its late settlement", async () => {
    const fake = fakeClient();
    const scheduler = controlledTimer();
    const providerSecret = "provider-secret-timeout-subscribe";
    const rawSubscription = deferred<void>();
    const world = fake.get(names().world) as unknown as { subscribe: (listener: unknown) => Promise<void> };
    const eagerSubscribe = world.subscribe;
    world.subscribe = vi.fn(async (listener) => {
      await eagerSubscribe(listener as never);
      await rawSubscription.promise;
      await eagerSubscribe(listener as never);
    });
    const adapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => fake.client,
      timer: scheduler.timer,
      connectionReadyTimeoutMs: 50,
      providerOperationTimeoutMs: 7,
      now: () => 1_000_000,
    } as never);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const pending = adapter.connect({
        scope,
        token: tokenRequest({ [names().world]: ["subscribe"] }),
        connectionEpoch: 1,
        onMessage: vi.fn(),
        onFailure: vi.fn(),
      });
      await vi.waitFor(() => expect(world.subscribe).toHaveBeenCalledTimes(1));
      scheduler.fire(7);
      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toEqual(expect.objectContaining({ message: "Realtime subscription is unavailable" }));
      expect(String(failure)).not.toContain(providerSecret);
      expect(fake.listeners.get(names().world) ?? []).toEqual([]);
      expect(fake.presenceListeners).toEqual(new Map());
      expect((fake.channels.get(names().world)!.unsubscribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
      expect(fake.client.close).toHaveBeenCalledTimes(1);

      rawSubscription.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fake.listeners.get(names().world) ?? []).toEqual([]);
      expect(fake.presenceListeners).toEqual(new Map());
      expect((fake.channels.get(names().world)!.unsubscribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("bounds client-factory resolution and makes rejected, throwing, and late candidates inert", async () => {
    const providerSecret = "provider-secret-client-factory";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    const connectInput = {
      scope,
      token: tokenRequest({ [names().world]: ["subscribe"] }),
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    };
    const assertImmediateFailure = async (clientFactory: () => Promise<AblyRealtimeClient>) => {
      const adapter = createDevelopmentAblyRoomTransport({
        environment: "preview",
        clientFactory,
        providerOperationTimeoutMs: 7,
        now: () => 1_000_000,
      });
      const failure = await adapter.connect(connectInput).catch((error: unknown) => error);
      expect(failure).toEqual(expect.objectContaining({ message: expect.stringMatching(/^Realtime /) }));
      expect(String(failure)).not.toContain(providerSecret);
    };
    const assertLateCandidate = async (candidate: unknown, assertCandidate: () => void) => {
      const scheduler = controlledTimer();
      const lateClient = deferred<unknown>();
      const factory = vi.fn(() => lateClient.promise as Promise<AblyRealtimeClient>);
      const adapter = createDevelopmentAblyRoomTransport({
        environment: "preview",
        clientFactory: factory,
        timer: scheduler.timer,
        connectionReadyTimeoutMs: 50,
        providerOperationTimeoutMs: 7,
        now: () => 1_000_000,
      });
      const pending = adapter.connect(connectInput);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
      scheduler.fire(7);
      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toEqual(expect.objectContaining({ message: expect.stringMatching(/^Realtime /) }));
      expect(String(failure)).not.toContain(providerSecret);
      lateClient.resolve(candidate);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertCandidate();
    };
    try {
      await assertImmediateFailure(async () => { throw new Error(providerSecret); });
      await assertImmediateFailure(() => { throw new Error(providerSecret); });

      const lateValid = fakeClient();
      await assertLateCandidate(lateValid.client, () => {
        expect(lateValid.get).not.toHaveBeenCalled();
        expect(lateValid.on).not.toHaveBeenCalled();
        expect(lateValid.client.connect).not.toHaveBeenCalled();
        expect(lateValid.listeners).toEqual(new Map());
        expect(lateValid.presenceListeners).toEqual(new Map());
      });
      await vi.waitFor(() => expect(lateValid.client.close).toHaveBeenCalledTimes(1));

      await assertLateCandidate({}, () => undefined);
      const hostileLateCandidate = new Proxy({}, {
        get: (_target, key) => {
          if (key === "then") return undefined;
          throw new Error(providerSecret);
        },
      });
      await assertLateCandidate(hostileLateCandidate, () => undefined);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("bounds never-settling publish and presence operations without mutating late local state", async () => {
    const scheduler = controlledTimer();
    const providerSecret = "provider-secret-timeout-publish";
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const publishFake = fakeClient();
      const publishDeferred = deferred<unknown>();
      const world = publishFake.get(names().world) as unknown as { publish: (name: string, data: unknown) => Promise<unknown> };
      world.publish = vi.fn(() => publishDeferred.promise);
      const publishAdapter = createDevelopmentAblyRoomTransport({
        environment: "preview", clientFactory: async () => publishFake.client, timer: scheduler.timer,
        connectionReadyTimeoutMs: 50, providerOperationTimeoutMs: 7, now: () => 1_000_000,
      } as never);
      const publishSubscription = await publishAdapter.connect({
        scope, token: tokenRequest({ [names().world]: ["publish"] }), connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn(),
      });
      const pendingPublish = Promise.resolve(publishSubscription.publish!(envelope("world.transition", "timeout-publish")));
      await vi.waitFor(() => expect(world.publish).toHaveBeenCalledTimes(1));
      scheduler.fire(7);
      const publishFailure = await pendingPublish.catch((error: unknown) => error);
      expect(publishFailure).toEqual(expect.objectContaining({ message: "Realtime publish is unavailable" }));
      expect(String(publishFailure)).not.toContain(providerSecret);
      publishDeferred.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await publishSubscription.unsubscribe();

      const presenceFake = fakeClient();
      const enterDeferred = deferred<void>();
      const presence = presenceFake.get(names().presence).presence as unknown as {
        enter: (data?: unknown) => Promise<void>;
        leave: (data?: unknown) => Promise<void>;
      };
      const eagerEnter = presence.enter;
      const eagerLeave = presence.leave;
      presence.enter = vi.fn(async (data?: unknown) => {
        await eagerEnter(data);
        await enterDeferred.promise;
        await eagerEnter(data);
      });
      const presenceAdapter = createDevelopmentAblyRoomTransport({
        environment: "preview", clientFactory: async () => presenceFake.client, timer: scheduler.timer,
        connectionReadyTimeoutMs: 50, providerOperationTimeoutMs: 7, now: () => 1_000_000,
      } as never);
      const presenceSubscription = await presenceAdapter.connect({
        scope, token: tokenRequest({ [names().presence]: ["presence"] }), connectionEpoch: 1, onMessage: vi.fn(), onFailure: vi.fn(),
      });
      const pendingEnter = Promise.resolve(presenceSubscription.publish!(envelope("presence.heartbeat", "timeout-enter")));
      await vi.waitFor(() => expect(presence.enter).toHaveBeenCalledTimes(1));
      scheduler.fire(7);
      const enterFailure = await pendingEnter.catch((error: unknown) => error);
      expect(enterFailure).toEqual(expect.objectContaining({ message: "Realtime publish is unavailable" }));
      expect(String(enterFailure)).not.toContain(providerSecret);
      expect(eagerLeave).toHaveBeenCalledTimes(1);
      enterDeferred.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(eagerLeave).toHaveBeenCalledTimes(2);
      await presenceSubscription.publish!(envelope("presence.leave", "timeout-enter-late-leave"));
      expect(eagerLeave).toHaveBeenCalledTimes(2);
      await presenceSubscription.unsubscribe();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("bounds cleanup despite a never-settling provider unsubscribe and keeps the closed session inert after late settlement", async () => {
    const fake = fakeClient();
    const scheduler = controlledTimer();
    const providerSecret = "provider-secret-timeout-cleanup";
    const rawUnsubscribe = deferred<void>();
    const received = vi.fn();
    const order: string[] = [];
    const world = fake.get(names().world) as unknown as {
      unsubscribe: (listener: unknown) => void;
      detach: () => Promise<void>;
    };
    const presenceChannel = fake.get(names().presence) as unknown as {
      detach: () => Promise<void>;
      presence: unknown;
    };
    const presence = presenceChannel.presence as {
      unsubscribe: (listener: unknown) => void;
      leave: (data?: unknown) => Promise<void>;
    };
    const eagerUnsubscribe = world.unsubscribe;
    world.unsubscribe = vi.fn((listener) => {
      order.push("world.unsubscribe");
      eagerUnsubscribe(listener as never);
      return rawUnsubscribe.promise as never;
    });
    const eagerPresenceUnsubscribe = presence.unsubscribe;
    presence.unsubscribe = vi.fn((listener) => {
      order.push("presence.unsubscribe");
      eagerPresenceUnsubscribe(listener as never);
    });
    const eagerPresenceLeave = presence.leave;
    presence.leave = vi.fn(async (data?: unknown) => {
      order.push("presence.leave");
      await eagerPresenceLeave(data);
    });
    const eagerWorldDetach = world.detach;
    world.detach = vi.fn(async () => {
      order.push("world.detach");
      await eagerWorldDetach();
    });
    const eagerPresenceDetach = presenceChannel.detach;
    presenceChannel.detach = vi.fn(async () => {
      order.push("presence.detach");
      await eagerPresenceDetach();
    });
    fake.off.mockImplementation((_events, listener) => {
      order.push("off");
      const index = fake.connectionListeners.findIndex((item) => item.listener === listener);
      if (index >= 0) fake.connectionListeners.splice(index, 1);
    });
    const close = vi.fn(() => {
      order.push("close");
      fake.client.close();
    });
    const adapter = createDevelopmentAblyRoomTransport({
      environment: "preview", clientFactory: async () => ({ ...fake.client, close }), timer: scheduler.timer,
      connectionReadyTimeoutMs: 50, providerOperationTimeoutMs: 7, now: () => 1_000_000,
    } as never);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const subscription = await adapter.connect({
        scope,
        token: tokenRequest({ [names().world]: ["subscribe"], [names().presence]: ["presence", "subscribe"] }),
        connectionEpoch: 1,
        onMessage: received,
        onFailure: vi.fn(),
      });
      await subscription.publish?.(envelope("presence.heartbeat", "cleanup-timeout-presence"));
      order.length = 0;
      const pendingCleanup = Promise.resolve(subscription.unsubscribe());
      await vi.waitFor(() => expect(world.unsubscribe).toHaveBeenCalledTimes(1));
      expect(order).toEqual(["off", "world.unsubscribe", "presence.unsubscribe"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      scheduler.fire(7);
      const cleanupFailure = await pendingCleanup.catch((error: unknown) => error);
      expect(cleanupFailure).toEqual(expect.objectContaining({ message: "Realtime cleanup failed" }));
      expect(String(cleanupFailure)).not.toContain(providerSecret);
      expect(order).toEqual([
        "off",
        "world.unsubscribe",
        "presence.unsubscribe",
        "presence.leave",
        "world.detach",
        "presence.detach",
        "close",
      ]);
      expect(close).toHaveBeenCalledTimes(1);
      expect(world.detach).toHaveBeenCalledTimes(1);
      expect(presenceChannel.detach).toHaveBeenCalledTimes(1);

      for (const listener of fake.listeners.get(names().world) ?? []) listener({ data: envelope("world.transition", "cleanup-timeout-late"), clientId: "rw_test" });
      expect(received).not.toHaveBeenCalled();
      rawUnsubscribe.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(subscription.unsubscribe()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("retries an explicit timed-out presence leave during cleanup before detach and close", async () => {
    const fake = fakeClient();
    const scheduler = controlledTimer();
    const providerSecret = "provider-secret-timeout-explicit-leave";
    const firstLeave = deferred<void>();
    const presenceChannel = fake.get(names().presence) as unknown as {
      detach: () => Promise<void>;
      presence: unknown;
    };
    const presence = presenceChannel.presence as { leave: (data?: unknown) => Promise<void> };
    let leaveCalls = 0;
    presence.leave = vi.fn(() => {
      leaveCalls += 1;
      return leaveCalls === 1 ? firstLeave.promise : Promise.resolve();
    });
    const order: string[] = [];
    const detach = presenceChannel.detach;
    presenceChannel.detach = vi.fn(async () => {
      order.push("detach");
      await detach();
    });
    const close = vi.fn(() => {
      order.push("close");
      fake.client.close();
    });
    const adapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => ({ ...fake.client, close }),
      timer: scheduler.timer,
      connectionReadyTimeoutMs: 50,
      providerOperationTimeoutMs: 7,
      now: () => 1_000_000,
    } as never);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const subscription = await adapter.connect({
        scope,
        token: tokenRequest({ [names().presence]: ["presence"] }),
        connectionEpoch: 1,
        onMessage: vi.fn(),
        onFailure: vi.fn(),
      });
      await subscription.publish?.(envelope("presence.heartbeat", "explicit-leave-enter"));
      const pendingLeave = Promise.resolve(subscription.publish!(envelope("presence.leave", "explicit-leave-timeout")));
      await vi.waitFor(() => expect(presence.leave).toHaveBeenCalledTimes(1));
      scheduler.fire(7);
      const leaveFailure = await pendingLeave.catch((error: unknown) => error);
      expect(leaveFailure).toEqual(expect.objectContaining({ message: "Realtime publish is unavailable" }));
      expect(String(leaveFailure)).not.toContain(providerSecret);

      await subscription.unsubscribe();
      expect(presence.leave).toHaveBeenCalledTimes(2);
      expect(order).toEqual(["detach", "close"]);
      expect(close).toHaveBeenCalledTimes(1);
      firstLeave.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(presence.leave).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("retries leave during cleanup when a timed-out update's compensating leave never settles", async () => {
    const fake = fakeClient();
    const scheduler = controlledTimer();
    const providerSecret = "provider-secret-timeout-update-compensation";
    const rawUpdate = deferred<void>();
    const rawCompensationLeave = deferred<void>();
    const presenceChannel = fake.get(names().presence) as unknown as {
      detach: () => Promise<void>;
      presence: unknown;
    };
    const presence = presenceChannel.presence as {
      update: (data?: unknown) => Promise<void>;
      leave: (data?: unknown) => Promise<void>;
    };
    const order: string[] = [];
    presence.update = vi.fn(() => rawUpdate.promise);
    let leaveCalls = 0;
    presence.leave = vi.fn(() => {
      leaveCalls += 1;
      order.push(`leave-${leaveCalls}`);
      return leaveCalls === 1 ? rawCompensationLeave.promise : Promise.resolve();
    });
    const detach = presenceChannel.detach;
    presenceChannel.detach = vi.fn(async () => {
      order.push("detach");
      await detach();
    });
    const close = vi.fn(() => {
      order.push("close");
      fake.client.close();
    });
    const adapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => ({ ...fake.client, close }),
      timer: scheduler.timer,
      connectionReadyTimeoutMs: 50,
      providerOperationTimeoutMs: 7,
      now: () => 1_000_000,
    } as never);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observeUnhandled);
    try {
      const subscription = await adapter.connect({
        scope,
        token: tokenRequest({ [names().presence]: ["presence"] }),
        connectionEpoch: 1,
        onMessage: vi.fn(),
        onFailure: vi.fn(),
      });
      await subscription.publish?.(envelope("presence.heartbeat", "update-timeout-enter"));
      const pendingUpdate = Promise.resolve(subscription.publish!(envelope("presence.heartbeat", "update-timeout")));
      await vi.waitFor(() => expect(presence.update).toHaveBeenCalledTimes(1));
      scheduler.fire(7);
      const updateFailure = await pendingUpdate.catch((error: unknown) => error);
      expect(updateFailure).toEqual(expect.objectContaining({ message: "Realtime publish is unavailable" }));
      expect(String(updateFailure)).not.toContain(providerSecret);
      await vi.waitFor(() => expect(presence.leave).toHaveBeenCalledTimes(1));

      await subscription.unsubscribe();
      expect(presence.leave).toHaveBeenCalledTimes(2);
      expect(order).toEqual(["leave-1", "leave-2", "detach", "close"]);
      expect(close).toHaveBeenCalledTimes(1);
      rawUpdate.resolve();
      rawCompensationLeave.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(presence.leave).toHaveBeenCalledTimes(3);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("contains provider secrets from publish and every presence mutation", async () => {
    const run = async (
      name: string,
      action: (subscription: Awaited<ReturnType<ReturnType<typeof createDevelopmentAblyRoomTransport>["connect"]>>) => Promise<unknown>,
      configure: (fake: ReturnType<typeof fakeClient>, providerSecret: string) => void,
    ) => {
      const fake = fakeClient();
      const providerSecret = `provider-secret-publish-${name}`;
      configure(fake, providerSecret);
      const adapter = createDevelopmentAblyRoomTransport({ environment: "preview", clientFactory: async () => fake.client, now: () => 1_000_000 });
      const subscription = await adapter.connect({
        scope,
        token: tokenRequest({ [names().world]: ["publish"], [names().presence]: ["presence"] }),
        connectionEpoch: 1,
        onMessage: vi.fn(),
        onFailure: vi.fn(),
      });
      await expectGenericProviderFailure(() => action(subscription), providerSecret);
    };

    await run("publish", async (subscription) => { await subscription.publish!(envelope("world.transition", "provider-publish")); }, (fake, providerSecret) => {
      const world = fake.get(names().world) as unknown as { publish: (name: string, data: unknown) => Promise<unknown> };
      world.publish = vi.fn(async () => { throw new Error(providerSecret); });
    });
    await run("presence-enter", async (subscription) => { await subscription.publish!(envelope("presence.heartbeat", "provider-enter")); }, (fake, providerSecret) => {
      const presence = fake.get(names().presence).presence as unknown as { enter: (data?: unknown) => Promise<void> };
      presence.enter = vi.fn(async () => { throw new Error(providerSecret); });
    });
    await run("presence-update", async (subscription) => {
      await subscription.publish!(envelope("presence.heartbeat", "provider-update-1"));
      await subscription.publish!(envelope("presence.heartbeat", "provider-update-2"));
    }, (fake, providerSecret) => {
      const presence = fake.get(names().presence).presence as unknown as { update: (data?: unknown) => Promise<void> };
      presence.update = vi.fn(async () => { throw new Error(providerSecret); });
    });
    await run("presence-leave", async (subscription) => {
      await subscription.publish!(envelope("presence.heartbeat", "provider-leave-1"));
      await subscription.publish!(envelope("presence.leave", "provider-leave-2"));
    }, (fake, providerSecret) => {
      const presence = fake.get(names().presence).presence as unknown as { leave: (data?: unknown) => Promise<void> };
      presence.leave = vi.fn(async () => { throw new Error(providerSecret); });
    });
  });

  it("uses the generic startup failure over cleanup failures and performs best-effort idempotent cleanup", async () => {
    const fake = fakeClient();
    const startupSecret = "provider-secret-startup-precedence";
    const cleanupSecret = "provider-secret-cleanup-precedence";
    const world = fake.get(names().world) as unknown as {
      subscribe: (listener: unknown) => Promise<unknown>;
      detach: () => Promise<void>;
    };
    world.subscribe = vi.fn(async () => { throw new Error(startupSecret); });
    world.detach = vi.fn(async () => { throw new Error(cleanupSecret); });
    const close = vi.fn(() => { throw new Error(cleanupSecret); });
    const startupAdapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => ({ ...fake.client, close }),
      now: () => 1_000_000,
    });
    await expectGenericProviderFailure(() => startupAdapter.connect({
      scope,
      token: tokenRequest({ [names().world]: ["subscribe"] }),
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    }), startupSecret);
    expect(world.detach).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    const cleanupFake = fakeClient();
    const cleanupWorld = cleanupFake.get(names().world) as unknown as {
      unsubscribe: (listener: unknown) => void;
      detach: () => Promise<void>;
    };
    const cleanupPresence = cleanupFake.get(names().presence).presence as unknown as {
      unsubscribe: (listener: unknown) => void;
      leave: (data?: unknown) => Promise<void>;
    };
    cleanupWorld.unsubscribe = vi.fn(() => { throw new Error(cleanupSecret); });
    cleanupWorld.detach = vi.fn(async () => { throw new Error(cleanupSecret); });
    cleanupPresence.unsubscribe = vi.fn(() => { throw new Error(cleanupSecret); });
    cleanupPresence.leave = vi.fn(async () => { throw new Error(cleanupSecret); });
    let offCalls = 0;
    cleanupFake.off.mockImplementation(() => {
      offCalls += 1;
      if (offCalls > 2) throw new Error(cleanupSecret);
    });
    const cleanupClose = vi.fn(() => { throw new Error(cleanupSecret); });
    const cleanupAdapter = createDevelopmentAblyRoomTransport({
      environment: "preview",
      clientFactory: async () => ({ ...cleanupFake.client, close: cleanupClose }),
      now: () => 1_000_000,
    });
    const subscription = await cleanupAdapter.connect({
      scope,
      token: tokenRequest({ [names().world]: ["subscribe"], [names().presence]: ["presence", "subscribe"] }),
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    });
    await subscription.publish?.(envelope("presence.heartbeat", "cleanup-presence"));
    await expectGenericProviderFailure(async () => { await subscription.unsubscribe(); }, cleanupSecret);
    await expect(subscription.unsubscribe()).resolves.toBeUndefined();
    expect(cleanupWorld.unsubscribe).toHaveBeenCalledTimes(1);
    expect(cleanupPresence.unsubscribe).toHaveBeenCalledTimes(1);
    expect(cleanupPresence.leave).toHaveBeenCalledTimes(1);
    expect(cleanupWorld.detach).toHaveBeenCalledTimes(1);
    expect(cleanupClose).toHaveBeenCalledTimes(1);
  });

  it("keeps local capability and envelope validation failures distinct from a provider publish failure", async () => {
    const fake = fakeClient();
    const providerSecret = "provider-secret-should-not-run";
    const world = fake.get(names().world) as unknown as { publish: (name: string, data: unknown) => Promise<unknown> };
    world.publish = vi.fn(async () => { throw new Error(providerSecret); });
    const adapter = createDevelopmentAblyRoomTransport({ environment: "preview", clientFactory: async () => fake.client, now: () => 1_000_000 });
    const subscription = await adapter.connect({
      scope,
      token: tokenRequest({ [names().world]: ["subscribe"] }),
      connectionEpoch: 1,
      onMessage: vi.fn(),
      onFailure: vi.fn(),
    });

    await expect(subscription.publish?.(envelope("world.transition", "local-capability"))).rejects.toThrow("not granted");
    await expect(subscription.publish?.({ ...envelope("world.transition", "local-envelope"), roomId: "other_room" })).rejects.toThrow("outside");
    expect(world.publish).not.toHaveBeenCalled();
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
    await expect(pending).rejects.toThrow("Realtime connection is unavailable");
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
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Realtime connection is unavailable" }));
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
