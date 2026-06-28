// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const { checkAndRecoverSandboxProcesses } = requireSource(
  "../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../src/lib/actions/sandbox/process-recovery.js");

afterEach(() => {
  vi.restoreAllMocks();
});

function withFakeOpenshellBinary<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openshell-"));
  const bin = path.join(dir, "openshell");
  const previous = process.env.NEMOCLAW_OPENSHELL_BIN;
  const restoreEnv =
    previous === undefined
      ? () => {
          delete process.env.NEMOCLAW_OPENSHELL_BIN;
        }
      : () => {
          process.env.NEMOCLAW_OPENSHELL_BIN = previous;
        };
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.NEMOCLAW_OPENSHELL_BIN = bin;
  try {
    return fn();
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function compactTeamsMessagingPlan(port = "3978") {
  return {
    schemaVersion: 1,
    sandboxName: "beta",
    agent: "openclaw",
    workflow: "onboard",
    disabledChannels: [],
    networkPolicy: {
      presets: ["teams"],
      entries: [
        {
          channelId: "teams",
          presetName: "teams",
          policyKeys: ["teams"],
          source: "manifest",
        },
      ],
    },
    channels: [
      {
        channelId: "teams",
        active: true,
        configured: true,
        disabled: false,
        inputs: [
          { inputId: "allowedUsers", value: "00000000-0000-0000-0000-000000000001" },
          { inputId: "appId", value: "test-teams-app-id" },
          { inputId: "clientSecret", credentialAvailable: true },
          { inputId: "requireMention", value: "1" },
          { inputId: "tenantId", value: "test-teams-tenant-id" },
          { inputId: "webhookPort", value: port },
        ],
      },
    ],
    credentialBindings: [],
  };
}

describe("checkAndRecoverSandboxProcesses primary forward failure", () => {
  it("reports failure when a messaging forward cannot recover even if the primary is healthy", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../src/lib/agent/runtime.ts");
    const registry = requireSource("../src/lib/state/registry.ts");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.ts");
    const childProcess = requireSource("node:child_process");

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
      messaging: { schemaVersion: 1, plan: compactTeamsMessagingPlan() },
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(
      (port: unknown) => Number(port) === 18789,
    );
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running`,
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return { status: args[0] === "forward" && args[1] === "start" ? 1 : 0 } as never;
    });

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail:
        "the messaging webhook host forward could not be re-established",
    });
  });

  it("reports failure when the primary forward cannot recover even if secondary forwards recover", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.ts");
    const agentRuntime = requireSource("../src/lib/agent/runtime.ts");
    const registry = requireSource("../src/lib/state/registry.ts");
    const forwardHealth = requireSource("../src/lib/actions/sandbox/forward-health.ts");
    const childProcess = requireSource("node:child_process");
    let teamsForwardStarted = false;

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
      messaging: { schemaVersion: 1, plan: compactTeamsMessagingPlan() },
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(false);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: teamsForwardStarted
        ? `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  3978  12346  running`
        : `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  dead`,
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        const isForwardStart = args[0] === "forward" && args[1] === "start";
        const startsTeamsForward = isForwardStart && args.includes("3978");
        teamsForwardStarted = teamsForwardStarted || startsTeamsForward;
        return { status: isForwardStart && args.includes("18789") ? 1 : 0 } as never;
      });

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
      forwardRecoveryFailureDetail:
        "the primary dashboard/API host forward could not be re-established",
    });
    expect(teamsForwardStarted).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["forward", "start", "--background", "3978", "beta"],
      { ignoreError: true },
    );
  });
});
