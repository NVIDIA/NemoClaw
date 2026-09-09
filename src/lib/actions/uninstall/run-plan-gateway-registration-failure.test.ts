// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { withProvenManagedGatewayProcess } from "../../../../test/support/uninstall-managed-gateway-test-support";

import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

it("exits nonzero and preserves cleanup state when gateway registration removal fails (#9859)", () => {
  const warnings: string[] = [];
  const logs: string[] = [];
  const rmSync = vi.fn();
  const result = runUninstallPlan(
    { assumeYes: true, deleteModels: false, keepOpenShell: false },
    withProvenManagedGatewayProcess({
      commandExists: () => true,
      env: { HOME: "/tmp/nemoclaw-uninstall-test-gateway-remove" } as NodeJS.ProcessEnv,
      error: (line: string) => warnings.push(line),
      existsSync: () => false,
      hasPortableRuntimeCleanup: () => false,
      isPortFree: () => true,
      isTty: false,
      kill: () => true,
      log: (line) => logs.push(line),
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: "packaged-service",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      rmSync,
      run: (command: string, args: string[]) =>
        command === "openshell" && args[0] === "gateway" && args[1] === "remove"
          ? {
              status: 1,
              stdout: "",
              stderr: "connection refused; OPENAI_API_KEY=must-not-be-logged",
            }
          : command === "openshell" && args[0] === "gateway" && args[1] === "list"
            ? ok(JSON.stringify([{ name: "nemoclaw" }]))
            : ok(),
      runDocker: () => ok(),
    }),
  );

  expect(result.exitCode).toBe(1);
  expect(warnings).toContain(
    "Could not remove gateway registration 'nemoclaw': openshell gateway remove failed (connection refused; exit 1).",
  );
  expect(warnings.join("\n")).not.toContain("must-not-be-logged");
  expect(warnings).not.toContain("Gateway 'nemoclaw' already removed or unreachable");
  expect(warnings).toContain(
    "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
  );
  expect(rmSync).not.toHaveBeenCalled();
  expect(logs).not.toContain("[3/6] NemoClaw CLI");
  expect(logs).not.toContain("Claws retracted. Until next time.");
});
