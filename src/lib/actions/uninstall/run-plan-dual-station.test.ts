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

import { DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE } from "../../inference/serving/managed-runtime-receipts";
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

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(options, {
    hasPortableRuntimeCleanup: () => false,
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

function managedRuntimeBindingPath(receiptPath: string): string {
  return receiptPath.endsWith("managed-cluster-vllm-runtime.json")
    ? `${receiptPath}.rank-1.ssh-binding`
    : `${receiptPath}.ssh-binding`;
}

describe("managed distributed vLLM runtime uninstall", () => {
  it.each(["dual-station-vllm-runtime.json", "managed-cluster-vllm-runtime.json"])(
    "removes the runtime owned by %s before the remaining full-uninstall steps",
    (receiptFile) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dual-pair-"));
      const stateDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(stateDir, { mode: 0o700 });
      const receiptPath = path.join(stateDir, receiptFile);
      fs.writeFileSync(receiptPath, "{}\n", {
        mode: 0o600,
      });
      fs.mkdirSync(managedRuntimeBindingPath(receiptPath), { mode: 0o700 });
      const runDualStationRuntimeCleanup = vi.fn(() => ok());
      const rmSync = vi.fn();
      const runDocker = vi.fn(() => ok());

      try {
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            commandExists: () => true,
            env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
            existsSync: () => false,
            isTty: false,
            log: vi.fn(),
            rmSync,
            run: okWithKnownGatewayList,
            runDocker,
            runDualStationRuntimeCleanup,
          },
        );

        expect(result.exitCode).toBe(0);
        expect(runDualStationRuntimeCleanup).toHaveBeenCalledOnce();
        expect(runDocker).toHaveBeenCalled();
        expect(runDualStationRuntimeCleanup.mock.invocationCallOrder[0]).toBeLessThan(
          runDocker.mock.invocationCallOrder[0],
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("stops a distributed runtime before requesting shared Hugging Face cache-data cleanup", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-cache-order-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receiptPath = path.join(stateDir, DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE);
    const cacheDir = path.join(home, ".cache", "huggingface");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
    fs.mkdirSync(`${receiptPath}.ssh-binding`, { mode: 0o700 });
    fs.mkdirSync(cacheDir, { recursive: true });
    const runDualStationRuntimeCleanup = vi.fn(() => ok());
    const runHuggingFaceCacheDataCleanup = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: true, keepOpenShell: true },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          existsSync: fs.existsSync,
          isTty: false,
          log: vi.fn(),
          rmSync: vi.fn(),
          run: okWithKnownGatewayList,
          runDualStationRuntimeCleanup,
          runHuggingFaceCacheDataCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runDualStationRuntimeCleanup).toHaveBeenCalledOnce();
      expect(runHuggingFaceCacheDataCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ stdio: "inherit" }),
      );
      expect(runDualStationRuntimeCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        runHuggingFaceCacheDataCleanup.mock.invocationCallOrder[0],
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("finds host-global pair ownership when the final gateway uses a non-default port", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dual-port-"));
    const port = 9123;
    const stateDir = path.join(home, ".nemoclaw");
    const legacyStateDir = path.join(stateDir, "gateways", String(port));
    const receiptPath = path.join(legacyStateDir, "dual-station-vllm-runtime.json");
    fs.mkdirSync(legacyStateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
    fs.mkdirSync(`${receiptPath}.ssh-binding`, { mode: 0o700 });
    const runDualStationRuntimeCleanup = vi.fn(() => ok());

    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const { runUninstallPlan: runPortUninstallBase } = await import("./run-plan");
      const result = runPortUninstallBase(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: home, NEMOCLAW_GATEWAY_PORT: String(port), TMPDIR: home },
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
            gatewayName,
            gatewayPort,
            mode: "nemoclaw-managed",
            source: "standalone",
            endpoint: null,
            stateDir: null,
            supervisor: null,
            requiredCapabilities: [],
          }),
          rmSync: vi.fn(),
          run: (command, args) =>
            command === "openshell" && args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: `nemoclaw-${String(port)}` }]))
              : ok(),
          runDocker: () => ok(),
          runDualStationRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runDualStationRuntimeCleanup).toHaveBeenCalledWith(
        receiptPath,
        expect.objectContaining({ stdio: "inherit" }),
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("associates a canonical cluster discovery binding with its durable receipt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-spark-claim-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receiptPath = path.join(stateDir, "managed-cluster-vllm-runtime.json");
    const discoveryBindingPath = path.join(
      stateDir,
      "managed-cluster-managed-serving.json.spark-worker.ssh-binding",
    );
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
    fs.mkdirSync(managedRuntimeBindingPath(receiptPath), { mode: 0o700 });
    fs.mkdirSync(discoveryBindingPath, { mode: 0o700 });
    const runDualStationRuntimeCleanup = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync: vi.fn(),
          run: okWithKnownGatewayList,
          runDocker: () => ok(),
          runDualStationRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runDualStationRuntimeCleanup).toHaveBeenCalledWith(
        receiptPath,
        expect.objectContaining({ stdio: "inherit" }),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      title: "a noncanonical gateway cluster claim despite a host-global cluster receipt",
      receiptFile: "managed-cluster-vllm-runtime.json",
      bindingSegments: [
        "gateways",
        "18080",
        "managed-cluster-managed-serving.json.spark-worker.ssh-binding",
      ],
    },
    {
      title: "a canonical cluster claim when only a Station receipt exists",
      receiptFile: "dual-station-vllm-runtime.json",
      bindingSegments: ["managed-cluster-managed-serving.json.spark-worker.ssh-binding"],
    },
  ])("refuses $title", ({ receiptFile, bindingSegments }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-spark-claim-other-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receiptPath = path.join(stateDir, receiptFile);
    const discoveryBindingPath = path.join(stateDir, ...bindingSegments);
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
    fs.mkdirSync(managedRuntimeBindingPath(receiptPath), { mode: 0o700 });
    fs.mkdirSync(discoveryBindingPath, { recursive: true, mode: 0o700 });
    const errors: string[] = [];
    const runDualStationRuntimeCleanup = vi.fn(() => ok());
    const rmSync = vi.fn();
    const runDocker = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync,
          run: okWithKnownGatewayList,
          runDocker,
          runDualStationRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(runDualStationRuntimeCleanup).not.toHaveBeenCalled();
      expect(runDocker).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain(
        "A managed distributed vLLM SSH binding exists without its ownership receipt",
      );
      expect(fs.existsSync(discoveryBindingPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("targets the exact Station receipt found under a stale non-default gateway root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-stale-station-"));
    const receiptPath = path.join(
      home,
      ".nemoclaw",
      "gateways",
      "18080",
      "dual-station-vllm-runtime.json",
    );
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
    const runDualStationRuntimeCleanup = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync: vi.fn(),
          run: okWithKnownGatewayList,
          runDocker: () => ok(),
          runDualStationRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runDualStationRuntimeCleanup).toHaveBeenCalledWith(
        receiptPath,
        expect.objectContaining({ stdio: "inherit" }),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves host-global pair ownership while sibling gateways remain", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dual-scoped-"));
    const stateDir = path.join(home, ".nemoclaw");
    const gatewayStateDir = path.join(
      home,
      ".local",
      "state",
      "nemoclaw",
      resolveGatewayStateDirName(8080),
    );
    const apiKeyPath = path.join(stateDir, "dual-station-vllm-api-key");
    const receiptPath = path.join(stateDir, "dual-station-vllm-runtime.json");
    const bindingPath = `${receiptPath}.ssh-binding`;
    const selectedStatePath = path.join(stateDir, "selected-only");
    fs.mkdirSync(bindingPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(apiKeyPath, "ab".repeat(32), { mode: 0o600 });
    fs.writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
    fs.writeFileSync(selectedStatePath, "remove me\n");
    const jwtBundle = ensureDockerDriverGatewayJwtBundle(gatewayStateDir);
    fs.writeFileSync(
      path.join(gatewayStateDir, "openshell-gateway.toml"),
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
    writeManagedGatewayRuntimeProof(gatewayStateDir, 8080);
    const runDualStationRuntimeCleanup = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
        withProvenManagedGatewayProcess({
          isPortFree: () => true,
          commandExists: (command) => command === "openshell",
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          existsSync: fs.existsSync,
          isTty: false,
          log: vi.fn(),
          rmSync: fs.rmSync,
          run: (command, args) =>
            command === "openshell" && args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "sibling" }]))
              : ok(),
          runDocker: () => ok(),
          runDualStationRuntimeCleanup,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(apiKeyPath)).toBe(true);
      expect(fs.existsSync(receiptPath)).toBe(true);
      expect(fs.existsSync(bindingPath)).toBe(true);
      expect(fs.existsSync(selectedStatePath)).toBe(false);
      expect(runDualStationRuntimeCleanup).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not start the remaining uninstall steps when managed pair cleanup fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dual-fail-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-runtime.json"), "{}\n", {
      mode: 0o600,
    });
    const errors: string[] = [];
    const rmSync = vi.fn();
    const runDocker = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync,
          run: okWithKnownGatewayList,
          runDocker,
          runDualStationRuntimeCleanup: () => ({
            status: 1,
            stdout: "",
            stderr: "peer unavailable",
          }),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(rmSync).not.toHaveBeenCalled();
      expect(runDocker).not.toHaveBeenCalled();
      expect(errors).toContain(
        "Managed distributed vLLM cleanup did not complete. NemoClaw did not start the remaining uninstall steps. Resolve the reported cleanup error and retry uninstall.",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses ambiguous Spark and Station receipts before cleanup or other mutation", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dual-conflict-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });

    fs.writeFileSync(path.join(stateDir, "managed-cluster-vllm-runtime.json"), "{}\n", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(stateDir, "dual-station-vllm-runtime.json"), "{}\n", {
      mode: 0o600,
    });

    const errors: string[] = [];
    const runDualStationRuntimeCleanup = vi.fn(() => ok());
    const runDocker = vi.fn(() => ok());
    const rmSync = vi.fn();

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync,
          run: okWithKnownGatewayList,
          runDocker,
          runDualStationRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(runDualStationRuntimeCleanup).not.toHaveBeenCalled();
      expect(runDocker).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
      expect(errors).toContain(
        "Both managed cluster and dual-Station managed runtime receipts exist. NemoClaw refused ambiguous cleanup before making changes.",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    "managed-cluster-vllm-runtime.json.rank-1.ssh-binding",
    "managed-cluster-managed-serving.json.spark-worker.ssh-binding",
    "dual-station-vllm-runtime.json.ssh-binding",
  ])("refuses an orphaned %s before cleanup or other mutation", (bindingEntry) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-binding-orphan-"));
    const stateDir = path.join(home, ".nemoclaw");
    const bindingPath = path.join(stateDir, bindingEntry);
    fs.mkdirSync(bindingPath, { recursive: true, mode: 0o700 });
    const errors: string[] = [];
    const runDualStationRuntimeCleanup = vi.fn(() => ok());
    const runDocker = vi.fn(() => ok());
    const rmSync = vi.fn();

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync,
          run: okWithKnownGatewayList,
          runDocker,
          runDualStationRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(runDualStationRuntimeCleanup).not.toHaveBeenCalled();
      expect(runDocker).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain(
        "A managed distributed vLLM SSH binding exists without its ownership receipt",
      );
      expect(fs.existsSync(bindingPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["Spark", "managed-cluster-vllm-runtime.json"],
    ["Station", "dual-station-vllm-runtime.json"],
  ])(
    "finds the host-global %s receipt from a non-default gateway selection",
    async (_topology, receiptFile) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-managed-global-"));
      const stateDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.writeFileSync(path.join(stateDir, receiptFile), "{}\n", {
        mode: 0o600,
      });
      fs.mkdirSync(managedRuntimeBindingPath(path.join(stateDir, receiptFile)), {
        mode: 0o700,
      });
      fs.writeFileSync(path.join(stateDir, "dual-station-vllm-api-key"), `${"a".repeat(64)}\n`, {
        mode: 0o600,
      });
      fs.mkdirSync(path.join(stateDir, "state", "mcp-lifecycle-locks"), {
        recursive: true,
        mode: 0o700,
      });
      const runDualStationRuntimeCleanup = vi.fn(() => ok());

      try {
        vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
        vi.resetModules();
        const { runUninstallPlan: runFreshUninstallPlan } = await import("./run-plan");
        const result = runFreshUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            commandExists: () => true,
            env: { HOME: home, TMPDIR: home, NEMOCLAW_GATEWAY_PORT: "18080" },
            existsSync: () => false,
            isTty: false,
            log: vi.fn(),
            rmSync: vi.fn(),
            run: (command, args) =>
              command === "openshell" && args[0] === "gateway" && args[1] === "list"
                ? ok(JSON.stringify([{ name: "nemoclaw-18080" }]))
                : ok(),
            runDocker: () => ok(),
            runDualStationRuntimeCleanup,
            resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
              gatewayName,
              gatewayPort,
              mode: "nemoclaw-managed",
              source: "standalone",
              endpoint: null,
              stateDir: null,
              supervisor: null,
              requiredCapabilities: [],
            }),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(runDualStationRuntimeCleanup).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      shape: "symbolic link",
      arrange: (stateDir: string, home: string) => {
        const target = path.join(home, "redirected-state");
        fs.mkdirSync(target, { mode: 0o700 });
        fs.symlinkSync(target, stateDir, "dir");
      },
    },
    {
      shape: "regular file",
      arrange: (stateDir: string) => {
        fs.writeFileSync(stateDir, "not a directory\n", { mode: 0o600 });
      },
    },
  ])("fails closed when the host-global managed state root is a $shape", ({ arrange }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-unsafe-root-"));
    const stateDir = path.join(home, ".nemoclaw");
    arrange(stateDir, home);
    const errors: string[] = [];
    const runDualStationRuntimeCleanup = vi.fn(() => ok());
    const runDocker = vi.fn(() => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: home, TMPDIR: home } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: () => false,
          isTty: false,
          log: vi.fn(),
          rmSync: vi.fn(),
          run: okWithKnownGatewayList,
          runDocker,
          runDualStationRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(runDualStationRuntimeCleanup).not.toHaveBeenCalled();
      expect(runDocker).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain(
        "Managed distributed vLLM state root is not a real directory",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
