// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { MessagingHookContext, MessagingHookResult } from "../../../hooks/types";
import type { ChannelHealthReport, ChannelReadiness } from "../../channel-health";
import { createSlackStatusHealthHook } from "./status-health";

const BASE_INPUTS = {
  currentSandbox: "alpha",
  agent: "openclaw",
  probedAt: "2026-08-07T12:00:00.000Z",
  channelEnabledInRegistry: true,
  presetApplied: true,
  presetOnGateway: true as boolean | null,
};
const READY_ACCOUNT = {
  enabled: true,
  configured: true,
  running: true,
  connected: true,
  probe: { ok: true },
};

function context(inputs = BASE_INPUTS): MessagingHookContext {
  return {
    channelId: "slack",
    hookId: "slack-status-health",
    phase: "status",
    inputs,
  } as unknown as MessagingHookContext;
}

function reportOf(result: MessagingHookResult | Promise<MessagingHookResult>): ChannelHealthReport {
  const output = (result as MessagingHookResult).outputs?.channelHealth;
  expect(output).toBeDefined();
  return (output?.value as unknown as { report: ChannelHealthReport }).report;
}

function runProbe(
  account: Record<string, unknown> = {},
  inputOverrides: Partial<typeof BASE_INPUTS> = {},
): { report: ChannelHealthReport; execute: ReturnType<typeof vi.fn> } {
  const stdout = JSON.stringify({
    channels: { slack: { configured: true } },
    channelAccounts: { slack: [{ accountId: "default", ...READY_ACCOUNT, ...account }] },
  });
  const execute = vi.fn(() => ({ status: 0, stdout, stderr: "" }));
  const report = reportOf(
    createSlackStatusHealthHook({ executeSandboxCommand: execute })(
      context({ ...BASE_INPUTS, ...inputOverrides }),
    ),
  );
  return { report, execute };
}

describe("slack.statusHealth hook", () => {
  it("reports operational readiness for a connected account with a successful probe (#7383)", () => {
    const { report, execute } = runProbe({
      lastProbeAt: Date.parse("2026-08-07T12:00:00.000Z"),
      probe: { ok: true, bot: { name: "test-bot" } },
    });

    expect(report.verdict).toBe("healthy");
    expect(report.readiness).toEqual({
      state: "ready",
      category: null,
      reason: "operational",
      retryable: false,
      lastTransitionAt: "2026-08-07T12:00:00.000Z",
    });
    expect(report.signals.map(({ label }) => label)).toEqual([
      "Channel registration",
      "Policy coverage",
      "Runtime process",
      "Socket Mode transport",
      "Account probe",
    ]);
    expect(execute).toHaveBeenCalledWith(
      "alpha",
      "openclaw channels status --channel slack --probe --json --timeout 8000",
      8000,
    );
  });

  it("keeps deferred Socket Mode initialization retryable without exposing errors or credentials (#7383)", () => {
    const secret = "xoxb-secret-sentinel";
    const { report } = runProbe({
      connected: false,
      lastError: "socket mode connection timed out",
      probe: { ok: false, error: "network timeout " + secret },
    });

    expect(report.readiness).toMatchObject({
      state: "waiting",
      category: "network",
      reason: "socket_mode_connecting",
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("socket mode connection timed out");
  });

  it.each([
    ["Slack is not registered", { channelEnabledInRegistry: false }, "channel_not_registered"],
    ["the preset is not registered", { presetApplied: false }, "policy_missing"],
    ["the preset is not applied", { presetOnGateway: false }, "policy_missing"],
    ["gateway policy is unknown", { presetOnGateway: null }, "policy_status_unavailable"],
  ] as const)("skips the live probe when %s (#7383)", (_condition, inputs, reason) => {
    const { report, execute } = runProbe({}, inputs);

    expect(report.readiness?.reason).toBe(reason);
    expect(report.signals.map(({ label }) => label)).toEqual([
      "Channel registration",
      "Policy coverage",
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unavailable Slack credentials",
      {
        running: false,
        connected: false,
        botTokenStatus: "configured_unavailable",
        probe: { ok: false, error: "missing token" },
      },
      {},
      ["terminal", "credential", "credentials_unavailable", false],
      { label: "Account probe", severity: "fail" },
    ],
    [
      "a Slack plugin probe failure",
      { probe: { ok: false, error: "plugin failed to load" } },
      {},
      ["terminal", "plugin", "plugin_probe_failed", false],
      { label: "Account probe", severity: "warn" },
    ],
  ] as const)(
    "classifies %s as terminal (#7383)",
    (_condition, account, inputs, expected, signal) => {
      const [state, category, reason, retryable] = expected;
      const report = runProbe(account, inputs).report;
      expect(report.readiness).toMatchObject({
        state,
        category,
        reason,
        retryable,
      } satisfies Partial<ChannelReadiness>);
      expect(report.signals).toContainEqual(expect.objectContaining(signal));
    },
  );

  it("returns a null transition time for an out-of-range Slack timestamp (#7383)", () => {
    expect(
      runProbe({ lastProbeAt: Number.MAX_SAFE_INTEGER }).report.readiness?.lastTransitionAt,
    ).toBeNull();
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
      expect.objectContaining({ label: "Runtime process", severity: "warn" }),
    );
  });
});
