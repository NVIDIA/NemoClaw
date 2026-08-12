// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "../../inference/llama-cpp/managed-state";
import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

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

function publishManagedLlamaOwner(
  homeDir: string,
  gatewayPort: number,
  sandboxName: string,
): string {
  const paths = managedLlamaCppStatePaths(homeDir, gatewayPort);
  reserveManagedLlamaCppOwner(paths, {
    schemaVersion: 1,
    sandboxName,
    catalogDigest: `sha256:${"1".repeat(64)}`,
    presetDigest: `sha256:${"2".repeat(64)}`,
    recipeDigest: `sha256:${"3".repeat(64)}`,
    recipeId: "llama-cpp.nemotron.spark-single.v1",
  });
  return paths.stateDir;
}

describe("uninstall local model profile cleanup", () => {
  it("fails before generic Docker cleanup when a reserved inference name remains", () => {
    const errors: string[] = [];
    const psResults = new Map([
      [JSON.stringify(["ps", "-a", "--format", "{{.Names}}"]), ok("nemoclaw-llama-cpp\n")],
      [
        JSON.stringify(["ps", "-a", "--format", "{{.ID}} {{.Image}} {{.Names}}"]),
        ok(
          [
            "id-head image nemoclaw-vllm",
            "id-worker image nemoclaw-vllm-worker",
            "id-cluster image nemoclaw-vllm-cluster-rank-0",
            "id-llama image nemoclaw-llama-cpp",
            "id-other image nemoclaw-helper",
          ].join("\n"),
        ),
      ],
    ]);
    const runDocker = vi.fn((args: string[]) => {
      const result = psResults.get(JSON.stringify(args));
      expect(result, `Unexpected Docker arguments: ${args.join(" ")}`).toBeDefined();
      return result!;
    });

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "docker",
        env: { HOME: "/tmp/nemoclaw-uninstall-runtime-name-guard" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        error: (message) => errors.push(message),
        isTty: false,
        log: () => {},
        run: vi.fn(okWithKnownGatewayList),
        runDocker,
      },
    );

    expect(result.exitCode).toBe(1);
    const removedIds = runDocker.mock.calls
      .filter(([args]) => args[0] === "rm")
      .map(([args]) => args.at(-1));
    expect(removedIds).toEqual([]);
    expect(errors.join("\n")).toContain("remains after ownership-aware cleanup");
  });

  it("fails closed when Docker cannot inventory reserved inference names", () => {
    const errors: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "docker",
        env: { HOME: "/tmp/nemoclaw-uninstall-runtime-inventory-guard" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        error: (message) => errors.push(message),
        isTty: false,
        log: () => {},
        run: vi.fn(okWithKnownGatewayList),
        runDocker: vi.fn((args: string[]) =>
          args[0] === "ps" && args.at(-1) === "{{.Names}}" ? notFound() : ok(),
        ),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("could not inventory reserved managed inference");
  });

  it("states that uninstall preserves the shared Hugging Face cache", () => {
    const logs: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: false, deleteModels: true, keepOpenShell: true },
      {
        commandExists: () => false,
        env: { HOME: "/tmp/nemoclaw-uninstall-model-confirmation" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: true,
        log: (line) => logs.push(line),
        readLine: () => "no",
        run: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("  · Shared Hugging Face model cache: kept");
    expect(logs).toContain("Aborted.");
  });

  it("does not run managed cleanup for a shared Hugging Face cache without runtime state", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-llama-cache-"));
    const cacheDir = path.join(tmpHome, ".cache", "huggingface");
    const runLocalModelRuntimeCleanup = vi.fn(() => ok());
    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: true, keepOpenShell: true },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => target === cacheDir,
          isTty: false,
          log: () => {},
          run: vi.fn(okWithKnownGatewayList),
          runLocalModelRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runLocalModelRuntimeCleanup).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("cleans selected gateway-owned llama.cpp state before scoped uninstall removes state", () => {
    const tmpHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-llama-scoped-")),
    );
    const stateDir = publishManagedLlamaOwner(tmpHome, 8080, "selected-sandbox");
    const runManagedLlamaCppRuntimeCleanup = vi.fn((sandboxName: string, gatewayPort: number) => {
      expect(sandboxName).toBe("selected-sandbox");
      expect(gatewayPort).toBe(8080);
      expect(fs.existsSync(stateDir)).toBe(true);
      fs.rmSync(stateDir, { recursive: true });
      return ok(`state:${stateDir}`);
    });
    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: true, keepOpenShell: true },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: fs.existsSync,
          isTty: false,
          log: () => {},
          run: vi.fn((command: string, args: string[]) =>
            command === "openshell" && args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9000" }]))
              : ok(),
          ),
          runManagedLlamaCppRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.otherGatewayEnvironmentsRemain).toBe(true);
      expect(runManagedLlamaCppRuntimeCleanup).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("cleans orphaned gateway-scoped llama.cpp authority before a full uninstall", () => {
    const tmpHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-llama-all-")),
    );
    const stateDir = publishManagedLlamaOwner(tmpHome, 9000, "orphaned-sandbox");
    const runManagedLlamaCppRuntimeCleanup = vi.fn((sandboxName: string, gatewayPort: number) => {
      expect(sandboxName).toBe("orphaned-sandbox");
      expect(gatewayPort).toBe(9000);
      expect(fs.existsSync(stateDir)).toBe(true);
      fs.rmSync(stateDir, { recursive: true });
      return ok(`state:${stateDir}`);
    });
    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: fs.existsSync,
          isTty: false,
          log: () => {},
          run: vi.fn(okWithKnownGatewayList),
          runManagedLlamaCppRuntimeCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.otherGatewayEnvironmentsRemain).toBe(false);
      expect(runManagedLlamaCppRuntimeCleanup).toHaveBeenCalledWith("orphaned-sandbox", 9000);
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("preserves selected gateway authority when scoped cleanup leaves ownership state", () => {
    const tmpHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-llama-fail-")),
    );
    const stateDir = publishManagedLlamaOwner(tmpHome, 8080, "selected-sandbox");
    const errors: string[] = [];
    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: fs.existsSync,
          isTty: false,
          log: () => {},
          run: vi.fn((command: string, args: string[]) =>
            command === "openshell" && args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9000" }]))
              : ok(),
          ),
          runManagedLlamaCppRuntimeCleanup: vi.fn(() => ok()),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(stateDir)).toBe(true);
      expect(errors.join("\n")).toContain("returned without retiring its ownership state");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("stops before generic Docker cleanup when host-local cleanup fails", () => {
    const errors: string[] = [];
    const runDocker = vi.fn((_args: string[]) => ok());
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "docker",
        env: { HOME: "/tmp/nemoclaw-uninstall-local-cleanup-failure" } as NodeJS.ProcessEnv,
        existsSync: (target) => String(target).endsWith("/.nemoclaw/managed-llama-cpp"),
        error: (message) => errors.push(message),
        isTty: false,
        log: () => {},
        run: vi.fn(okWithKnownGatewayList),
        runDocker,
        runLocalModelRuntimeCleanup: vi.fn(() => notFound()),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Host-local model cleanup did not complete");
    expect(runDocker.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  });
});
