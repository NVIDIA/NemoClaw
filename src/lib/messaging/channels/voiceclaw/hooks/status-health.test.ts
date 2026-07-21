// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { MessagingHookContext, MessagingHookResult } from "../../../hooks/types";
import type { ChannelHealthReport } from "../../channel-health";
import { createVoiceClawStatusHealthHook } from "./status-health";

const BASE_INPUTS = {
  currentSandbox: "voice-agent",
  agent: "openclaw",
  probedAt: "2026-07-21T00:00:00.000Z",
  channelEnabledInRegistry: true,
  presetInRegistry: true,
  presetOnGateway: true,
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
  pluginMarker = "NEMOCLAW_VOICECLAW_PLUGIN_PRESENT",
): string {
  return `${JSON.stringify(probe)}\n${pluginMarker}\n`;
}

const HEALTHY_PROBE = {
  configReadable: true,
  pluginEnabled: true,
  voiceModeEnabled: true,
  bridgeConfigured: true,
  bridgeReachable: true,
};

describe("voiceclaw.statusHealth", () => {
  it("reports healthy only when config, plugin, policy, and bridge checks pass (#6387)", () => {
    const execute = vi.fn(() => ({ status: 0, stdout: probeOutput(HEALTHY_PROBE), stderr: "" }));
    const report = reportOf(
      createVoiceClawStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report?.verdict).toBe("healthy");
    expect(report?.signals.map((signal) => signal.severity)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(execute).toHaveBeenCalledWith("voice-agent", expect.stringContaining("/health"), 8000);
  });

  it("reports the unpublished plugin as a distinct install gap (#6387)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: probeOutput(HEALTHY_PROBE, "NEMOCLAW_VOICECLAW_PLUGIN_MISSING"),
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

  it("reports bridge and policy failures without exposing the configured URL (#6387)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: probeOutput({ ...HEALTHY_PROBE, bridgeReachable: false }),
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
        expect.objectContaining({ label: "Audio bridge", severity: "fail" }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("host.openshell.internal");
  });

  it("reports probe failure for malformed or unreachable sandbox output (#6387)", () => {
    const execute = vi.fn(() => ({ status: 1, stdout: "", stderr: "timeout" }));
    const report = reportOf(
      createVoiceClawStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report?.verdict).toBe("probe_failed");
  });
});
