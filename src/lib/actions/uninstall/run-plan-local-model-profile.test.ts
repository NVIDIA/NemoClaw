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

  it("names the managed llama.cpp cache in destructive confirmation", () => {
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
    expect(logs).toContain("  · NemoClaw-managed llama.cpp model cache: removed");
    expect(logs).toContain("Aborted.");
  });

  it("runs managed llama.cpp cache cleanup for --delete-models without runtime state", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-llama-cache-"));
    const cacheDir = path.join(tmpHome, ".cache", "nemoclaw", "llama-cpp");
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
      expect(runLocalModelRuntimeCleanup).toHaveBeenCalledWith(true, expect.any(Object));
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
        existsSync: (target) => String(target).endsWith("/.cache/nemoclaw/llama-cpp"),
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
