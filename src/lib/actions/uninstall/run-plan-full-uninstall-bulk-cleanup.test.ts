// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  withProvenManagedGatewayProcess,
  writeManagedGatewayRuntimeProof,
} from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "../../onboard/docker-driver-gateway-config";
import { writeCompleteDockerDriverGatewayLocalTlsBundle } from "../../onboard/__test-helpers__/docker-driver-gateway-local-tls";
import { getDockerDriverGatewayLocalTlsBundle } from "../../onboard/docker-driver-gateway-local-tls";
import {
  ensureManagedGatewayStateRoot,
  MANAGED_GATEWAY_STATE_ROOT_MARKER,
  resolveGatewayStateDirName,
} from "../../onboard/gateway-binding";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function writeFullCleanupState(
  home: string,
  gatewayStateDir = path.join(
    home,
    ".local",
    "state",
    "nemoclaw",
    resolveGatewayStateDirName(8080),
  ),
): string {
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

  writeCompleteDockerDriverGatewayLocalTlsBundle(gatewayStateDir);
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

function fullCleanupDeps(
  home: string,
  calls: string[][],
  sandboxInventory: string,
  commandInvocations?: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>,
) {
  const responses = new Map<string, RunResult>([
    ["gateway list -o json", ok(JSON.stringify([{ name: "nemoclaw" }]))],
    ["sandbox list", ok(sandboxInventory)],
  ]);
  return {
    commandExists: (command: string) => command === "docker" || command === "openshell",
    env: {
      HOME: home,
      NEMOCLAW_NON_INTERACTIVE: "1",
      OPENSHELL_GATEWAY: "foreign-gateway",
      OPENSHELL_GATEWAY_ENDPOINT: "https://foreign.invalid",
      OPENSHELL_LOCAL_TLS_DIR: "/foreign/tls",
      OPENSHELL_WORKSPACE: "foreign-workspace",
    } as NodeJS.ProcessEnv,
    error: vi.fn(),
    existsSync: (target: string) => target.startsWith(home) && fs.existsSync(target),
    hasPortableRuntimeCleanup: () => false,
    isTty: false,
    log: vi.fn(),
    rmSync: fs.rmSync,
    run: (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push(args);
      commandInvocations?.push({ args, env: options?.env });
      return responses.get(args.join(" ")) ?? ok();
    },
    runDocker: () => ok(),
    sleep: vi.fn(),
  } satisfies UninstallRunDeps;
}

describe("full uninstall bulk sandbox cleanup", () => {
  it("verifies stable empty inventory before provider cleanup (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bulk-empty-"));
    try {
      writeFullCleanupState(home);
      const calls: string[][] = [];
      const commandInvocations: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        fullCleanupDeps(home, calls, "No sandboxes found.\n", commandInvocations),
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
      const selectedGatewayTlsDir = getDockerDriverGatewayLocalTlsBundle(
        path.join(home, ".local", "state", "nemoclaw", resolveGatewayStateDirName(8080)),
      ).localTlsDir;
      const deleteInvocations = commandInvocations.filter(
        ({ args }) => args.join(" ") === "sandbox delete --all",
      );
      expect(deleteInvocations).toHaveLength(1);
      expect(deleteInvocations[0]?.env).toMatchObject({
        OPENSHELL_GATEWAY: "nemoclaw",
        OPENSHELL_LOCAL_TLS_DIR: selectedGatewayTlsDir,
        OPENSHELL_WORKSPACE: "default",
      });
      expect(deleteInvocations[0]?.env?.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
      const providerEnvironments = commandInvocations
        .filter(({ args }) => args[0] === "provider" && args[1] === "delete")
        .map(({ env }) => env);
      expect(providerEnvironments.length).toBeGreaterThan(0);
      expect(
        providerEnvironments.every(
          (env) =>
            env?.OPENSHELL_GATEWAY === "nemoclaw" &&
            env.OPENSHELL_WORKSPACE === "default" &&
            env.OPENSHELL_LOCAL_TLS_DIR === selectedGatewayTlsDir &&
            env.OPENSHELL_GATEWAY_ENDPOINT === undefined,
        ),
      ).toBe(true);
      const gatewayRemoveInvocations = commandInvocations.filter(
        ({ args }) => args.join(" ") === "gateway remove nemoclaw",
      );
      expect(gatewayRemoveInvocations).toHaveLength(1);
      expect(gatewayRemoveInvocations[0]?.env).toMatchObject({
        OPENSHELL_GATEWAY: "nemoclaw",
        OPENSHELL_LOCAL_TLS_DIR: selectedGatewayTlsDir,
        OPENSHELL_WORKSPACE: "default",
      });
      expect(gatewayRemoveInvocations[0]?.env?.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
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

  it("refuses bulk sandbox cleanup for an externally supervised gateway (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-bulk-external-"));
    try {
      const registryFile = writeFullCleanupState(home);
      const gatewayStateDir = path.join(
        home,
        ".local",
        "state",
        "nemoclaw",
        resolveGatewayStateDirName(8080),
      );
      const calls: string[][] = [];
      const deps = fullCleanupDeps(home, calls, "No sandboxes found.\n");
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          ...deps,
          resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
            gatewayName,
            gatewayPort,
            mode: "externally-supervised",
            source: "declared",
            endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
            stateDir: gatewayStateDir,
            supervisor: {
              kind: "systemd-user",
              serviceName: "openshell-gateway.service",
              execPath: "/usr/local/bin/openshell-gateway",
            },
            requiredCapabilities: [],
          }),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(calls.some((args) => args.join(" ") === "sandbox delete --all")).toBe(false);
      expect(calls.some((args) => args[0] === "provider" && args[1] === "delete")).toBe(false);
      expect(calls.some((args) => args[0] === "gateway" && args[1] === "remove")).toBe(false);
      expect(deps.error).toHaveBeenCalledWith(
        "Refusing bulk sandbox cleanup for an externally supervised gateway; preserving its state for retry.",
      );
      expect(fs.existsSync(registryFile)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("revalidates explicit gateway state ownership inside the default root (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-bulk-ownership-"));
    try {
      const gatewayStateDir = path.join(
        home,
        ".local",
        "state",
        "nemoclaw",
        "explicit-gateway-state",
      );
      fs.mkdirSync(path.dirname(gatewayStateDir), { recursive: true });
      ensureManagedGatewayStateRoot({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        stateDir: gatewayStateDir,
      });
      const registryFile = writeFullCleanupState(home, gatewayStateDir);
      writeManagedGatewayRuntimeProof(gatewayStateDir, 8080);
      const calls: string[][] = [];
      const deps = fullCleanupDeps(home, calls, "No sandboxes found.\n");
      const processEnvironment = {
        [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: gatewayIdForStateDir(gatewayStateDir),
      };
      const readProcessEnvironment = vi
        .fn()
        .mockReturnValueOnce(processEnvironment)
        .mockImplementationOnce(() => {
          fs.writeFileSync(path.join(gatewayStateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER), "{}\n", {
            mode: 0o600,
          });
          return processEnvironment;
        });
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          ...deps,
          env: {
            ...deps.env,
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: gatewayStateDir,
          },
          readProcessEnvironment,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(readProcessEnvironment).toHaveBeenCalledTimes(2);
      expect(calls.some((args) => args.join(" ") === "sandbox delete --all")).toBe(false);
      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "configured state directory is not proven to be the selected gateway's dedicated managed root",
        ),
      );
      expect(fs.existsSync(registryFile)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("revalidates the custom gateway process before bulk cleanup (#11831)", async () => {
    const home = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-bulk-process-"));
    try {
      const gatewayStateDir = path.join(home, "custom-gateway-state");
      ensureManagedGatewayStateRoot({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        stateDir: gatewayStateDir,
      });
      const registryFile = writeFullCleanupState(home, gatewayStateDir);
      writeManagedGatewayRuntimeProof(gatewayStateDir, 8080);
      const calls: string[][] = [];
      const deps = fullCleanupDeps(home, calls, "No sandboxes found.\n");
      const processEnvironment = {
        [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: gatewayIdForStateDir(gatewayStateDir),
      };
      const readProcessEnvironment = vi
        .fn()
        .mockReturnValueOnce(processEnvironment)
        .mockReturnValueOnce(processEnvironment)
        .mockReturnValue({
          [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]: "replacement-gateway",
        });
      const result = await runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          ...deps,
          env: {
            ...deps.env,
            NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: gatewayStateDir,
          },
          readProcessEnvironment,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(readProcessEnvironment).toHaveBeenCalledTimes(3);
      expect(calls.some((args) => args.join(" ") === "sandbox delete --all")).toBe(false);
      expect(deps.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "package-managed OpenShell gateway service identity cannot be proven",
        ),
      );
      expect(fs.existsSync(registryFile)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
