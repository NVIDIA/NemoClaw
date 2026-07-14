// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../agent/defs";
import { buildTelegramProbeInput } from "./telegram-probe";

const agent = { name: "openclaw" } as unknown as AgentDefinition;

type ExecResult = { status: number; stdout: string; stderr: string } | null;

function makeDeps(exec: (sandboxName: string, command: string, timeoutMs?: number) => ExecResult) {
  return {
    now: () => new Date("2026-07-14T00:00:00.000Z"),
    execSandbox: vi.fn(exec),
    getSandbox: vi.fn(() => undefined) as never,
    getAppliedPresets: vi.fn(() => ["telegram"]),
    getGatewayPresets: vi.fn(() => ["telegram"]),
  };
}

function probeStdout(logLines: string[], procLines: string[]): string {
  return [
    "NEMOCLAW_TG_DIAG_OK",
    "NEMOCLAW_TG_LOG_BEGIN",
    ...logLines,
    "NEMOCLAW_TG_LOG_END",
    ...procLines,
    "NEMOCLAW_TG_PROC_DONE",
  ].join("\n");
}

describe("buildTelegramProbeInput", () => {
  it("marks reachable with a live gateway process and parses breadcrumbs (#6743)", () => {
    const deps = makeDeps(() => ({
      status: 0,
      stdout: probeStdout(
        [
          "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
          "[telegram] [default] inbound update received (update_id=present; message_id=present)",
        ],
        ["PROC 42 node /opt/openclaw gateway"],
      ),
      stderr: "",
    }));

    const input = buildTelegramProbeInput("alpha", agent, deps);

    expect(input.probeReachable).toBe(true);
    expect(input.gatewayProcessAlive).toBe(true);
    expect(input.breadcrumbs).toMatchObject({ providerReady: true, inboundReceived: true });
  });

  it("reports a dead process when pgrep completes with no match", () => {
    const deps = makeDeps(() => ({ status: 0, stdout: probeStdout([], []), stderr: "" }));
    const input = buildTelegramProbeInput("alpha", agent, deps);
    expect(input.probeReachable).toBe(true);
    expect(input.gatewayProcessAlive).toBe(false);
    expect(input.breadcrumbs).toBeNull();
  });

  it("reports an unknown process state when the probe never reached pgrep", () => {
    // No NEMOCLAW_TG_PROC_DONE marker → the pgrep stage never completed.
    const deps = makeDeps(() => ({
      status: 0,
      stdout: "NEMOCLAW_TG_DIAG_OK\nNEMOCLAW_TG_LOG_BEGIN\nNEMOCLAW_TG_LOG_END",
      stderr: "",
    }));
    const input = buildTelegramProbeInput("alpha", agent, deps);
    expect(input.probeReachable).toBe(true);
    expect(input.gatewayProcessAlive).toBeNull();
  });

  it("marks unreachable when the sandbox exec fails", () => {
    const deps = makeDeps(() => null);
    const input = buildTelegramProbeInput("alpha", agent, deps);
    expect(input.probeReachable).toBe(false);
    expect(input.gatewayProcessAlive).toBeNull();
    expect(input.breadcrumbs).toBeNull();
  });

  it("does not treat non-telegram log lines as telegram breadcrumbs", () => {
    const deps = makeDeps(() => ({
      status: 0,
      stdout: probeStdout(
        ["[slack] [default] provider ready"],
        ["PROC 42 node /opt/openclaw gateway"],
      ),
      stderr: "",
    }));
    const input = buildTelegramProbeInput("alpha", agent, deps);
    expect(input.breadcrumbs).toBeNull();
  });

  it("captures timestamped OpenClaw native network-failure log lines (#6743)", () => {
    const deps = makeDeps(() => ({
      status: 0,
      stdout: probeStdout(
        [
          "2026-07-14T18:55:23.313+00:00 [telegram] deleteWebhook failed: Network request for 'deleteWebhook' failed!",
          "[telegram] [default] bridge did not start within 15s",
        ],
        ["PROC 42 node /opt/openclaw gateway"],
      ),
      stderr: "",
    }));
    const input = buildTelegramProbeInput("alpha", agent, deps);
    expect(input.breadcrumbs).toMatchObject({
      startupFailedNetwork: true,
      bridgeNotStarted: true,
    });
  });
});
