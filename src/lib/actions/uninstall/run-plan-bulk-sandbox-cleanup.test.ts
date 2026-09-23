// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { withProvenManagedGatewayProcess } from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../../onboard/docker-driver-gateway-config";
import { resolveGatewayStateDirName } from "../../onboard/gateway-binding";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function writeFullCleanupState(home: string): string {
  const registryFile = path.join(home, ".nemoclaw", "sandboxes.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      defaultSandbox: "my-assistant",
      sandboxes: {
        "my-assistant": { name: "my-assistant", gatewayName: "nemoclaw", gatewayPort: 8080 },
      },
    }),
  );

  const gatewayStateDir = path.join(
    home,
    ".local",
    "state",
    "nemoclaw",
    resolveGatewayStateDirName(8080),
  );
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(gatewayStateDir);
  const configPath = path.join(gatewayStateDir, "openshell-gateway.toml");
  fs.writeFileSync(
    configPath,
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
        OPENSHELL_LOCAL_TLS_DIR: path.join(gatewayStateDir, "tls"),
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      },
      "/usr/bin/openshell-sandbox",
      jwtBundle,
      gatewayIdForStateDir(gatewayStateDir),
    ),
    { mode: 0o600 },
  );
  fs.chmodSync(configPath, 0o600);
  return registryFile;
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(
    options,
    withProvenManagedGatewayProcess({
      isPortFree: () => true,
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
      ...deps,
    }),
  );
}

function fullCleanupDeps(home: string, calls: string[][], sandboxInventory: string) {
  const responses = new Map<string, RunResult>([
    ["gateway list -o json", ok(JSON.stringify([{ name: "nemoclaw" }]))],
    ["sandbox list", ok(sandboxInventory)],
  ]);
  return {
    commandExists: (command: string) => command === "openshell",
    env: { HOME: home, NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv,
    error: vi.fn(),
    existsSync: (target: string) => target.startsWith(home) && fs.existsSync(target),
    hasPortableRuntimeCleanup: () => false,
    isTty: false,
    log: vi.fn(),
    rmSync: fs.rmSync,
    run: (_command: string, args: string[]) => {
      calls.push(args);
      return responses.get(args.join(" ")) ?? ok();
    },
    runDocker: () => ok(),
    sleep: vi.fn(),
  } satisfies UninstallRunDeps;
}

describe("full-uninstall bulk sandbox cleanup", () => {
  it("verifies stable empty inventory before provider cleanup (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bulk-empty-"));
    try {
      writeFullCleanupState(home);
      const calls: string[][] = [];
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        fullCleanupDeps(home, calls, "No sandboxes found.\n"),
      );

      expect(result.exitCode).toBe(0);
      const deleteIndex = calls.findIndex((args) => args.join(" ") === "sandbox delete --all");
      const inventoryIndexes = calls
        .map((args, index) => (args.join(" ") === "sandbox list" ? index : -1))
        .filter((index) => index >= 0);
      const providerIndex = calls.findIndex(
        (args) => args.join(" ") === "provider delete nvidia-nim",
      );
      expect(inventoryIndexes).toHaveLength(2);
      expect(inventoryIndexes[0]).toBeGreaterThan(deleteIndex);
      expect(providerIndex).toBeGreaterThan(inventoryIndexes[1]!);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves downstream cleanup when inventory remains nonempty (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bulk-partial-"));
    try {
      const registryFile = writeFullCleanupState(home);
      const calls: string[][] = [];
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        fullCleanupDeps(home, calls, "my-assistant Ready\n"),
      );

      expect(result.exitCode).toBe(1);
      expect(calls.filter((args) => args.join(" ") === "sandbox delete --all")).toHaveLength(1);
      expect(calls.filter((args) => args.join(" ") === "sandbox list")).toHaveLength(5);
      expect(calls.some((args) => args[0] === "provider" && args[1] === "delete")).toBe(false);
      expect(calls.some((args) => args[0] === "gateway" && args[1] === "remove")).toBe(false);
      expect(fs.existsSync(registryFile)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
