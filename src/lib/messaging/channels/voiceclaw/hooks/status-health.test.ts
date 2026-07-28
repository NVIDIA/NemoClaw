// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { MessagingHookContext, MessagingHookResult } from "../../../hooks/types";
import type { ChannelHealthReport } from "../../channel-health";
import { buildVoiceClawProbeNodeScript, createVoiceClawStatusHealthHook } from "./status-health";

const BASE_INPUTS = {
  currentSandbox: "voice-agent",
  agent: "openclaw",
  probedAt: "2026-07-21T00:00:00.000Z",
  channelEnabledInRegistry: true,
  presetInRegistry: true,
  presetOnGateway: true,
};

const READY_PROBE = {
  configReadable: true,
  pluginEnabled: true,
  telnyxConfigured: true,
  webhookConfigured: true,
  nvidiaTtsConfigured: true,
};

function context(inputs: Record<string, unknown> = BASE_INPUTS): MessagingHookContext {
  return {
    channelId: "voiceclaw",
    hookId: "voiceclaw-status-health",
    phase: "status",
    inputs,
  } as unknown as MessagingHookContext;
}

function reportOf(result: MessagingHookResult | Promise<MessagingHookResult>) {
  const value = (result as MessagingHookResult).outputs?.channelHealth?.value as unknown as
    | { report?: ChannelHealthReport }
    | undefined;
  return value?.report;
}

function probeOutput(
  probe: Record<string, boolean>,
  pluginMarker = "NEMOCLAW_VOICE_CALL_PLUGIN_PRESENT",
): string {
  return `${JSON.stringify(probe)}\n${pluginMarker}\n`;
}

describe("voiceclaw.statusHealth", () => {
  it("derives readiness from local config without making an external request (#6387)", () => {
    const writes: string[] = [];
    const require = vi.fn(() => ({
      readFileSync: () =>
        JSON.stringify({
          plugins: {
            entries: {
              "voice-call": {
                enabled: true,
                config: {
                  enabled: true,
                  provider: "telnyx",
                  fromNumber: "+15550001234",
                  telnyx: {
                    apiKey: "openshell:resolve:env:TELNYX_API_KEY",
                    connectionId: "123456789",
                    publicKey: "test-ed25519-public-key",
                  },
                  serve: { bind: "0.0.0.0", port: 3334, path: "/voice/webhook" },
                  publicUrl: "https://voice.example.test/voice/webhook",
                  tts: { provider: "nvidia" },
                },
              },
            },
          },
          messages: { tts: { provider: "nvidia" } },
        }),
    }));

    runInNewContext(buildVoiceClawProbeNodeScript(), {
      process: { stdout: { write: (value: string) => writes.push(value) } },
      require,
    });

    expect(require).toHaveBeenCalledWith("fs");
    expect(JSON.parse(writes.join(""))).toEqual(READY_PROBE);
  });

  it("reports ready when config, plugin, policy, Telnyx, and TTS checks pass (#6387)", () => {
    const execute = vi.fn(() => ({ status: 0, stdout: probeOutput(READY_PROBE), stderr: "" }));
    const report = reportOf(
      createVoiceClawStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report?.verdict).toBe("ready");
    expect(report?.signals.map((signal) => signal.severity)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(execute).toHaveBeenCalledWith(
      "voice-agent",
      expect.stringContaining("env HOME=/sandbox openclaw plugins inspect voice-call"),
      8000,
    );
  });

  it("reports the missing voice-call plugin as a distinct install gap (#6387)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: probeOutput(READY_PROBE, "NEMOCLAW_VOICE_CALL_PLUGIN_MISSING"),
      stderr: "",
    }));
    const report = reportOf(
      createVoiceClawStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report?.verdict).toBe("plugin_missing");
    expect(report?.signals).toContainEqual(
      expect.objectContaining({ label: "Plugin install", severity: "fail" }),
    );
  });

  it("reports Telnyx and policy failures without exposing credentials (#6387)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: probeOutput({ ...READY_PROBE, telnyxConfigured: false }),
      stderr: "",
    }));
    const report = reportOf(
      createVoiceClawStatusHealthHook({ executeSandboxCommand: execute })(
        context({ ...BASE_INPUTS, presetOnGateway: false }),
      ),
    );

    expect(report?.verdict).toBe("policy_gap");
    expect(report?.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Policy coverage", severity: "fail" }),
        expect.objectContaining({ label: "Telnyx setup", severity: "fail" }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("TELNYX_API_KEY");
  });

  it("reports probe failure for malformed or unreachable sandbox output (#6387)", () => {
    const execute = vi.fn(() => ({ status: 1, stdout: "", stderr: "timeout" }));
    const report = reportOf(
      createVoiceClawStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report?.verdict).toBe("probe_failed");
  });
});
