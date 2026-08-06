// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import type { Server } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  assertVoiceGatewayEnabled,
  runVoiceGatewayServe,
  validateOpenClawGatewayUrl,
} from "./serve";

const OPTIONS = {
  deploymentCredentialFile: "/run/voice/deployment",
  openClawCredentialFile: "/run/voice/openclaw",
  gatewayUrl: "ws://127.0.0.1:18789/ws",
  runtimeIdentity: "voiceclaw-local",
  runtimeProfile: "voiceclaw-pinned",
  sandbox: "demo-sandbox",
  agent: "main",
};

describe("experimental voice gateway service gate", () => {
  it.each([undefined, "", "0", "true", "01"])("rejects feature value %s", (value) => {
    expect(() =>
      assertVoiceGatewayEnabled({
        NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: value,
      }),
    ).toThrow("disabled");
  });

  it("checks the exact feature gate before reading either credential (#8378)", async () => {
    const readBearerFile = vi.fn();
    const createServer = vi.fn();

    await expect(
      runVoiceGatewayServe(OPTIONS, {
        env: {
          NEMOCLAW_EXPERIMENTAL_OTHER_CAPABILITY: "1",
          NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: "0",
        },
        readBearerFile,
        createServer,
      }),
    ).rejects.toThrow("disabled");
    expect(readBearerFile).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });
});

describe("voice gateway destination validation", () => {
  it("accepts only a fixed credential-free loopback WebSocket URL", () => {
    expect(validateOpenClawGatewayUrl("ws://127.0.0.1:18789/ws")).toBe("ws://127.0.0.1:18789/ws");
  });

  it.each([
    "wss://127.0.0.1:18789/ws",
    "ws://localhost:18789/ws",
    "ws://10.0.0.2:18789/ws",
    "ws://user:secret@127.0.0.1:18789/ws",
    "ws://127.0.0.1:18789/other",
    "ws://127.0.0.1:18789/ws?target=other",
    "ws://127.0.0.1/ws",
  ])("rejects untrusted or ambiguous destination %s (#8378)", (value) => {
    expect(() => validateOpenClawGatewayUrl(value)).toThrow("must be");
  });
});

describe("voice gateway listener lifetime", () => {
  it("binds loopback, logs only trusted labels, and closes on SIGTERM (#8378)", async () => {
    class FakeServer extends EventEmitter {
      listening = false;
      listenArgs: unknown[] = [];

      listen(...args: unknown[]): this {
        this.listenArgs = args.slice(0, 2);
        this.listening = true;
        const callback = args.at(-1) as () => void;
        callback();
        return this;
      }

      close(callback?: (error?: Error) => void): this {
        this.listening = false;
        callback?.();
        return this;
      }
    }

    const server = new FakeServer();
    const processEvents = new EventEmitter();
    const log = vi.fn();
    const readBearerFile = vi
      .fn()
      .mockReturnValueOnce("deployment-secret")
      .mockReturnValueOnce("openclaw-secret");
    const createServer = vi.fn(() => server as unknown as Server);

    const running = runVoiceGatewayServe(OPTIONS, {
      env: { NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: "1" },
      readBearerFile,
      createServer,
      processEvents,
      log,
    });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

    expect(server.listenArgs).toEqual([18800, "127.0.0.1"]);
    expect(createServer).toHaveBeenCalledWith({
      deploymentCredential: "deployment-secret",
      service: expect.anything(),
    });
    expect(log).toHaveBeenCalledWith({
      event: "voice_gateway",
      state: "listening",
      runtimeIdentity: "voiceclaw-local",
      runtimeProfile: "voiceclaw-pinned",
      sandbox: "demo-sandbox",
      agent: "main",
    });

    processEvents.emit("SIGTERM");
    await running;

    expect(server.listening).toBe(false);
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ state: "stopped" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
