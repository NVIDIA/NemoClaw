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
import { hasPortableRuntimeCleanup } from "./portable-runtime-cleanup";
import { portableDemoReceiptPath } from "../../onboard/experimental/portable-runtime-receipt-readiness";

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

function okWithKnownGatewayList(command: string, args: readonly string[]): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }]))
    : ok();
}

describe("portable runtime cleanup in the uninstall run plan", () => {
  it("completes exact cleanup when the generic sandbox delete fails (#9189)", () => {
    const order: string[] = [];
    const logs: string[] = [];
    const runHandlers = new Map<string, () => RunResult>([
      ["pgrep", notFound],
      ["lsof", notFound],
      [
        "openshell sandbox delete --all",
        () => {
          order.push("generic-delete-failed");
          return { status: 1, stdout: "", stderr: "gateway delete failed" };
        },
      ],
    ]);
    const run = vi.fn((command: string, args: string[]) =>
      (
        runHandlers.get(`${command} ${args.join(" ")}`) ??
        runHandlers.get(command) ??
        (() => okWithKnownGatewayList(command, args))
      )(),
    );
    const removeSandbox = vi.fn(() => {
      order.push("exact-sandbox");
      return 1;
    });
    const removeShared = vi.fn(() => {
      order.push("exact-shared");
      return {
        registryRemoved: true,
        selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
      };
    });

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: false },
      {
        commandExists: (command) => ["openshell", "pgrep", "lsof"].includes(command),
        env: { HOME: "/tmp/nemoclaw-uninstall-portable-9189" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        hasPortableRuntimeCleanup: () => true,
        isTty: false,
        log: (line) => logs.push(line),
        removePortableSandboxContainers: removeSandbox,
        removePortableSharedResources: removeShared,
        rmSync: vi.fn(),
        run,
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(order).toEqual(["exact-sandbox", "generic-delete-failed", "exact-shared"]);
    expect(removeSandbox).toHaveBeenCalledOnce();
    expect(removeShared).toHaveBeenCalledOnce();
    expect(logs).toContain("Removed the managed portable registry container.");
  });

  it("preserves retry evidence after an exact cleanup failure with destroy data (#9189)", () => {
    const removed: string[] = [];
    const errors: string[] = [];
    const run = vi.fn((command: string, args: string[]) =>
      ["pgrep", "lsof"].includes(command) ? notFound() : okWithKnownGatewayList(command, args),
    );
    const result = runUninstallPlan(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        keepOpenShell: false,
      },
      {
        commandExists: (command) => ["openshell", "pgrep", "lsof"].includes(command),
        env: { HOME: "/tmp/nemoclaw-uninstall-portable-failure-9189" } as NodeJS.ProcessEnv,
        error: (line) => errors.push(line),
        existsSync: () => false,
        hasPortableRuntimeCleanup: () => true,
        isTty: false,
        log: vi.fn(),
        removePortableSandboxContainers: () => {
          throw new Error("recorded container remains");
        },
        removePortableSharedResources: vi.fn(),
        rmSync: vi.fn((target: fs.PathLike) => removed.push(String(target))),
        run,
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("recorded container remains");
    expect(removed).toEqual([]);
    expect(run.mock.calls.some(([command]) => command === "npm")).toBe(false);
  });

  it("keeps detected portable receipts during a sibling-gateway scoped pass (#9189)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-sibling-"));
    const stateDir = path.join(homeDir, ".nemoclaw");
    const receiptFile = portableDemoReceiptPath("alpha", stateDir);
    const containerId = "a".repeat(64);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(
      receiptFile,
      `${JSON.stringify({
        schemaVersion: 4,
        sandboxName: "alpha",
        sandboxId: "sandbox-alpha",
        containerId,
        dashboardPort: 18789,
        registryGeneration: containerId,
        runtimeAuthority: {
          schemaVersion: 1,
          kind: "podman",
          ownership: "current-user",
          uid: process.getuid?.() ?? 1001,
          homeDir,
          configHome: path.join(homeDir, ".config"),
          runtimeDir: path.join("/run/user", String(process.getuid?.() ?? 1001)),
          socketPath: path.join(
            "/run/user",
            String(process.getuid?.() ?? 1001),
            "podman/podman.sock",
          ),
        },
      })}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(stateDir, "sandboxes.json"),
      `${JSON.stringify({
        defaultSandbox: "alpha",
        sandboxes: {
          alpha: {
            name: "alpha",
            agent: "openclaw",
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
            openshellDriver: "docker",
            lifecycleGeneration: containerId,
          },
          beta: {
            name: "beta",
            agent: "openclaw",
            gatewayName: "nemoclaw-9000",
            gatewayPort: 9000,
            openshellDriver: "docker",
            lifecycleGeneration: "b".repeat(64),
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const detectPortable = vi.fn(hasPortableRuntimeCleanup);
    const removeSandbox = vi.fn(() => 1);
    const removeShared = vi.fn(() => ({ registryRemoved: true, selectorsRemoved: [] }));
    try {
      expect(hasPortableRuntimeCleanup(stateDir)).toBe(true);
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => ["openshell", "pgrep", "lsof"].includes(command),
          env: { HOME: homeDir } as NodeJS.ProcessEnv,
          existsSync: fs.existsSync,
          hasPortableRuntimeCleanup: detectPortable,
          isPortFree: () => true,
          isTty: false,
          log: vi.fn(),
          removePortableSandboxContainers: removeSandbox,
          removePortableSharedResources: removeShared,
          rmSync: fs.rmSync,
          run: (command, args) =>
            ["pgrep", "lsof"].includes(command)
              ? notFound()
              : command === "openshell" && args.join(" ") === "gateway list -o json"
                ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9000" }]))
                : ok(),
          runDocker: () => ok(""),
        },
      );

      expect(result).toMatchObject({ exitCode: 0, otherGatewayEnvironmentsRemain: true });
      expect(detectPortable).not.toHaveBeenCalled();
      expect(removeSandbox).not.toHaveBeenCalled();
      expect(removeShared).not.toHaveBeenCalled();
      expect(fs.existsSync(receiptFile)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("leaves keep-openshell and external-supervisor flows unchanged (#9189)", () => {
    const hasPortable = vi.fn(() => true);
    const removeSandbox = vi.fn(() => 1);
    const removeShared = vi.fn(() => ({ registryRemoved: true, selectorsRemoved: [] }));
    const baseDeps: UninstallRunDeps = {
      commandExists: (command) => command === "openshell",
      env: { HOME: "/tmp/nemoclaw-uninstall-portable-unchanged-9189" } as NodeJS.ProcessEnv,
      existsSync: () => false,
      hasPortableRuntimeCleanup: hasPortable,
      isTty: false,
      log: vi.fn(),
      removePortableSandboxContainers: removeSandbox,
      removePortableSharedResources: removeShared,
      rmSync: vi.fn(),
      run: vi.fn(okWithKnownGatewayList),
      runDocker: () => ok(""),
    };

    expect(
      runUninstallPlan({ assumeYes: true, deleteModels: false, keepOpenShell: true }, baseDeps)
        .exitCode,
    ).toBe(0);
    expect(
      runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          ...baseDeps,
          resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
            gatewayName,
            gatewayPort,
            mode: "externally-supervised",
            source: "declared",
            endpoint: "https://127.0.0.1:8080",
            stateDir: "/srv/external-openshell",
            supervisor: {
              kind: "systemd-system",
              serviceName: "external-openshell.service",
              execPath: "/usr/local/bin/openshell-gateway",
            },
            requiredCapabilities: [],
          }),
        },
      ).exitCode,
    ).toBe(0);
    expect(hasPortable).not.toHaveBeenCalled();
    expect(removeSandbox).not.toHaveBeenCalled();
    expect(removeShared).not.toHaveBeenCalled();
  });
});
