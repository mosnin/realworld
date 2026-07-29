"use client";

import type { RealtimeChannel, TokenRequest } from "ably";

import type {
  AblyClientFactory,
  AblyConnectionState,
  AblyInboundMessage,
  AblyRealtimeClient,
  AblyRoomChannel,
} from "@/lib/realtime/ably-room-transport";

export type BrowserAblyEnvironment = "development" | "test" | "preview";

function isBrowserAblyEnvironment(value: unknown): value is BrowserAblyEnvironment {
  return value === "development" || value === "test" || value === "preview";
}

type ProviderInboundMessage = { data?: unknown; name?: string; clientId?: string };
type ProviderConnectionState = { current?: string; reason?: unknown };

function messageForAdapter(message: ProviderInboundMessage): AblyInboundMessage {
  return { data: message.data, name: message.name, clientId: message.clientId };
}

function stateForAdapter(state: ProviderConnectionState): AblyConnectionState {
  return { current: state.current, reason: state.reason };
}

function adaptChannel(channel: RealtimeChannel): AblyRoomChannel {
  const messageListeners = new Map<(message: AblyInboundMessage) => void, (message: ProviderInboundMessage) => void>();
  const presenceListeners = new Map<(message: AblyInboundMessage) => void, (message: ProviderInboundMessage) => void>();

  return {
    subscribe: async (listener) => {
      const providerListener = (message: ProviderInboundMessage) => listener(messageForAdapter(message));
      messageListeners.set(listener, providerListener);
      await channel.subscribe(providerListener);
    },
    unsubscribe: (listener) => {
      const providerListener = messageListeners.get(listener);
      if (providerListener === undefined) return;
      channel.unsubscribe(providerListener);
      messageListeners.delete(listener);
    },
    publish: async (name, data) => { await channel.publish(name, data); },
    detach: async () => { await channel.detach(); },
    presence: {
      subscribe: async (listener) => {
        const providerListener = (message: ProviderInboundMessage) => listener(messageForAdapter(message));
        presenceListeners.set(listener, providerListener);
        await channel.presence.subscribe(providerListener);
      },
      unsubscribe: (listener) => {
        const providerListener = presenceListeners.get(listener);
        if (providerListener === undefined) return;
        channel.presence.unsubscribe(providerListener);
        presenceListeners.delete(listener);
      },
      enter: async (data) => { await channel.presence.enter(data); },
      update: async (data) => { await channel.presence.update(data); },
      leave: async (data) => { await channel.presence.leave(data); },
    },
  };
}

/**
 * Browser-only adapter for the official Ably Realtime SDK. It accepts only a
 * signed TokenRequest supplied by the authenticated Convex action; it never
 * reads a provider key or loads the provider runtime outside explicitly
 * non-production public environments.
 */
export function createBrowserAblyClientFactory(environment: unknown): AblyClientFactory | undefined {
  if (!isBrowserAblyEnvironment(environment) || typeof window === "undefined") return undefined;

  return async (tokenRequest: TokenRequest): Promise<AblyRealtimeClient> => {
    const { default: Ably } = await import("ably");
    const realtime = new Ably.Realtime({
      autoConnect: false,
      authCallback: (_params, callback) => callback(null, tokenRequest),
    });
    const connectionListeners = new Map<(state: AblyConnectionState) => void, (state: ProviderConnectionState) => void>();

    return {
      channels: { get: (name) => adaptChannel(realtime.channels.get(name)) },
      connection: {
        on: (events, listener) => {
          const providerListener = (state: ProviderConnectionState) => listener(stateForAdapter(state));
          connectionListeners.set(listener, providerListener);
          realtime.connection.on(events as never, providerListener as never);
        },
        off: (events, listener) => {
          const providerListener = connectionListeners.get(listener);
          if (providerListener === undefined) return;
          realtime.connection.off(events as never, providerListener as never);
          connectionListeners.delete(listener);
        },
      },
      connect: () => realtime.connect(),
      close: () => realtime.close(),
    };
  };
}
