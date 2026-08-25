// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

const MANAGED_HERMES_VOLUME_LABELS = {
  "io.nvidia.nemoclaw.hermes-state.managed": "true",
  "io.nvidia.nemoclaw.hermes-state.sandbox": "hermes",
  "io.nvidia.nemoclaw.hermes-state.schema": "1",
  "io.nvidia.nemoclaw.hermes-state.target": "/sandbox/.hermes",
};

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
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

function runManagedHermesVolumeUninstall(
  mode: "foreign" | "owned" | "remove-fails",
  destroyUserData: boolean,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-hermes-volume-"));
  const stateDir = path.join(home, ".nemoclaw");
  const registryFile = path.join(stateDir, "sandboxes.json");
  const volumeName = "nemoclaw-hermes-state-v1-hermes";
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      defaultSandbox: "hermes",
      sandboxes: {
        hermes: {
          agent: "hermes",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          name: "hermes",
          openshellDriver: "docker",
          workload: { kind: "managed-image" },
        },
      },
    }),
  );

  const dockerCalls: string[][] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  let volumePresent = true;
  const run = vi.fn((command: string, args: string[]) => {
    events.push(`${command} ${args.join(" ")}`);
    return command === "openshell" && args[0] === "gateway" && args[1] === "list"
      ? ok(JSON.stringify([{ name: "nemoclaw" }]))
      : ok();
  });
  const runDocker = vi.fn((args: string[]) => {
    dockerCalls.push(args);
    events.push(`docker ${args.join(" ")}`);
    switch (args.join(" ")) {
      case `volume inspect --format {{json .}} ${volumeName}`:
        return volumePresent
          ? ok(
              `${JSON.stringify({
                Labels:
                  mode === "foreign"
                    ? { "com.example.owner": "foreign" }
                    : MANAGED_HERMES_VOLUME_LABELS,
                Name: volumeName,
              })}\n`,
            )
          : { status: 1, stdout: "", stderr: `Error: no such volume: ${volumeName}` };
      case `volume rm ${volumeName}`:
        switch (mode) {
          case "remove-fails":
            return { status: 1, stdout: "", stderr: "volume is still in use" };
          default:
            volumePresent = false;
            return ok(`${volumeName}\n`);
        }
      case "volume inspect openshell-cluster-nemoclaw":
        return { status: 1, stdout: "", stderr: "Error: no such volume" };
      default:
        return ok();
    }
  });

  const result = runUninstallPlan(
    { assumeYes: true, deleteModels: false, destroyUserData, keepOpenShell: false },
    {
      commandExists: () => true,
      env: { HOME: home } as NodeJS.ProcessEnv,
      error: (line) => errors.push(line),
      existsSync: (target) => target.startsWith(home) && fs.existsSync(target),
      hasPortableRuntimeCleanup: () => false,
      isTty: false,
      kill: () => true,
      log: (line) => logs.push(line),
      rmSync: fs.rmSync,
      run,
      runDocker,
    },
  );

  return {
    cleanup: () => fs.rmSync(home, { force: true, recursive: true }),
    dockerCalls,
    errors,
    events,
    logs,
    registryFile,
    result,
    volumeName,
    volumePresent: () => volumePresent,
  };
}

describe("managed Hermes state volume uninstall", () => {
  it.each([
    ["local uninstall", false],
    ["destructive uninstall", true],
  ])("removes an owned volume during %s", (_label, destroyUserData) => {
    const harness = runManagedHermesVolumeUninstall("owned", destroyUserData);
    try {
      expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.volumePresent()).toBe(false);
      expect(harness.dockerCalls).toContainEqual(["volume", "rm", harness.volumeName]);
      expect(harness.events.indexOf("openshell sandbox delete --all")).toBeLessThan(
        harness.events.indexOf(`docker volume rm ${harness.volumeName}`),
      );
      expect(harness.logs).toContain("Removed managed Hermes state volume for 'hermes'.");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps a same-name foreign volume", () => {
    const harness = runManagedHermesVolumeUninstall("foreign", true);
    try {
      expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.volumePresent()).toBe(true);
      expect(harness.dockerCalls).not.toContainEqual(["volume", "rm", harness.volumeName]);
      expect(harness.errors.join("\n")).toContain(
        `Left Docker volume '${harness.volumeName}' untouched because the exact NemoClaw ownership labels are absent or changed.`,
      );
    } finally {
      harness.cleanup();
    }
  });

  it("preserves uninstall state when volume removal fails", () => {
    const harness = runManagedHermesVolumeUninstall("remove-fails", true);
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.volumePresent()).toBe(true);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
      expect(harness.events.some((event) => event.startsWith("npm "))).toBe(false);
      expect(harness.errors).toContain(
        `Managed Hermes state volume '${harness.volumeName}' could not be removed.`,
      );
      expect(harness.errors).toContain("Preserved NemoClaw state so exact cleanup can be retried.");
    } finally {
      harness.cleanup();
    }
  });
});
