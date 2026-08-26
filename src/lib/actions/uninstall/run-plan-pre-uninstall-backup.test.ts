// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan,
  runUninstallPlanProduction,
  type UninstallRunDeps,
} from "./run-plan";

const temporaryDirectories: string[] = [];

function ok(stdout = ""): RunResult {
  return { status: 0, stderr: "", stdout };
}

function createFixture(): {
  deps: UninstallRunDeps;
  errors: string[];
  events: string[];
  home: string;
  logs: string[];
  registryFile: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pre-uninstall-backup-"));
  temporaryDirectories.push(home);
  const stateDir = path.join(home, ".nemoclaw");
  const registryFile = path.join(stateDir, "sandboxes.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          agent: "openclaw",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          lifecycleGeneration: "alpha-generation",
          name: "alpha",
          openshellDriver: "docker",
        },
      },
    })}\n`,
  );
  const errors: string[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  return {
    deps: {
      commandExists: (command) => command === "openshell",
      env: { HOME: home } as NodeJS.ProcessEnv,
      error: (line) => errors.push(line),
      existsSync: (target) => target.startsWith(home) && fs.existsSync(target),
      hasPortableRuntimeCleanup: () => false,
      isTty: false,
      log: (line) => logs.push(line),
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        endpoint: null,
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        requiredCapabilities: [],
        source: "packaged-service",
        stateDir: null,
        supervisor: null,
      }),
      run: vi.fn((command: string, args: string[]) => {
        const handler = new Map<string, () => RunResult>([
          ["openshell gateway list", () => ok(JSON.stringify([{ name: "nemoclaw" }]))],
          [
            "openshell sandbox delete",
            () => {
              events.push("delete");
              return ok();
            },
          ],
        ]).get(`${command} ${args.slice(0, 2).join(" ")}`);
        return handler?.() ?? ok();
      }),
      runDocker: () => ok(),
      withSandboxMutationLock: async (_sandboxName, operation) => await operation(),
      withPortableHostFence: async (_home, operation) => operation(),
    },
    errors,
    events,
    home,
    logs,
    registryFile,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("pre-uninstall sandbox backup", () => {
  it("holds the sandbox mutation lock from backup through deletion", async () => {
    const fixture = createFixture();
    const backup = vi.fn(async () => {
      fixture.events.push("backup");
    });
    const lockStateDirs: string[] = [];
    const withSandboxMutationLock: NonNullable<
      UninstallRunDeps["withSandboxMutationLock"]
    > = async (sandboxName, operation, options) => {
      lockStateDirs.push(options.stateDir);
      fixture.events.push(`acquire:${sandboxName}`);
      try {
        return await operation();
      } finally {
        fixture.events.push(`release:${sandboxName}`);
      }
    };

    const result = await runUninstallPlanProduction(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      { ...fixture.deps, backupAllBeforeUninstall: backup, withSandboxMutationLock },
    );

    expect(result.exitCode).toBe(0);
    expect(backup).toHaveBeenCalledOnce();
    expect(backup).toHaveBeenCalledWith(["alpha"]);
    expect(lockStateDirs).toEqual([path.join(fixture.home, ".nemoclaw", "state")]);
    expect(fixture.events).toEqual(["acquire:alpha", "backup", "delete", "release:alpha"]);
    expect(fixture.logs).toContain("Backing up current sandbox state before uninstall...");
  });

  it("stops the synchronous entrypoint before protected sandbox deletion", () => {
    const fixture = createFixture();

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      fixture.deps,
    );

    expect(result.exitCode).toBe(1);
    expect(fixture.events).toEqual([]);
    expect(fs.existsSync(fixture.registryFile)).toBe(true);
    expect(fixture.errors).toContain(
      "Uninstall stopped before cleanup because this entrypoint cannot perform the required pre-uninstall backup.",
    );
  });

  it("excludes normalised Podman registrations from pre-uninstall backup", async () => {
    const fixture = createFixture();
    const registry = JSON.parse(fs.readFileSync(fixture.registryFile, "utf8"));
    registry.sandboxes.alpha.openshellDriver = " PODMAN ";
    fs.writeFileSync(fixture.registryFile, `${JSON.stringify(registry)}\n`);
    const backup = vi.fn(async () => undefined);

    const result = await runUninstallPlanProduction(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      { ...fixture.deps, backupAllBeforeUninstall: backup },
    );

    expect(result.exitCode).toBe(0);
    expect(backup).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(["delete"]);
  });

  it("stops before backup when a sandbox mutation lock is unavailable", async () => {
    const fixture = createFixture();
    const backup = vi.fn(async () => undefined);
    const withSandboxMutationLock: NonNullable<
      UninstallRunDeps["withSandboxMutationLock"]
    > = async () => {
      throw new Error("lock held by another command");
    };

    const result = await runUninstallPlanProduction(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      { ...fixture.deps, backupAllBeforeUninstall: backup, withSandboxMutationLock },
    );

    expect(result.exitCode).toBe(1);
    expect(backup).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
    expect(fixture.errors).toContain(
      "Pre-uninstall sandbox mutation lock is unavailable; uninstall stopped before backup and cleanup: lock held by another command",
    );
  });

  it("stops before deletion when backup fails", async () => {
    const fixture = createFixture();
    const backup = vi.fn(async () => {
      throw new Error("workspace capture failed");
    });

    const result = await runUninstallPlanProduction(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      { ...fixture.deps, backupAllBeforeUninstall: backup },
    );

    expect(result.exitCode).toBe(1);
    expect(fixture.events).toEqual([]);
    expect(fs.existsSync(fixture.registryFile)).toBe(true);
    expect(fixture.errors).toContain(
      "Pre-uninstall backup failed; uninstall stopped before sandbox deletion: workspace capture failed",
    );
  });

  it("stops before deletion when the production backup integration is unavailable", async () => {
    const fixture = createFixture();

    const result = await runUninstallPlanProduction(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      fixture.deps,
    );

    expect(result.exitCode).toBe(1);
    expect(fixture.events).toEqual([]);
    expect(fixture.errors).toContain(
      "Pre-uninstall backup is unavailable; uninstall stopped before sandbox deletion.",
    );
  });

  it("stops when sandbox registration changes after backup", async () => {
    const fixture = createFixture();
    const backup = vi.fn(async () => {
      const registry = JSON.parse(fs.readFileSync(fixture.registryFile, "utf8"));
      registry.sandboxes.alpha.lifecycleGeneration = "replacement-generation";
      fs.writeFileSync(fixture.registryFile, `${JSON.stringify(registry)}\n`);
    });

    const result = await runUninstallPlanProduction(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      { ...fixture.deps, backupAllBeforeUninstall: backup },
    );

    expect(result.exitCode).toBe(1);
    expect(fixture.events).toEqual([]);
    expect(fixture.errors).toContain(
      "Sandbox registrations changed during the pre-uninstall backup. Uninstall stopped before cleanup; rerun it to capture current sandbox state.",
    );
  });

  it("honours explicit user-data destruction without creating a backup", async () => {
    const fixture = createFixture();
    const backup = vi.fn(async () => undefined);

    const result = await runUninstallPlanProduction(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        keepOpenShell: true,
      },
      { ...fixture.deps, backupAllBeforeUninstall: backup },
    );

    expect(result.exitCode).toBe(0);
    expect(backup).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(["delete"]);
  });
});
