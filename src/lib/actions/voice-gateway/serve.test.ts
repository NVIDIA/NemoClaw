// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { runVoiceGatewayAction, VOICE_GATEWAY_FEATURE_FLAG } from "./serve";

const options = {
  admissionCredentialFile: "/private/admission",
  openClawCredentialFile: "/private/openclaw",
  openClawEndpoint: "ws://127.0.0.1:18789/ws",
  runtimeId: "runtime-a",
  runtimeProfile: "voiceclaw-pinned",
  sandbox: "sandbox-a",
  agent: "main",
  listenPort: 18_801,
};

describe("experimental voice gateway action", () => {
  it("fails before reading credentials or creating a listener when disabled (#8378)", async () => {
    const readCredential = vi.fn();
    const createGatewayServer = vi.fn();

    await expect(
      runVoiceGatewayAction(options, {
        environment: {},
        readCredential,
        createServer: createGatewayServer,
      }),
    ).rejects.toThrow(VOICE_GATEWAY_FEATURE_FLAG);
    expect(readCredential).not.toHaveBeenCalled();
    expect(createGatewayServer).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "",
    "true",
    "yes",
    "0",
    "01",
  ])("does not accept another experimental flag value %s (#8378)", async (value) => {
    await expect(
      runVoiceGatewayAction(options, {
        environment: value === undefined ? {} : { [VOICE_GATEWAY_FEATURE_FLAG]: value },
        readCredential: vi.fn(),
      }),
    ).rejects.toThrow("disabled");
  });

  it("reads separate credentials after the exact feature gate passes (#8378)", async () => {
    const events = new EventEmitter();
    const readCredential = vi
      .fn()
      .mockReturnValueOnce("deployment-admission-credential-value-123456")
      .mockReturnValueOnce("openclaw-gateway-credential-value-12345678");
    const server = createServer();
    const createGatewayServer = vi.fn(() => server);
    const running = runVoiceGatewayAction(options, {
      environment: { [VOICE_GATEWAY_FEATURE_FLAG]: "1", NEMOCLAW_EXPERIMENTAL_OTHER: "1" },
      readCredential,
      createServer: createGatewayServer,
      processEvents: events,
      log: vi.fn(),
    });
    await vi.waitFor(() => expect(server.listening).toBe(true));
    events.emit("SIGTERM");
    await running;

    expect(readCredential.mock.calls).toEqual([
      ["/private/admission", "Voice deployment credential"],
      ["/private/openclaw", "OpenClaw agent gateway credential"],
    ]);
    expect(createGatewayServer).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionCredential: "deployment-admission-credential-value-123456",
      }),
    );
  });
});
