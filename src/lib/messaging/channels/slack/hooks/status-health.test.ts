// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { MessagingHookContext, MessagingHookResult } from "../../../hooks/types";
import type { ChannelHealthReport } from "../../channel-health";
import { createSlackStatusHealthHook } from "./status-health";

const BASE_INPUTS = {
  currentSandbox: "alpha",
  agent: "openclaw",
  probedAt: "2026-08-07T12:00:00.000Z",
  channelEnabledInRegistry: true,
  presetInRegistry: true,
  presetOnGateway: true as boolean | null,
};

function context(inputs = BASE_INPUTS): MessagingHookContext {
  return {
    channelId: "slack",
    hookId: "slack-status-health",
    phase: "status",
    inputs,
  } as unknown as MessagingHookContext;
}

function payload(account: Record<string, unknown>): string {
  return JSON.stringify({
    channels: { slack: { configured: true } },
    channelAccounts: { slack: [{ accountId: "default", ...account }] },
  });
}

function reportOf(result: MessagingHookResult | Promise<MessagingHookResult>): ChannelHealthReport {
  const output = (result as MessagingHookResult).outputs?.channelHealth;
  if (!output) throw new Error("missing Slack channel health output");
  const value = output.value as unknown as { report: ChannelHealthReport };
  return value.report;
}

describe("slack.statusHealth hook", () => {
  it("reports operational readiness for a connected account with a successful probe (#7383)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: payload({
        enabled: true,
        configured: true,
        running: true,
        connected: true,
        lastStartAt: Date.parse("2026-08-07T11:59:30.000Z"),
        lastProbeAt: Date.parse("2026-08-07T12:00:00.000Z"),
        probe: { ok: true, bot: { name: "test-bot" } },
      }),
      stderr: "",
    }));
    const report = reportOf(
      createSlackStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report.verdict).toBe("healthy");
    expect(report.readiness).toEqual({
      state: "ready",
      category: null,
      reason: "operational",
      retryable: false,
      lastTransitionAt: "2026-08-07T12:00:00.000Z",
    });
    expect(execute).toHaveBeenCalledWith(
      "alpha",
      "openclaw channels status --channel slack --probe --json --timeout 8000",
      8000,
    );
  });

  it("keeps deferred Socket Mode initialization retryable while omitting raw Slack errors and credentials (#7383)", () => {
    const secret = "xoxb-secret-sentinel";
    const execute = vi.fn(() => ({
      status: 0,
      stdout: payload({
        enabled: true,
        configured: true,
        running: true,
        connected: false,
        lastError: "socket mode connection timed out",
        probe: { ok: false, error: `network timeout ${secret}` },
      }),
      stderr: "",
    }));
    const report = reportOf(
      createSlackStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report.readiness).toMatchObject({
      state: "waiting",
      category: "network",
      reason: "socket_mode_connecting",
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("socket mode connection timed out");
  });

  it("waits when effective policy coverage cannot be verified (#7383)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: payload({
        enabled: true,
        configured: true,
        running: true,
        connected: true,
        probe: { ok: true },
      }),
      stderr: "",
    }));
    const report = reportOf(
      createSlackStatusHealthHook({ executeSandboxCommand: execute })(
        context({ ...BASE_INPUTS, presetOnGateway: null }),
      ),
    );

    expect(report.readiness).toMatchObject({
      state: "waiting",
      category: "network",
      reason: "policy_status_unavailable",
      retryable: true,
    });
  });

  it("classifies unavailable Slack credentials as a terminal failure (#7383)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: payload({
        enabled: true,
        configured: true,
        running: false,
        connected: false,
        botTokenStatus: "configured_unavailable",
        appTokenStatus: "available",
        probe: { ok: false, error: "missing token" },
      }),
      stderr: "",
    }));
    const report = reportOf(
      createSlackStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report.readiness).toMatchObject({
      state: "terminal",
      category: "credential",
      reason: "credentials_unavailable",
    });
    expect(report.signals).toContainEqual(
      expect.objectContaining({
        label: "Account probe",
        severity: "fail",
      }),
    );
  });

  it("keeps an unreachable live status probe retryable until the caller timeout (#7383)", () => {
    const execute = vi.fn(() => null);
    const report = reportOf(
      createSlackStatusHealthHook({ executeSandboxCommand: execute })(context()),
    );

    expect(report.readiness).toMatchObject({
      state: "waiting",
      category: "network",
      reason: "status_probe_unreachable",
    });
    expect(report.signals).toContainEqual(
      expect.objectContaining({
        label: "Runtime process",
        severity: "warn",
      }),
    );
  });
});
