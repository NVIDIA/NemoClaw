// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const { forwardServiceControllerTestDouble: forwardMocks } =
  await import("../support/forward-service-controller-test-double.ts");
const forwardControllerModule = requireSource(
  "../../src/lib/adapters/openshell/forward-service-controller.ts",
);
forwardControllerModule.createForwardServiceController = () => forwardMocks.controller;
const forwardMigrationModule = requireSource("../../src/lib/onboard/forward-service-migration.ts");
forwardMigrationModule.requireProductionForwardServiceAuthority = (sandboxName: string) => ({
  authority: {
    gatewayName: "nemoclaw",
    sandboxIdentityFingerprint: "a".repeat(64),
    sandboxName,
  },
  migrated: false,
  assertCurrent: vi.fn(),
  assertLiveCurrent: vi.fn(),
  completeLegacyMigration: vi.fn(),
  isLegacyMigrationComplete: () => true,
});
forwardMigrationModule.retireProductionLegacySandboxForwards = () => 0;
const { checkAndRecoverSandboxProcesses: checkAndRecoverSandboxProcessesImpl } = requireSource(
  "../../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../../src/lib/actions/sandbox/process-recovery.js");

function checkAndRecoverSandboxProcesses(
  sandboxName: string,
  options: Parameters<typeof checkAndRecoverSandboxProcessesImpl>[1] = {},
) {
  return checkAndRecoverSandboxProcessesImpl(sandboxName, { isWsl: false, ...options });
}

beforeEach(() => {
  forwardMocks.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

const CURRENT_FORWARD_AUTHORITY = {
  forwardServiceMigrationVersion: 1 as const,
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "current-generation",
  lifecycleLiveIdentityFingerprint: "a".repeat(64),
};

describe("checkAndRecoverSandboxProcesses primary forward failure", () => {
  it("fails closed when OpenShell forward state is unavailable", () => {
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const childProcess = requireSource("node:child_process");

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      ...CURRENT_FORWARD_AUTHORITY,
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
    });
    forwardMocks.controller.inspect.mockImplementation(() => {
      throw new Error("OpenShell ForwardTcp state unavailable");
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
        "the primary dashboard/API host forward could not be verified because OpenShell forward state was unavailable",
    });
    expect(forwardMocks.controller.ensure).not.toHaveBeenCalled();
  });

  it("reports failure when a messaging forward cannot recover even if the primary is healthy", () => {
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const childProcess = requireSource("node:child_process");

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      ...CURRENT_FORWARD_AUTHORITY,
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
      messaging: { schemaVersion: 1, plan: compactTeamsMessagingPlan() },
    });
    forwardMocks.seed("beta", "127.0.0.1", 18789);
    forwardMocks.failPort(3978);

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
    const agentRuntime = requireSource("../../src/lib/agent/runtime.ts");
    const registry = requireSource("../../src/lib/state/registry.ts");
    const childProcess = requireSource("node:child_process");

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      ...CURRENT_FORWARD_AUTHORITY,
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
      messaging: { schemaVersion: 1, plan: compactTeamsMessagingPlan() },
    });
    forwardMocks.failPort(18789);

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
    expect(forwardMocks.controller.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "beta" }),
      { localHost: "127.0.0.1", localPort: 3978, targetPort: 3978 },
    );
  });
});
