// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readGatewayRegistryFile } from "../../state/gateway-registry";
import { migrateLegacyPortState } from "../../state/legacy-port-migration";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function withManagedGatewayAuthority(deps: UninstallRunDeps): UninstallRunDeps {
  return {
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
  };
}

function bindManagedGatewayAuthority(run: typeof runUninstallPlanBase) {
  return (options: UninstallRunOptions, deps: UninstallRunDeps) =>
    run(options, withManagedGatewayAuthority(deps));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("uninstall sandbox delete outcomes (#7906)", () => {
  it.each([
    {
      case: "already removed",
      deleteResponse: {
        status: 1,
        stdout: "",
        stderr: "Error: status: NotFound, sandbox 'selected-box' not found",
      },
      expectedExitCode: 0,
      expectedWarning: "OpenShell sandbox 'selected-box' already removed",
      expectsPreservedState: false,
    },
    {
      case: "unreachable",
      deleteResponse: {
        status: 1,
        stdout: "",
        stderr: "error trying to connect: tcp connect error: Connection refused (os error 111)",
      },
      expectedExitCode: 1,
      expectedWarning: "OpenShell sandbox 'selected-box' could not be removed or was unreachable",
      expectsPreservedState: true,
    },
    {
      case: "rejected for an unrecognized reason",
      deleteResponse: { status: 1, stdout: "", stderr: "Error: sandbox is still finalizing" },
      expectedExitCode: 1,
      expectedWarning: "OpenShell sandbox 'selected-box' could not be removed or was unreachable",
      expectsPreservedState: true,
    },
  ])("classifies selected-gateway cleanup when the recorded sandbox is $case", async ({
    deleteResponse,
    expectedExitCode,
    expectedWarning,
    expectsPreservedState,
  }) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-absent-sandbox-"));
    const selectedPort = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(selectedPort));
      vi.resetModules();
      const runPortUninstall = bindManagedGatewayAuthority(
        (await import("./run-plan")).runUninstallPlan,
      );
      const shared = path.join(tmpHome, ".nemoclaw");
      const sharedRegistryFile = path.join(shared, "sandboxes.json");
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(
        sharedRegistryFile,
        JSON.stringify({
          defaultSandbox: "selected-box",
          sandboxes: {
            "selected-box": {
              name: "selected-box",
              gatewayName: `nemoclaw-${String(selectedPort)}`,
              gatewayPort: selectedPort,
            },
            "sibling-box": {
              name: "sibling-box",
              gatewayName: "nemoclaw-9124",
              gatewayPort: 9124,
            },
          },
        }),
      );
      migrateLegacyPortState({ gatewayPort: selectedPort, home: tmpHome });
      const calls: string[][] = [];
      const warnings: string[] = [];

      const result = runPortUninstall(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          gatewayName: `nemoclaw-${String(selectedPort)}`,
          keepOpenShell: false,
        },
        {
          commandExists: (command) => command === "openshell",
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: String(selectedPort),
          } as NodeJS.ProcessEnv,
          error: (line) => warnings.push(line),
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: vi.fn(),
          run: (_command, args) => {
            calls.push(args);
            return args[0] === "sandbox" && args[1] === "delete" ? deleteResponse : ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(expectedExitCode);
      expect(warnings.join("\n")).toContain(expectedWarning);
      expect(calls).toContainEqual(["sandbox", "delete", "selected-box"]);
      expect(
        calls.some(
          (args) =>
            args[0] === "gateway" &&
            args[1] === "remove" &&
            args[2] === `nemoclaw-${String(selectedPort)}`,
        ),
      ).toBe(!expectsPreservedState);
      expect(fs.existsSync(path.join(shared, "gateways", String(selectedPort)))).toBe(
        expectsPreservedState,
      );
      expect(warnings.join("\n").includes("Selected gateway cleanup was incomplete")).toBe(
        expectsPreservedState,
      );
      const selectedRegistryFile = path.join(
        shared,
        "gateways",
        String(selectedPort),
        "sandboxes.json",
      );
      const selectedSandboxes = readGatewayRegistryFile(tmpHome, selectedRegistryFile)?.sandboxes;
      expect(selectedSandboxes?.["selected-box"]).toEqual(
        expectsPreservedState
          ? {
              name: "selected-box",
              gatewayName: `nemoclaw-${String(selectedPort)}`,
              gatewayPort: selectedPort,
            }
          : undefined,
      );
      expect(readGatewayRegistryFile(tmpHome, sharedRegistryFile)?.sandboxes).toEqual({
        "sibling-box": {
          name: "sibling-box",
          gatewayName: "nemoclaw-9124",
          gatewayPort: 9124,
        },
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
