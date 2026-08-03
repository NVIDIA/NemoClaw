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

function okWithKnownGatewayList(command: string, args: readonly string[]): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }]))
    : ok();
}

describe("managed distributed vLLM runtime uninstall", () => {
  it.each([
    "dual-station-vllm-runtime.json",
    "dual-spark-vllm-runtime.json",
  ])("removes the pair owned by %s before the remaining full-uninstall steps", (receiptFile) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-dual-pair-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, receiptFile), "{}\n", {
      mode: 0o600,
    });
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
  });

  it("associates the canonical leftover Spark discovery binding with its durable receipt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-spark-claim-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receiptPath = path.join(stateDir, "dual-spark-vllm-runtime.json");
    const discoveryBindingPath = path.join(stateDir, "dual-spark-managed-serving.json.ssh-binding");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
    fs.mkdirSync(`${receiptPath}.ssh-binding`, { mode: 0o700 });
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
      title: "a noncanonical gateway Spark claim despite a host-global Spark receipt",
      receiptFile: "dual-spark-vllm-runtime.json",
      bindingSegments: ["gateways", "18080", "dual-spark-managed-serving.json.ssh-binding"],
    },
    {
      title: "a canonical Spark claim when only a Station receipt exists",
      receiptFile: "dual-station-vllm-runtime.json",
      bindingSegments: ["dual-spark-managed-serving.json.ssh-binding"],
    },
  ])("refuses $title", ({ receiptFile, bindingSegments }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-spark-claim-other-"));
    const stateDir = path.join(home, ".nemoclaw");
    const receiptPath = path.join(stateDir, receiptFile);
    const discoveryBindingPath = path.join(stateDir, ...bindingSegments);
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
    fs.mkdirSync(`${receiptPath}.ssh-binding`, { mode: 0o700 });
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
        "Managed distributed vLLM SSH binding exists without its ownership receipt",
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
    for (const name of ["dual-spark-vllm-runtime.json", "dual-station-vllm-runtime.json"]) {
      fs.writeFileSync(path.join(stateDir, name), "{}\n", { mode: 0o600 });
    }
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
        "Both dual-Spark and dual-Station managed runtime receipts exist. NemoClaw refused ambiguous cleanup before making changes.",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    "dual-spark-vllm-runtime.json",
    "dual-spark-managed-serving.json",
    "dual-station-vllm-runtime.json",
  ])("refuses an orphaned %s SSH binding before cleanup or other mutation", (receiptFile) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-binding-orphan-"));
    const stateDir = path.join(home, ".nemoclaw");
    const bindingPath = path.join(stateDir, `${receiptFile}.ssh-binding`);
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
        "Managed distributed vLLM SSH binding exists without its ownership receipt",
      );
      expect(fs.existsSync(bindingPath)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("finds the host-global Spark receipt from a non-default gateway selection", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-spark-global-"));
    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "dual-spark-vllm-runtime.json"), "{}\n", {
      mode: 0o600,
    });
    fs.mkdirSync(path.join(stateDir, "dual-spark-vllm-runtime.json.ssh-binding"), {
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
  });
});
