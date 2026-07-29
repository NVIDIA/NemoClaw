// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import type { Server } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_VOICE_ACCESS_LISTEN_PORT,
  DEFAULT_VOICE_ACCESS_UPSTREAM_PORT,
  runVoiceAccessGatewayAction,
  type VoiceAccessGatewayActionDeps,
} from "./serve";

class FakeServer extends EventEmitter {
  closeCalls = 0;
  listenCall: { host: string; port: number } | null = null;
  listening = false;

  listen(port: number, host: string, callback: () => void): this {
    this.listenCall = { host, port };
    this.listening = true;
    queueMicrotask(callback);
    return this;
  }

  close(callback?: (error?: Error) => void): this {
    this.closeCalls += 1;
    this.listening = false;
    this.emit("close");
    callback?.();
    return this;
  }
}

function actionDeps(
  server: FakeServer,
  signals: EventEmitter,
  overrides: Partial<VoiceAccessGatewayActionDeps> = {},
): VoiceAccessGatewayActionDeps {
  return {
    createServer: vi.fn(() => server as unknown as Server),
    log: vi.fn(),
    processEvents: signals as unknown as VoiceAccessGatewayActionDeps["processEvents"],
    readTokenFile: vi.fn(() => "test-bearer-token"),
    ...overrides,
  };
}

describe("voice access gateway action", () => {
  it.each([
    "SIGINT",
    "SIGTERM",
  ] as const)("binds the default ports to loopback and closes on %s", async (signal) => {
    const server = new FakeServer();
    const signals = new EventEmitter();
    const deps = actionDeps(server, signals);

    const running = runVoiceAccessGatewayAction(
      { tokenFile: "/run/secrets/voice-access-token" },
      deps,
    );
    await vi.waitFor(() => {
      expect(server.listenCall).toEqual({
        host: "127.0.0.1",
        port: DEFAULT_VOICE_ACCESS_LISTEN_PORT,
      });
    });

    expect(deps.readTokenFile).toHaveBeenCalledWith("/run/secrets/voice-access-token");
    expect(deps.createServer).toHaveBeenCalledWith({
      authToken: "test-bearer-token",
      upstreamPort: DEFAULT_VOICE_ACCESS_UPSTREAM_PORT,
    });
    await vi.waitFor(() => {
      expect(deps.log).toHaveBeenCalledWith(
        `Voice access gateway listening on http://127.0.0.1:${DEFAULT_VOICE_ACCESS_LISTEN_PORT} and forwarding to http://127.0.0.1:${DEFAULT_VOICE_ACCESS_UPSTREAM_PORT}.`,
      );
    });

    signals.emit(signal);
    await running;

    expect(server.closeCalls).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it.each([
    {
      name: "relative token path",
      options: { tokenFile: "relative/token" },
      message: "token file path must be absolute",
    },
    {
      name: "privileged listen port",
      options: { tokenFile: "/run/token", listenPort: 1023 },
      message: "listen port must be an integer between 1024 and 65535",
    },
    {
      name: "out-of-range upstream port",
      options: { tokenFile: "/run/token", upstreamPort: 65_536 },
      message: "upstream port must be an integer between 1024 and 65535",
    },
    {
      name: "shared listen and upstream port",
      options: { tokenFile: "/run/token", listenPort: 18_800, upstreamPort: 18_800 },
      message: "listen and upstream ports must be different",
    },
  ])("rejects $name before reading credentials", async ({ options, message }) => {
    const readTokenFile = vi.fn(() => "unused");
    const createServer = vi.fn();

    await expect(
      runVoiceAccessGatewayAction(options, {
        createServer: createServer as VoiceAccessGatewayActionDeps["createServer"],
        readTokenFile,
      }),
    ).rejects.toThrow(message);

    expect(readTokenFile).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  it("removes signal handlers when the loopback listener cannot start", async () => {
    class FailingServer extends FakeServer {
      override listen(): this {
        queueMicrotask(() => this.emit("error", new Error("address already in use")));
        return this;
      }
    }

    const server = new FailingServer();
    const signals = new EventEmitter();

    await expect(
      runVoiceAccessGatewayAction(
        { tokenFile: "/run/secrets/voice-access-token" },
        actionDeps(server, signals),
      ),
    ).rejects.toThrow("address already in use");

    expect(server.closeCalls).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes and removes signal handlers after a runtime listener error", async () => {
    const server = new FakeServer();
    const signals = new EventEmitter();
    const deps = actionDeps(server, signals);
    const running = runVoiceAccessGatewayAction(
      { tokenFile: "/run/secrets/voice-access-token" },
      deps,
    );
    await vi.waitFor(() => expect(deps.log).toHaveBeenCalledOnce());
    const rejection = expect(running).rejects.toThrow("runtime listener failure");

    server.emit("error", new Error("runtime listener failure"));

    await rejection;
    expect(server.closeCalls).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
