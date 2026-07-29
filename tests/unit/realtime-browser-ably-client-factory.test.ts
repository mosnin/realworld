import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  Realtime: vi.fn(),
  moduleLoads: 0,
}));

vi.mock("ably", () => {
  seams.moduleLoads += 1;
  return { default: { Realtime: seams.Realtime } };
});

import { createBrowserAblyClientFactory } from "../../app/realtime/browser-ably-client-factory";

const tokenRequest = {
  keyName: "preview.key",
  nonce: "nonce-1234567890123456",
  mac: "signed-mac",
  capability: "{}",
  timestamp: 1_700_000_000_000,
};

function fakeRealtimeClient() {
  const channel = {
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(),
    publish: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    presence: {
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(),
      enter: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
    },
  };
  return {
    channel,
    channels: { get: vi.fn(() => channel) },
    connection: { on: vi.fn(), off: vi.fn() },
    connect: vi.fn(),
    close: vi.fn(),
  };
}

describe("browser Ably client factory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    seams.Realtime.mockReset();
  });

  it("constructs zero clients outside exact non-production browser environments", () => {
    vi.stubGlobal("window", {});
    for (const environment of [undefined, "production", "staging", "preview ", "Preview"]) {
      expect(createBrowserAblyClientFactory(environment)).toBeUndefined();
    }
    expect(seams.moduleLoads).toBe(0);
    expect(seams.Realtime).not.toHaveBeenCalled();
  });

  it("is inert during server rendering even for a valid public environment", () => {
    expect(createBrowserAblyClientFactory("preview")).toBeUndefined();
    expect(seams.Realtime).not.toHaveBeenCalled();
  });

  it("maps the official client contract from only the signed TokenRequest", async () => {
    vi.stubGlobal("window", {});
    const realtime = fakeRealtimeClient();
    seams.Realtime.mockImplementation(function () { return realtime; });

    const factory = createBrowserAblyClientFactory("preview");
    expect(factory).toBeTypeOf("function");
    const client = await factory!(tokenRequest);

    expect(seams.Realtime).toHaveBeenCalledWith(expect.objectContaining({ autoConnect: false, authCallback: expect.any(Function) }));
    const authCallback = seams.Realtime.mock.calls[0]?.[0]?.authCallback as ((params: unknown, callback: (error: unknown, token: unknown) => void) => void) | undefined;
    const callback = vi.fn();
    authCallback?.({}, callback);
    expect(callback).toHaveBeenCalledWith(null, tokenRequest);
    expect(seams.moduleLoads).toBe(1);

    const room = client.channels.get("rw:preview:mission:mission_a:room:room_a:interaction");
    expect(realtime.channels.get).toHaveBeenCalledWith("rw:preview:mission:mission_a:room:room_a:interaction");
    const messageListener = vi.fn();
    await room.subscribe(messageListener);
    const providerMessageListener = (realtime.channel.subscribe.mock.calls as unknown as unknown[][])[0]?.[0] as ((message: unknown) => void) | undefined;
    providerMessageListener?.({ data: { exact: true }, name: "interaction.selection", clientId: "rw_preview" });
    expect(messageListener).toHaveBeenCalledWith({ data: { exact: true }, name: "interaction.selection", clientId: "rw_preview" });
    room.unsubscribe(messageListener);
    expect(realtime.channel.unsubscribe).toHaveBeenCalledWith(providerMessageListener);
    await room.publish("interaction.selection", { x: 1 });
    await room.detach();
    expect(realtime.channel.publish).toHaveBeenCalledWith("interaction.selection", { x: 1 });
    expect(realtime.channel.detach).toHaveBeenCalledTimes(1);

    const presenceListener = vi.fn();
    await room.presence.subscribe(presenceListener);
    const providerPresenceListener = (realtime.channel.presence.subscribe.mock.calls as unknown as unknown[][])[0]?.[0] as ((message: unknown) => void) | undefined;
    providerPresenceListener?.({ data: { room: "room_a" }, clientId: "rw_preview" });
    expect(presenceListener).toHaveBeenCalledWith({ data: { room: "room_a" }, name: undefined, clientId: "rw_preview" });
    room.presence.unsubscribe(presenceListener);
    await room.presence.enter({ state: "entered" });
    await room.presence.update({ state: "active" });
    await room.presence.leave({ state: "left" });
    expect(realtime.channel.presence.unsubscribe).toHaveBeenCalledWith(providerPresenceListener);
    expect(realtime.channel.presence.enter).toHaveBeenCalledWith({ state: "entered" });
    expect(realtime.channel.presence.update).toHaveBeenCalledWith({ state: "active" });
    expect(realtime.channel.presence.leave).toHaveBeenCalledWith({ state: "left" });

    const connectionListener = vi.fn();
    client.connection.on("connected", connectionListener);
    const providerConnectionListener = realtime.connection.on.mock.calls[0]?.[1] as ((state: unknown) => void) | undefined;
    providerConnectionListener?.({ current: "connected", reason: undefined });
    expect(connectionListener).toHaveBeenCalledWith({ current: "connected", reason: undefined });
    client.connection.off("connected", connectionListener);
    expect(realtime.connection.off).toHaveBeenCalledWith("connected", providerConnectionListener);
    client.connect();
    client.close();
    expect(realtime.connect).toHaveBeenCalledTimes(1);
    expect(realtime.close).toHaveBeenCalledTimes(1);
  });
});
