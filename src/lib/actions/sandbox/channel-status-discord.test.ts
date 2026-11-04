// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { entry, makeDeps, showSandboxChannelStatus } from "./channel-status.test-helpers";
import { exitCodeFor } from "./channel-status";
import { redactForLog } from "../../security/redact";

function openClawDiscordStatus(account: Record<string, unknown> = {}): string {
  return JSON.stringify({
    channelAccounts: {
      discord: [
        {
          accountId: "default",
          enabled: true,
          configured: true,
          running: true,
          connected: true,
          lifecycle: "ready",
          probe: { ok: true },
          ...account,
        },
      ],
    },
  });
}

describe("OpenClaw Discord channel status", () => {
  it.each([
    ["the gateway is connected", 0, openClawDiscordStatus(), "healthy", "ready"],
    [
      "REST works while the gateway reconnects",
      0,
      openClawDiscordStatus({ connected: false, lifecycle: "recovering" }),
      "inactive",
      "waiting",
    ],
    [
      "the bot token is rejected",
      0,
      openClawDiscordStatus({ probe: { ok: false, status: 401 } }),
      "credential_rejected",
      "terminal",
    ],
    [
      "the gateway lifecycle is blocked",
      0,
      openClawDiscordStatus({
        running: false,
        connected: false,
        lifecycle: "blocked",
        lastError: "invalid-output-with-secret",
      }),
      "blocked",
      "terminal",
    ],
    [
      "the gateway disconnect is terminal",
      0,
      openClawDiscordStatus({ connected: false, terminalDisconnect: true }),
      "blocked",
      "terminal",
    ],
    ["the native command fails", 1, openClawDiscordStatus(), "unknown", "waiting"],
    [
      "only REST metadata is available",
      0,
      '{"channels":{"discord":{"probe":{"ok":true}}}}',
      "unknown",
      "waiting",
    ],
    ["native output is malformed", 0, "invalid-output-with-secret", "unknown", "waiting"],
  ] as const)(
    "classifies readiness when %s (#13624)",
    async (_condition, status, stdout, verdict, readiness) => {
      let nowMs = 0;
      const sleep = vi.fn(async (milliseconds: number) => {
        nowMs += milliseconds;
      });
      const { deps: base } = makeDeps({
        sandbox: entry(["discord"]),
        appliedPresets: ["discord"],
        gatewayPresets: ["discord"],
        exec: () => ({ status, stdout, stderr: "invalid-output-with-secret" }),
        nowMs: () => nowMs,
        sleep,
      });
      const report = await showSandboxChannelStatus("alpha", {
        deps: { ...base, execSandbox: async (...args) => base.execSandbox(...args) },
        channel: "discord",
        wait: true,
        timeoutSeconds: 1,
        asJson: true,
        quietJson: true,
      });
      // Use the CLI redactor so the last observation must survive JSON serialization.
      const serialized = JSON.parse(JSON.stringify(redactForLog(report)));
      expect(serialized.status.report).toMatchObject({
        agent: "openclaw",
        verdict,
        readiness: { state: readiness, retryable: readiness === "waiting" },
        signals: expect.arrayContaining([
          expect.objectContaining({ label: "Agent responses", severity: "info" }),
        ]),
      });
      expect(serialized.readiness).toMatchObject({
        state: readiness === "waiting" ? "timeout" : readiness,
        attempts: 1,
        lastObserved: { state: readiness, retryable: readiness === "waiting" },
      });
      expect(sleep).toHaveBeenCalledTimes(readiness === "waiting" ? 1 : 0);
      expect(report && exitCodeFor(report)).toBe(readiness === "ready" ? 0 : 1);
      expect(base.execSandbox).toHaveBeenCalledWith(
        "alpha",
        "openclaw channels status --channel discord --probe --json --timeout 1000",
        1_000,
      );
      expect(JSON.stringify(report)).not.toContain("invalid-output-with-secret");
    },
  );

  it.each([
    ["unavailable", null, "ready", 2],
    ["missing", [], "terminal", 1],
  ] as const)(
    "handles %s gateway policy during --wait",
    async (_condition, presets, state, attempts) => {
      let nowMs = 0;
      const sleep = vi.fn(async (milliseconds: number) => {
        nowMs += milliseconds;
      });
      const { deps: base } = makeDeps({
        sandbox: entry(["discord"]),
        appliedPresets: ["discord"],
        exec: () => ({ status: 0, stdout: openClawDiscordStatus(), stderr: "" }),
        nowMs: () => nowMs,
        sleep,
      });
      const getGatewayPresets = vi
        .fn(async (): Promise<string[] | null> => ["discord"])
        .mockResolvedValueOnce(presets === null ? null : [...presets]);

      const report = await showSandboxChannelStatus("alpha", {
        deps: {
          ...base,
          getGatewayPresets,
          execSandbox: async (...args) => base.execSandbox(...args),
        },
        channel: "discord",
        wait: true,
        timeoutSeconds: 2,
        pollIntervalMs: 100,
        asJson: true,
        quietJson: true,
      });

      expect(report).toMatchObject({ readiness: { state, attempts } });
      expect(getGatewayPresets).toHaveBeenCalledTimes(attempts);
      expect(sleep).toHaveBeenCalledTimes(attempts - 1);
      const nativeProbes = base.execSandbox.mock.calls.filter(([, command]) =>
        command.startsWith("openclaw channels status --channel discord "),
      );
      expect(nativeProbes).toHaveLength(state === "ready" ? 1 : 0);
      expect(report && exitCodeFor(report)).toBe(state === "ready" ? 0 : 1);
    },
  );

  it("reports a paused Discord channel as terminal with --wait (#13624)", async () => {
    const { deps: base } = makeDeps({
      sandbox: entry(["discord"], ["discord"]),
      appliedPresets: ["discord"],
      gatewayPresets: ["discord"],
      exec: () => ({ status: 0, stdout: openClawDiscordStatus(), stderr: "" }),
    });
    const report = await showSandboxChannelStatus("alpha", {
      deps: { ...base, execSandbox: async (...args) => base.execSandbox(...args) },
      channel: "discord",
      wait: true,
      asJson: true,
      quietJson: true,
    });
    const status = report && "status" in report ? report.status : undefined;
    expect(status && "report" in status && status.report.signals).toContainEqual({
      label: "Runtime health",
      severity: "info",
      detail: "not checked — discord is currently paused",
      hint: undefined,
    });
    expect(report).toMatchObject({
      readiness: { state: "terminal", reason: "channel_paused" },
    });
    expect(report && exitCodeFor(report)).toBe(1);
    expect(base.execSandbox).not.toHaveBeenCalledWith(
      "alpha",
      "openclaw channels status --channel discord --probe --json --timeout 8000",
      expect.any(Number),
    );
    expect(JSON.stringify(report)).not.toContain("not implemented");
  });
});

describe("Hermes Discord channel status", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["auth_failed", "credential_rejected", ["nemohermes 'alpha' channels add discord"]],
    [
      "auth_failed",
      "credential_rejected",
      ["nemohermes 'alpha'\\''proof' channels add discord"],
      "alpha'proof",
    ],
    ["connected", "healthy", []],
    ["unknown", "unknown", ["nemohermes 'alpha' channels status --channel discord"]],
    ["inactive", "inactive", ["nemohermes 'alpha' channels status --channel discord"]],
  ] as const)(
    "reports %s through the channel status action (#13809)",
    async (state, verdict, hints, sandboxName: string = "alpha") => {
      vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemohermes");
      const { deps: syncDeps } = makeDeps({
        agentName: "hermes",
        sandbox: entry(["discord"], [], {}, "hermes"),
        appliedPresets: ["discord"],
        gatewayPresets: ["discord"],
        exec: () => ({
          status: 0,
          stdout: `NEMOCLAW_DISCORD_STATUS_V1\n${JSON.stringify({ state })}`,
          stderr: "",
        }),
      });
      const deps = {
        ...syncDeps,
        execSandbox: async (...args: Parameters<typeof syncDeps.execSandbox>) =>
          syncDeps.execSandbox(...args),
      };
      const report = await showSandboxChannelStatus(sandboxName, {
        deps,
        channel: "discord",
        asJson: true,
        quietJson: true,
      });
      expect(report && "report" in report && report.report.verdict).toBe(verdict);
      expect(report && exitCodeFor(report)).toBe(
        verdict === "credential_rejected" || verdict === "inactive" ? 1 : 0,
      );
      expect(report && "report" in report && report.report.hints).toEqual(
        hints.map((command) => expect.stringContaining(command)),
      );
    },
  );

  it.each([
    [1, 'NEMOCLAW_DISCORD_STATUS_V1\n{"state":"connected"}'],
    [0, "probe error invalid-token-for-test"],
    [0, "NEMOCLAW_DISCORD_STATUS_V1\n{broken"],
  ])("keeps failed or malformed probes unverified (%s) (#13809)", async (status, stdout) => {
    const { deps: syncDeps } = makeDeps({
      agentName: "hermes",
      sandbox: entry(["discord"], [], {}, "hermes"),
      appliedPresets: ["discord"],
      gatewayPresets: ["discord"],
      exec: () => ({ status, stdout, stderr: "invalid-token-for-test" }),
    });
    const deps = {
      ...syncDeps,
      execSandbox: async (...args: Parameters<typeof syncDeps.execSandbox>) =>
        syncDeps.execSandbox(...args),
    };
    const report = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "discord",
      asJson: true,
      quietJson: true,
    });
    expect(report && "report" in report && report.report.verdict).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain("invalid-token-for-test");
  });
});
