// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  type UninstallRunDeps,
  type UninstallRunOptions,
  runUninstallPlan as runUninstallPlanBase,
} from "./run-plan";

const STATIC_TEST_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), "nemoclaw-uninstall-preserved-registry-static-"),
);

afterAll(() => {
  fs.rmSync(STATIC_TEST_HOME, { recursive: true, force: true });
});

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
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

describe("uninstall messaging for a preserved-but-orphaned sandbox registry (#6520)", () => {
  it("uses the 'already removed' wording for provider and sandbox delete no-ops", () => {
    // Same defect family as the gateway wording fix (#3456 sub-bug 4): when
    // `openshell provider delete <name>` or `openshell sandbox delete --all`
    // no-ops (target already gone), `Deleted provider 'X' skipped` reads as if
    // the deletion both happened and was skipped.
    const warnings: string[] = [];
    const logs: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: STATIC_TEST_HOME, TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        error: (line) => warnings.push(line),
        existsSync: () => false,
        isTty: false,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (command, args) =>
          command === "openshell" && args[0] === "gateway" && args[1] === "list"
            ? ok(JSON.stringify([{ name: "nemoclaw" }]))
            : command === "openshell" &&
                args[0] === "gateway" &&
                args[1] === "remove" &&
                args[2] === "nemoclaw"
              ? ok()
            : command === "openshell"
              ? notFound()
              : args[0] === "-c"
                ? ok("/fake/bin/tool\n")
                : ok(),
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    const combined = `${warnings.join("\n")}\n${logs.join("\n")}`;
    expect(warnings.join("\n")).toContain("Provider 'nvidia-nim' already removed or unreachable");
    expect(warnings.join("\n")).toContain("OpenShell sandboxes already removed or unreachable");
    expect(combined).not.toContain("Deleted provider 'nvidia-nim' skipped");
    expect(combined).not.toContain("Deleted all OpenShell sandboxes skipped");
  });
});
