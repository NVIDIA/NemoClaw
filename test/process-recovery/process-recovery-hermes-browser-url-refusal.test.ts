// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import { checkAndRecoverSandboxProcesses } from "../../src/lib/actions/sandbox/process-recovery.ts";
import { relaunchManagedSupervisorSession } from "../../src/lib/actions/sandbox/supervisor-relaunch.ts";
import * as agentRuntime from "../../src/lib/agent/runtime.ts";
import * as registry from "../../src/lib/state/registry.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reports the onboarding remediation for a legacy Hermes recovery refusal", () => {
  vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS", "0");
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    name: "hermes",
    displayName: "Hermes",
    forwardPort: 19189,
    healthProbe: {
      url: "http://127.0.0.1:19189/health",
      port: 19189,
      timeout_seconds: 30,
    },
  } as never);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "legacy-hermes-box",
    agent: "hermes",
    dashboardPort: 19189,
    hermesDashboardEnabled: true,
    hermesDashboardPort: 19189,
    hermesDashboardInternalPort: 8643,
    openshellDriver: "docker",
  });
  const requestGatewaySupervisorAction = vi.fn(() => ({
    status: 1,
    stdout: "",
    stderr: "SUPERVISOR_NOT_RUNNING",
  }));
  const resolveContainer = vi.fn(() => "old-container-id");
  const recreate = vi.fn(() => {
    throw new Error("legacy Hermes recovery allowed container mutation");
  });
  const relaunchManagedSupervisorSessionImpl = vi.fn(
    (sandboxName: string, options: Parameters<typeof relaunchManagedSupervisorSession>[1]) =>
      relaunchManagedSupervisorSession(sandboxName, {
        quiet: options.quiet,
        deps: {
          ...options.deps,
          readManagedWorkloadAuthority: vi.fn(
            () =>
              ({
                agent: "hermes",
                profile: { dashboard: { agent: "hermes" } },
              }) as never,
          ),
          recreate,
          resolveContainer,
        },
      }),
  );
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const result = checkAndRecoverSandboxProcesses("legacy-hermes-box", {
    quiet: false,
    isSandboxGatewayRunningImpl: () => false,
    requestGatewaySupervisorAction,
    relaunchManagedSupervisorSessionImpl,
  });

  expect(result).toMatchObject({ checked: true, wasRunning: false, recovered: false });
  expect(resolveContainer).not.toHaveBeenCalled();
  expect(recreate).not.toHaveBeenCalled();
  const output = errorSpy.mock.calls.flat().join("\n");
  expect(output).toContain("Hermes dashboard profile");
  expect(output).toContain("no recorded browser URL");
  expect(output).toContain("Rerun onboarding before retrying recovery");
});
