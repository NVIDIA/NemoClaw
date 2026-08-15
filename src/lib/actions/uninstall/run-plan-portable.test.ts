// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function runUninstallPlan(
  options: UninstallRunOptions,
  deps: UninstallRunDeps,
) {
  return runUninstallPlanBase(options, {
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: gatewayPort === 8080 ? "packaged-service" : "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    ...deps,
  });
}

function okWithKnownGatewayList(
  command: string,
  args: readonly string[],
): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }]))
    : ok();
}

describe("portable uninstall run plan", () => {
  it("fails the full uninstall when portable runtime teardown fails (#9189)", () => {
    const runPortableTeardown = vi.fn(() => ({
      ok: false,
      removedContainerIds: ["aaaabbbbccccdddd"],
      unsetSelectors: ["CONTAINERS_CONF", "NETAVARK_FW"],
      removedReceiptFiles: ["receipt.json"],
      reason: "portable container removal failed",
    }));

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test",
          NEMOCLAW_AGENT: "",
          TMPDIR: "/tmp/nemoclaw-uninstall-test",
        } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: () => true,
        log: () => {},
        rmSync: vi.fn(),
        run: okWithKnownGatewayList,
        runDocker: () => ok(),
        runPortableTeardown,
      },
    );

    expect(runPortableTeardown).toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });

  it("runs the default portable teardown when the portable profile is active", () => {
    const logs: string[] = [];
    const run = vi.fn((command: string, args: string[]) =>
      args[0] === "-c"
        ? ok("/fake/bin/tool\n")
        : args[0] === "-f"
          ? ok("")
          : okWithKnownGatewayList(command, args),
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test",
          NEMOCLAW_AGENT: "",
          TMPDIR: "/tmp/nemoclaw-uninstall-test",
          NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
        } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: () => true,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run,
        runDocker: () => ok(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(
      run.mock.calls.some(
        ([command, args]) => command === "podman" && args[0] === "ps",
      ),
    ).toBe(true);
    expect(
      run.mock.calls.some(
        ([command, args]) => command === "podman" && args[0] === "rm",
      ),
    ).toBe(false);
  });
});
