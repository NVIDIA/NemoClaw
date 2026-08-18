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
  managedLlamaCppStatePaths,
  reserveManagedLlamaCppOwner,
} from "../../inference/llama-cpp/managed-state";
import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../../onboard/docker-driver-gateway-config";
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

function dockerResults(results: ReadonlyMap<string, RunResult>) {
  return vi.fn((args: string[]) => results.get(JSON.stringify(args)) ?? ok());
}

const ORPHANED_VLLM_INSPECT_ARGS = [
  "container",
  "inspect",
  "--format",
  '{{.Id}} {{index .Config.Labels "com.nvidia.nemoclaw.managed-vllm"}}',
  "nemoclaw-vllm",
];

const RESERVED_INFERENCE_NAMES_ARGS = ["ps", "-a", "--format", "{{.Names}}"];

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

function runWithOllamaInventory(inventory: RunResult, failedModels: readonly string[] = []) {
  const failures = new Set(failedModels);
  const run: NonNullable<UninstallRunDeps["run"]> = (command, args) =>
    command === "openshell" && args[0] === "gateway" && args[1] === "list"
      ? ok(JSON.stringify([{ name: "nemoclaw" }]))
      : command === "ollama" && args[0] === "list"
        ? inventory
        : command === "ollama" && args[0] === "rm" && failures.has(args[1] ?? "")
          ? notFound()
          : ok();
  return vi.fn(run);
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

function writeScopedGatewayState(home: string): void {
  const stateDir = path.join(
    home,
    ".local",
    "state",
    "nemoclaw",
    "openshell-docker-gateway",
  );
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  fs.writeFileSync(
    path.join(stateDir, "openshell-gateway.toml"),
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
        OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      },
      "/usr/bin/openshell-sandbox",
      jwtBundle,
      gatewayIdForStateDir(stateDir),
    ),
    { mode: 0o600 },
  );
  writeManagedGatewayRuntimeProof(stateDir, 8080);
}

describe("uninstall local model profile cleanup", () => {
  it("removes an orphaned host-local vLLM container only when its managed label is present (#8981)", () => {
    const containerId = "a".repeat(64);
    const runDocker = dockerResults(
      new Map([[JSON.stringify(ORPHANED_VLLM_INSPECT_ARGS), ok(`${containerId} true\n`)]]),
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "docker",
        env: { HOME: "/tmp/nemoclaw-uninstall-orphaned-vllm" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        log: () => {},
        run: vi.fn(okWithKnownGatewayList),
        runDocker,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(runDocker).toHaveBeenCalledWith(
      ["rm", "-f", containerId],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("preserves an orphaned host-local vLLM container without the managed label (#8981)", () => {
    const errors: string[] = [];
    const runDocker = dockerResults(
      new Map([
        [JSON.stringify(ORPHANED_VLLM_INSPECT_ARGS), ok(`${"b".repeat(64)} false\n`)],
        [JSON.stringify(RESERVED_INFERENCE_NAMES_ARGS), ok("nemoclaw-vllm\n")],
      ]),
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "docker",
        env: { HOME: "/tmp/nemoclaw-uninstall-unlabeled-vllm" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        error: (message) => errors.push(message),
        isTty: false,
        log: () => {},
        run: vi.fn(okWithKnownGatewayList),
        runDocker,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(runDocker.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
    expect(errors.join("\n")).toContain("remains after ownership-aware cleanup");
  });

  it("preserves an orphaned host-local vLLM container after malformed inspection output (#8981)", () => {
    const errors: string[] = [];
    const runDocker = dockerResults(
      new Map([
        [JSON.stringify(ORPHANED_VLLM_INSPECT_ARGS), ok("not-a-container-id true\n")],
        [JSON.stringify(RESERVED_INFERENCE_NAMES_ARGS), ok("nemoclaw-vllm\n")],
      ]),
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "docker",
        env: { HOME: "/tmp/nemoclaw-uninstall-malformed-vllm" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        error: (message) => errors.push(message),
        isTty: false,
        log: () => {},
        run: vi.fn(okWithKnownGatewayList),
        runDocker,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(runDocker.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
    expect(errors.join("\n")).toContain("remains after ownership-aware cleanup");
  });

  it("stops uninstall when orphaned host-local vLLM removal fails (#8981)", () => {
    const errors: string[] = [];
    const containerId = "c".repeat(64);
    const runDocker = dockerResults(
      new Map([
        [JSON.stringify(ORPHANED_VLLM_INSPECT_ARGS), ok(`${containerId} true\n`)],
        [JSON.stringify(["rm", "-f", containerId]), notFound()],
      ]),
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "docker",
        env: { HOME: "/tmp/nemoclaw-uninstall-vllm-removal-failure" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        error: (message) => errors.push(message),
        isTty: false,
        log: () => {},
        run: vi.fn(okWithKnownGatewayList),
        runDocker,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(runDocker).toHaveBeenCalledWith(
      ["rm", "-f", containerId],
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(errors.join("\n")).toContain("Could not remove orphaned managed inference container");
    expect(runDocker.mock.calls.some(([args]) => args[0] === "ps")).toBe(false);
  });

  it("fails before generic Docker cleanup when a reserved inference name remains", () => {
    const errors: string[] = [];
    const psResults = new Map([
      [
        JSON.stringify([
          "container",
          "inspect",
          "--format",
          '{{.Id}} {{index .Config.Labels "com.nvidia.nemoclaw.managed-vllm"}}',
          "nemoclaw-vllm",
        ]),
        notFound(),
      ],
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

  it("states that model deletion removes every Ollama model and non-credential Hugging Face cache data", () => {
    const logs: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: false, deleteModels: true, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell",
        env: { HOME: "/tmp/nemoclaw-uninstall-model-confirmation" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: true,
        log: (line) => logs.push(line),
        readLine: () => "no",
        run: vi.fn(okWithKnownGatewayList),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("  · All installed Ollama models");
    expect(logs).toContain(
      "  · Shared Hugging Face cache data: deleted; authentication files kept",
    );
    expect(logs).toContain("Aborted.");
  });

  it("requests shared Hugging Face cache-data cleanup during Model stores", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-llama-cache-"));
    const cacheDir = path.join(tmpHome, ".cache", "huggingface");
    const log = vi.fn();
    const runHuggingFaceCacheDataCleanup = vi.fn(() => ok());
    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: true, keepOpenShell: true },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => target === cacheDir,
          isTty: false,
          log,
          run: vi.fn(okWithKnownGatewayList),
          runHuggingFaceCacheDataCleanup,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runHuggingFaceCacheDataCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ stdio: "inherit" }),
      );
      const modelStoresLogIndex = log.mock.calls.findIndex(
        ([line]) => line === "[5/6] Model stores",
      );
      expect(modelStoresLogIndex).toBeGreaterThanOrEqual(0);
      expect(log.mock.invocationCallOrder[modelStoresLogIndex]).toBeLessThan(
        runHuggingFaceCacheDataCleanup.mock.invocationCallOrder[0],
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("deletes every model returned by Ollama inventory", () => {
    const run = runWithOllamaInventory(
      ok(
        [
          "NAME                   ID              SIZE      MODIFIED",
          "team/first:latest      111111111111    5 GB      1 hour ago",
          "second:q4              222222222222    3 GB      2 hours ago",
        ].join("\n"),
      ),
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "ollama",
        env: { HOME: "/tmp/nemoclaw-uninstall-all-ollama-models" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        log: () => {},
        run,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith(
      "ollama",
      ["list"],
      expect.objectContaining({
        env: expect.objectContaining({ OLLAMA_HOST: "127.0.0.1:11434" }),
        timeout: 10_000,
      }),
    );
    expect(
      run.mock.calls
        .filter(([command, args]) => command === "ollama" && args[0] === "rm")
        .map(([, args]) => args[1]),
    ).toEqual(["team/first:latest", "second:q4"]);
    expect(
      run.mock.calls
        .filter(([command, args]) => command === "ollama" && args[0] === "rm")
        .map(([, , options]) => options?.timeout),
    ).toEqual([60_000, 60_000]);
  });

  it("ignores a remote Ollama environment override during model cleanup", () => {
    const run = runWithOllamaInventory(ok("NAME ID SIZE MODIFIED\nlocal-model 111 1 GB now\n"));

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "ollama",
        env: {
          HOME: "/tmp/nemoclaw-uninstall-local-ollama-only",
          OLLAMA_HOST: "https://remote.example.test:11434",
        } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        log: () => {},
        run,
      },
    );

    expect(result.exitCode).toBe(0);
    run.mock.calls.filter(([command]) => command === "ollama").forEach(([command, , options]) => {
      expect(command).toBe("ollama");
      expect(options?.env?.OLLAMA_HOST).toBe("127.0.0.1:11434");
    });
  });

  it("fails without deleting any Ollama model when inventory is malformed", () => {
    const errors: string[] = [];
    const run = runWithOllamaInventory(
      ok("NAME ID SIZE MODIFIED\n--unsafe 111111111111 1 GB now\n"),
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "ollama",
        env: { HOME: "/tmp/nemoclaw-uninstall-malformed-ollama" } as NodeJS.ProcessEnv,
        error: (message) => errors.push(message),
        existsSync: () => false,
        isTty: false,
        log: () => {},
        run,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(run.mock.calls.some(([command, args]) => command === "ollama" && args[0] === "rm")).toBe(
      false,
    );
    expect(errors.join("\n")).toContain("No Ollama models were removed");
  });

  it("fails without deleting any Ollama model when inventory execution fails", () => {
    const run = runWithOllamaInventory({
      status: 1,
      stdout: "",
      stderr: "daemon unavailable",
    });

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "ollama",
        env: { HOME: "/tmp/nemoclaw-uninstall-failed-ollama-inventory" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        log: () => {},
        run,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(run.mock.calls.some(([command, args]) => command === "ollama" && args[0] === "rm")).toBe(
      false,
    );
  });

  it("attempts every inventoried Ollama removal and fails when one removal fails", () => {
    const run = runWithOllamaInventory(
      ok("NAME ID SIZE MODIFIED\nfirst 111 1 GB now\nsecond 222 1 GB now\n"),
      ["first"],
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "ollama",
        env: { HOME: "/tmp/nemoclaw-uninstall-partial-ollama" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        log: () => {},
        run,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(
      run.mock.calls
        .filter(([command, args]) => command === "ollama" && args[0] === "rm")
        .map(([, args]) => args[1]),
    ).toEqual(["first", "second"]);
  });

  it("does not inventory or remove Ollama models without delete-models", () => {
    const run = vi.fn(okWithKnownGatewayList);

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command === "openshell" || command === "ollama",
        env: { HOME: "/tmp/nemoclaw-uninstall-keep-models" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        log: () => {},
        run,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(run.mock.calls.some(([command]) => command === "ollama")).toBe(false);
  });

  it("cleans selected gateway-owned llama.cpp state before scoped uninstall removes state", () => {
    const tmpHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-llama-scoped-")),
    );
    const stateDir = publishManagedLlamaOwner(tmpHome, 8080, "selected-sandbox");
    writeScopedGatewayState(tmpHome);
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
        withProvenManagedGatewayProcess({
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: fs.existsSync,
          isPortFree: () => true,
          isTty: false,
          log: () => {},
          run: vi.fn((command: string, args: string[]) =>
            command === "openshell" && args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9000" }]))
              : ok(),
          ),
          runManagedLlamaCppRuntimeCleanup,
        }),
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
    writeScopedGatewayState(tmpHome);
    const errors: string[] = [];
    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        withProvenManagedGatewayProcess({
          commandExists: (command) => command === "openshell",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          error: (message) => errors.push(message),
          existsSync: fs.existsSync,
          isPortFree: () => true,
          isTty: false,
          log: () => {},
          run: vi.fn((command: string, args: string[]) =>
            command === "openshell" && args[0] === "gateway" && args[1] === "list"
              ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9000" }]))
              : ok(),
          ),
          runManagedLlamaCppRuntimeCleanup: vi.fn(() => ok()),
        }),
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
    expect(errors.join("\n")).toContain("Host-local model runtime cleanup did not complete");
    expect(runDocker.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  });
});
