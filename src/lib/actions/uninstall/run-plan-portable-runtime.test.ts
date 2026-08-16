// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  withProvenManagedGatewayProcess,
  writeManagedGatewayRuntimeProof,
} from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  runUninstallPlanProduction,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";
import {
  hasPortableRuntimeCleanup,
  runPortableRuntimeCleanupTransaction,
  type PortableRuntimeCleanupInput,
} from "./portable-runtime-cleanup";
import {
  preparePortableRetirement,
  publishAndRetirePortableEvidence,
} from "../../state/portable-uninstall-retirement";
import { portableDemoReceiptPath } from "../../onboard/experimental/portable-runtime-receipt-readiness";
import {
  buildDockerDriverGatewayConfigToml,
  gatewayIdForStateDir,
} from "../../onboard/docker-driver-gateway-config";
import { ensureDockerDriverGatewayJwtBundle } from "../../onboard/docker-driver-gateway-jwt-bundle";
import { defaultUninstallPaths } from "./plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

function sandboxAbsent(name: string): RunResult {
  return { status: 1, stdout: "", stderr: `sandbox ${name} not found` };
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

function sharedOpenShellTeardownWasCalled(
  calls: readonly (readonly [string, readonly string[]])[],
): boolean {
  return calls.some(
    ([command, args]) =>
      command === "openshell" &&
      ((args[0] === "provider" && args[1] === "delete") ||
        (args[0] === "gateway" && ["destroy", "remove"].includes(String(args[1])))),
  );
}

function modeledSandboxStatus(
  sandboxName: string,
  registeredSandboxes: ReadonlySet<string>,
  calls: readonly (readonly [string, readonly string[]])[],
  sharedOpenShellFilesAvailable: boolean,
): RunResult {
  return new Map<boolean, RunResult>([
    [true, ok(`${sandboxName} usable`)],
    [false, { status: 1, stdout: "", stderr: `${sandboxName} unavailable` }],
  ]).get(
    registeredSandboxes.has(sandboxName) &&
      !sharedOpenShellTeardownWasCalled(calls) &&
      sharedOpenShellFilesAvailable,
  )!;
}

const temporaryDirectories: string[] = [];

function sharedOpenShellFixture(prefix: string) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(homeDir);
  const paths = defaultUninstallPaths({ home: homeDir });
  const localInstallPaths = paths.openshellInstallPaths.filter((target) =>
    target.startsWith(homeDir),
  );
  for (const target of localInstallPaths) fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(paths.gatewayLocalStateDir, { recursive: true });
  fs.mkdirSync(paths.openshellConfigDir, { recursive: true });
  return {
    homeDir,
    sharedPaths: new Set([
      paths.gatewayLocalStateDir,
      paths.openshellConfigDir,
      ...localInstallPaths,
    ]),
  };
}

function writeAdmissionReceipt(homeDir: string, stateDir: string): string {
  const target = portableDemoReceiptPath("alpha", stateDir);
  const uid = process.getuid?.() ?? 1001;
  fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({
      schemaVersion: 4,
      sandboxName: "alpha",
      sandboxId: "sandbox-alpha",
      containerId: "a".repeat(64),
      dashboardPort: 18789,
      registryGeneration: "a".repeat(64),
      runtimeAuthority: {
        schemaVersion: 1,
        kind: "podman",
        ownership: "current-user",
        uid,
        homeDir,
        configHome: path.join(homeDir, ".config"),
        runtimeDir: `/run/user/${uid}`,
        socketPath: `/run/user/${uid}/podman/podman.sock`,
      },
    })}\n`,
    { mode: 0o600 },
  );
  return target;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable runtime cleanup in the uninstall run plan", () => {
  it.each([
    [
      "receipt without configuration",
      (home: string, state: string) => writeAdmissionReceipt(home, state),
    ],
    [
      "forged configuration cleanup",
      (home: string) => {
        const target = path.join(
          home,
          ".config/nemoclaw/portable",
          `.containers.conf.portable-uninstall-${"e".repeat(64)}.cleanup`,
        );
        fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
        fs.writeFileSync(target, "unknown", { mode: 0o600 });
        return target;
      },
    ],
    [
      "retirement record with replacement authority",
      (home: string, state: string) => {
        const receipt = writeAdmissionReceipt(home, state);
        const registry = path.join(state, "sandboxes.json");
        const config = path.join(home, ".config/nemoclaw/portable/containers.conf");
        fs.mkdirSync(path.dirname(config), { mode: 0o700, recursive: true });
        fs.writeFileSync(config, "[engine]\n", { mode: 0o600 });
        fs.writeFileSync(registry, '{"sandboxes":{"alpha":{"name":"alpha"}}}\n', {
          mode: 0o600,
        });
        publishAndRetirePortableEvidence(preparePortableRetirement(home, [path.basename(receipt)]));
        fs.writeFileSync(registry, "{}\n", { mode: 0o600 });
        return path.join(state, "portable-uninstall-retirement.json");
      },
    ],
    ["unsafe state root", (_home: string, state: string) => (fs.chmodSync(state, 0o777), state)],
    [
      "unsafe receipt root",
      (_home: string, state: string) => {
        const target = path.join(state, "portable-demo-lifecycle");
        fs.mkdirSync(target, { mode: 0o755 });
        return target;
      },
    ],
    [
      "unsafe configuration root",
      (home: string) => {
        const target = path.join(home, ".config/nemoclaw/portable");
        fs.mkdirSync(target, { mode: 0o755, recursive: true });
        return target;
      },
    ],
    [
      "symlinked receipt root",
      (_home: string, state: string) => {
        const target = path.join(state, "portable-demo-lifecycle");
        fs.symlinkSync(state, target);
        return target;
      },
    ],
    [
      "symlinked configuration root",
      (home: string, state: string) => {
        const target = path.join(home, ".config/nemoclaw/portable");
        fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
        fs.symlinkSync(state, target);
        return target;
      },
    ],
    [
      "excess receipt entries",
      (_home: string, state: string) => {
        const target = path.join(state, "portable-demo-lifecycle");
        fs.mkdirSync(target, { mode: 0o700 });
        for (let index = 0; index <= 1_024; index++)
          fs.writeFileSync(path.join(target, `extra-${index}`), "x");
        return target;
      },
    ],
    [
      "excess configuration entries",
      (home: string) => {
        const target = path.join(home, ".config/nemoclaw/portable");
        fs.mkdirSync(target, { mode: 0o700, recursive: true });
        for (let index = 0; index <= 1_024; index++)
          fs.writeFileSync(path.join(target, `extra-${index}`), "x");
        return target;
      },
    ],
    ["HOME gateway-limit", (_home: string, state: string) => state],
    ["HOME gateway-file", (_home: string, state: string) => state],
    ["HOME receipt-inventory", (_home: string, state: string) => state],
    ["HOME orphan-binding", (_home: string, state: string) => state],
  ])("rejects %s before generic effects (#9189)", async (_case, mutate) => {
    const privateHome = _case.startsWith("HOME ");
    const homeDir = fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        privateHome ? "nemoclaw-secret-home-sentinel-" : "nemoclaw-portable-admission-",
      ),
    );
    temporaryDirectories.push(homeDir);
    const stateDir = path.join(homeDir, ".nemoclaw");
    const gatewaysDir = path.join(stateDir, "gateways");
    const registry = path.join(stateDir, "sandboxes.json");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(registry, '{"defaultSandbox":null,"sandboxes":{}}\n', { mode: 0o600 });
    let evidence = mutate(homeDir, stateDir);
    const expectedRegistry = fs.readFileSync(registry, "utf8");
    const gatewayReads = vi.fn((_command: string, _args: string[]) =>
      ok(JSON.stringify([{ name: "nemoclaw" }])),
    );
    const run = vi.fn(() => ok());
    const runDocker = vi.fn(() => ok());
    const runModelCleanup = vi.fn(() => ok());
    const rmSync = vi.fn();
    const kill = vi.fn(() => true);
    const runPortableCleanup = vi.fn();
    let armed = false;
    let createGatewayEvidence = () => undefined;
    if (privateHome && _case.endsWith("gateway-limit")) {
      createGatewayEvidence = () => {
        fs.mkdirSync(gatewaysDir, { recursive: true });
        for (let index = 0; index <= 1_024; index++)
          fs.writeFileSync(path.join(gatewaysDir, `x${index}`), "");
      };
    } else if (_case.endsWith("gateway-file")) {
      evidence = path.join(gatewaysDir, "8090");
      createGatewayEvidence = () => {
        fs.mkdirSync(gatewaysDir, { recursive: true });
        fs.writeFileSync(evidence, "unsafe");
      };
    } else if (_case.endsWith("receipt-inventory")) {
      const readdir = fs.readdirSync.bind(fs);
      vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options?: any) =>
        armed && String(target) === stateDir
          ? (() => {
              throw new Error(`${homeDir}/receipt`);
            })()
          : readdir(target, options)) as typeof fs.readdirSync);
    } else if (_case.endsWith("orphan-binding")) {
      evidence = path.join(stateDir, "dual-station-vllm-runtime.json.ssh-binding");
      fs.mkdirSync(evidence);
    }
    if (privateHome) {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const result = await runUninstallPlanProduction(
        { assumeYes: true, deleteModels: true, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => command === "openshell",
          env: { HOME: homeDir },
          existsSync: fs.existsSync,
          hasPortableRuntimeCleanup: () => {
            armed = true;
            createGatewayEvidence();
            return false;
          },
          isTty: false,
          kill,
          log: vi.fn(),
          rmSync,
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
          run: gatewayReads,
          runDocker,
          runDualStationRuntimeCleanup: runModelCleanup,
          runHuggingFaceCacheDataCleanup: runModelCleanup,
          runLocalModelRuntimeCleanup: runModelCleanup,
          runManagedLlamaCppRuntimeCleanup: runModelCleanup,
          runPortableRuntimeCleanupTransaction: runPortableCleanup,
          withPortableHostFence: async (_home, operation) => await operation(),
        },
      );
      const output = stderr.mock.calls.flat().join("\n");
      const category = _case.includes("gateway-")
        ? "Managed llama.cpp cleanup could not safely inventory gateway-scoped ownership state."
        : _case.includes("receipt-")
          ? "Could not inspect managed distributed vLLM rollback state."
          : "A managed distributed vLLM SSH binding exists without its ownership receipt.";
      expect(result.exitCode).toBe(1);
      expect(output).toContain(category);
      expect(output).not.toContain(homeDir);
      expect(output).not.toContain("secret-home-sentinel");
      expect(gatewayReads).toHaveBeenCalled();
      expect(
        gatewayReads.mock.calls.every(
          ([command, args]) => command === "openshell" && args.join(" ") === "gateway list -o json",
        ),
      ).toBe(true);
      expect(runDocker).not.toHaveBeenCalled();
      expect(runModelCleanup).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(runPortableCleanup).not.toHaveBeenCalled();
      expect(fs.existsSync(evidence)).toBe(true);
      return;
    }
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, destroyUserData: true, keepOpenShell: false },
      {
        commandExists: () => false,
        env: { HOME: homeDir },
        existsSync: fs.existsSync,
        hasPortableRuntimeCleanup,
        isTty: false,
        kill,
        log: vi.fn(),
        rmSync,
        run,
        runDocker,
        runHuggingFaceCacheDataCleanup: runModelCleanup,
        runLocalModelRuntimeCleanup: runModelCleanup,
        runPortableRuntimeCleanupTransaction: runPortableCleanup,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(
      [run, runDocker, runModelCleanup, rmSync, kill, runPortableCleanup].every(
        (effect) => effect.mock.calls.length === 0,
      ),
    ).toBe(true);
    expect(fs.readFileSync(registry, "utf8")).toBe(expectedRegistry);
    expect(fs.existsSync(evidence)).toBe(true);
  });

  it("uses exact receipt names without Docker or an all-sandbox mutation (#9189)", () => {
    const order: string[] = [];
    const logs: string[] = [];
    const registeredSandboxes = new Set(["alpha", "unrelated"]);
    const { homeDir, sharedPaths: sharedOpenShellPaths } = sharedOpenShellFixture(
      "nemoclaw-portable-success-",
    );
    const removed: string[] = [];
    const runHandlers = new Map<string, () => RunResult>([
      ["pgrep", notFound],
      ["lsof", notFound],
      [
        "openshell sandbox delete -g nemoclaw alpha",
        () => {
          order.push("exact-openshell");
          registeredSandboxes.delete("alpha");
          return ok();
        },
      ],
      ["openshell sandbox get -g nemoclaw alpha", () => sandboxAbsent("alpha")],
      ["openshell status -g nemoclaw", () => ok("Status: Connected\nGateway: nemoclaw\n")],
    ]);
    const run = vi.fn((command: string, args: string[]) =>
      (
        runHandlers.get(`${command} ${args.join(" ")}`) ??
        runHandlers.get(command) ??
        (() => okWithKnownGatewayList(command, args))
      )(),
    );
    const runPortableCleanup = vi.fn(
      (
        _input: PortableRuntimeCleanupInput,
        continueAfterSandboxRemoval: (
          removed: number,
          sandboxNames: readonly string[],
          gatewayName: string,
        ) => boolean,
      ) => {
        order.push("exact-sandbox");
        expect(continueAfterSandboxRemoval(1, ["alpha"], "nemoclaw")).toBe(true);
        order.push("exact-shared");
        return {
          registryRemoved: true,
          sandboxContainersRemoved: 1,
          selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
        };
      },
    );
    const runDocker = vi.fn(() => ok(""));
    const kill = vi.fn(() => true);

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, keepOpenShell: false },
      {
        commandExists: (command) => ["openshell", "pgrep", "lsof", "docker"].includes(command),
        env: { HOME: homeDir } as NodeJS.ProcessEnv,
        existsSync: (target) => sharedOpenShellPaths.has(String(target)),
        hasPortableRuntimeCleanup: () => true,
        isTty: false,
        kill,
        log: (line) => logs.push(line),
        rmSync: vi.fn((target: fs.PathLike) => removed.push(String(target))),
        run,
        runDocker,
        runPortableRuntimeCleanupTransaction: runPortableCleanup,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(order).toEqual(["exact-sandbox", "exact-openshell", "exact-shared"]);
    expect(runPortableCleanup).toHaveBeenCalledOnce();
    expect(runDocker).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
    expect(run.mock.calls.every(([command]) => command === "openshell")).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.anything(),
    );
    expect(
      run.mock.calls.some(
        ([command, args]) => command === "openshell" && args.join(" ") === "sandbox delete --all",
      ),
    ).toBe(false);
    expect(
      modeledSandboxStatus(
        "unrelated",
        registeredSandboxes,
        run.mock.calls,
        [...sharedOpenShellPaths].every((target) => !removed.includes(target)),
      ),
    ).toEqual(ok("unrelated usable"));
    expect(logs).toContain("Kept Podman images and containers outside receipt-owned cleanup.");
    expect(logs).toContain(
      "Kept shared OpenShell provider and gateway registrations for unrelated sandboxes.",
    );
    expect(logs).toContain("Removed the managed portable registry container.");
    expect(logs.join("\n")).toContain("dictionary-testable pseudonymous fingerprints");
    expect(logs.join("\n")).toContain("another process running as this user can change it");
  });

  it("keeps explicit receipt gateway scope when ambient selection drifts (#9189)", () => {
    const registeredSandboxes = new Set([
      "nemoclaw/alpha",
      "nemoclaw/beta",
      "other/alpha",
      "other/beta",
      "other/unrelated",
    ]);
    let ambientGateway = "other";
    const { homeDir, sharedPaths: sharedOpenShellPaths } = sharedOpenShellFixture(
      "nemoclaw-portable-gateway-scope-",
    );
    const removed: string[] = [];
    let statusCalls = 0;
    const runHandlers = new Map<string, () => RunResult>([
      [
        "openshell status -g nemoclaw",
        () => {
          ambientGateway = statusCalls++ % 2 === 0 ? "drifted-after-proof" : ambientGateway;
          return ok("Status: Connected\nGateway: nemoclaw\n");
        },
      ],
      [
        "openshell sandbox delete -g nemoclaw alpha",
        () => {
          registeredSandboxes.delete("nemoclaw/alpha");
          ambientGateway = "other";
          return ok();
        },
      ],
      [
        "openshell sandbox delete -g nemoclaw beta",
        () => {
          registeredSandboxes.delete("nemoclaw/beta");
          ambientGateway = "other";
          return ok();
        },
      ],
      ["openshell sandbox get -g nemoclaw alpha", () => sandboxAbsent("alpha")],
      ["openshell sandbox get -g nemoclaw beta", () => sandboxAbsent("beta")],
      ["pgrep", notFound],
      ["lsof", notFound],
    ]);
    const run = vi.fn((command: string, args: string[]) =>
      (
        runHandlers.get(`${command} ${args.join(" ")}`) ??
        runHandlers.get(command) ??
        (() => okWithKnownGatewayList(command, args))
      )(),
    );
    const runPortableCleanup = vi.fn(
      (
        _input: PortableRuntimeCleanupInput,
        continueAfterSandboxRemoval: (
          removedCount: number,
          sandboxNames: readonly string[],
          gatewayName: string,
        ) => boolean,
      ) => {
        expect(continueAfterSandboxRemoval(2, ["alpha", "beta"], "nemoclaw")).toBe(true);
        return {
          registryRemoved: true,
          sandboxContainersRemoved: 2,
          selectorsRemoved: ["CONTAINERS_CONF"],
        };
      },
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: false },
      {
        commandExists: (command) => ["openshell", "pgrep", "lsof"].includes(command),
        env: { HOME: homeDir },
        existsSync: (target) => sharedOpenShellPaths.has(String(target)),
        hasPortableRuntimeCleanup: () => true,
        isTty: false,
        log: vi.fn(),
        rmSync: vi.fn((target: fs.PathLike) => removed.push(String(target))),
        run,
        runDocker: () => ok(""),
        runPortableRuntimeCleanupTransaction: runPortableCleanup,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(ambientGateway).toBe("other");
    expect(
      run.mock.calls
        .filter(([command, args]) => command === "openshell" && args[0] === "status")
        .map(([, args]) => args),
    ).toEqual([
      ["status", "-g", "nemoclaw"],
      ["status", "-g", "nemoclaw"],
      ["status", "-g", "nemoclaw"],
      ["status", "-g", "nemoclaw"],
    ]);
    expect(
      run.mock.calls
        .filter(([command, args]) => command === "openshell" && args[0] === "sandbox")
        .map(([, args]) => args),
    ).toEqual([
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      ["sandbox", "delete", "-g", "nemoclaw", "beta"],
      ["sandbox", "get", "-g", "nemoclaw", "beta"],
    ]);
    expect(
      run.mock.calls.some(
        ([command, args]) =>
          command === "openshell" && args[0] === "gateway" && args[1] === "select",
      ),
    ).toBe(false);
    expect(registeredSandboxes).toEqual(new Set(["other/alpha", "other/beta", "other/unrelated"]));
    expect(
      modeledSandboxStatus(
        "other/alpha",
        registeredSandboxes,
        run.mock.calls,
        [...sharedOpenShellPaths].every((target) => !removed.includes(target)),
      ),
    ).toEqual(ok("other/alpha usable"));
  });

  it("accepts exact named sandbox absence only after proving gateway reachability (#9189)", () => {
    const registeredSandboxes = new Set(["unrelated"]);
    const { homeDir, sharedPaths: sharedOpenShellPaths } = sharedOpenShellFixture(
      "nemoclaw-portable-absent-",
    );
    const removed: string[] = [];
    const runHandlers = new Map<string, () => RunResult>([
      [
        "openshell sandbox delete -g nemoclaw alpha",
        () => ({ status: 1, stdout: "", stderr: "Error: sandbox alpha not found" }),
      ],
      ["openshell sandbox get -g nemoclaw alpha", () => sandboxAbsent("alpha")],
      ["openshell status -g nemoclaw", () => ok("Status: Connected\nGateway: nemoclaw\n")],
      ["pgrep", notFound],
      ["lsof", notFound],
    ]);
    const run = vi.fn((command: string, args: string[]) =>
      (
        runHandlers.get(`${command} ${args.join(" ")}`) ??
        runHandlers.get(command) ??
        (() => okWithKnownGatewayList(command, args))
      )(),
    );
    const runPortableCleanup = vi.fn(
      (
        _input: PortableRuntimeCleanupInput,
        continueAfterSandboxRemoval: (
          removed: number,
          sandboxNames: readonly string[],
          gatewayName: string,
        ) => boolean,
      ) => {
        expect(continueAfterSandboxRemoval(1, ["alpha"], "nemoclaw")).toBe(true);
        return {
          registryRemoved: true,
          sandboxContainersRemoved: 1,
          selectorsRemoved: ["CONTAINERS_CONF"],
        };
      },
    );

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: false },
      {
        commandExists: (command) => ["openshell", "pgrep", "lsof"].includes(command),
        env: { HOME: homeDir },
        existsSync: (target) => sharedOpenShellPaths.has(String(target)),
        hasPortableRuntimeCleanup: () => true,
        isTty: false,
        log: vi.fn(),
        rmSync: vi.fn((target: fs.PathLike) => removed.push(String(target))),
        run,
        runDocker: () => ok(""),
        runPortableRuntimeCleanupTransaction: runPortableCleanup,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith("openshell", ["status", "-g", "nemoclaw"], expect.anything());
    expect(
      modeledSandboxStatus(
        "unrelated",
        registeredSandboxes,
        run.mock.calls,
        [...sharedOpenShellPaths].every((target) => !removed.includes(target)),
      ),
    ).toEqual(ok("unrelated usable"));
  });

  it.each([
    ["eventual exact absence", 3, 0, 2],
    ["exit zero while the sandbox remains", Number.POSITIVE_INFINITY, 1, 4],
  ])(
    "%s after a scoped delete uses bounded exact-name verification (#9189)",
    (_case, absentAttempt, expectedExit, expectedSleeps) => {
      let getCalls = 0;
      const sleep = vi.fn();
      const runHandlers = new Map<string, () => RunResult>([
        ["openshell status -g nemoclaw", () => ok("Status: Connected\nGateway: nemoclaw\n")],
        ["openshell sandbox delete -g nemoclaw alpha", () => ok()],
        [
          "openshell sandbox get -g nemoclaw alpha",
          () =>
            ++getCalls >= absentAttempt ? sandboxAbsent("alpha") : ok("sandbox alpha present"),
        ],
        ["pgrep", notFound],
        ["lsof", notFound],
      ]);
      const run = vi.fn((command: string, args: string[]) =>
        (
          runHandlers.get(`${command} ${args.join(" ")}`) ??
          runHandlers.get(command) ??
          (() => okWithKnownGatewayList(command, args))
        )(),
      );
      const runPortableCleanup = vi.fn(
        (
          _input: PortableRuntimeCleanupInput,
          continueAfterSandboxRemoval: (
            removed: number,
            sandboxNames: readonly string[],
            gatewayName: string,
          ) => boolean,
        ) =>
          continueAfterSandboxRemoval(1, ["alpha"], "nemoclaw")
            ? { registryRemoved: true, sandboxContainersRemoved: 1, selectorsRemoved: [] }
            : null,
      );

      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
        {
          commandExists: (command) => ["openshell", "pgrep", "lsof"].includes(command),
          env: { HOME: "/tmp/nemoclaw-bounded-absence-9189" },
          existsSync: () => false,
          hasPortableRuntimeCleanup: () => true,
          isTty: false,
          log: vi.fn(),
          rmSync: vi.fn(),
          run,
          runDocker: vi.fn(() => ok()),
          runPortableRuntimeCleanupTransaction: runPortableCleanup,
          sleep,
        },
      );

      expect(result.exitCode).toBe(expectedExit);
      expect(getCalls).toBe(expectedExit === 0 ? absentAttempt : 5);
      expect(sleep).toHaveBeenCalledTimes(expectedSleeps);
      expect(runPortableCleanup).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      "gateway missing",
      'Error: status: NotFound, message: "gateway nemoclaw not found"',
      ok("Status: Connected\nGateway: nemoclaw\n"),
      "OpenShell sandbox 'alpha' could not be removed",
    ],
    [
      "provider missing",
      'Error: status: NotFound, message: "provider nvidia-nim not found"',
      ok("Status: Connected\nGateway: nemoclaw\n"),
      "OpenShell sandbox 'alpha' could not be removed",
    ],
    [
      "transport failure",
      "Error: transport failure: connection refused",
      ok("Status: Connected\nGateway: nemoclaw\n"),
      "OpenShell sandbox 'alpha' could not be removed",
    ],
    [
      "generic NotFound",
      "Error: NotFound: requested entity is missing",
      ok("Status: Connected\nGateway: nemoclaw\n"),
      "OpenShell sandbox 'alpha' could not be removed",
    ],
    [
      "explicit gateway scoping rejected",
      "Error: unknown option '-g'",
      ok("Status: Connected\nGateway: nemoclaw\n"),
      "OpenShell sandbox 'alpha' could not be removed",
    ],
    [
      "unreachable gateway after exact named absence",
      "Error: sandbox alpha not found",
      { status: 1, stdout: "", stderr: "connection refused" },
      "Portable OpenShell cleanup requires connected gateway 'nemoclaw'",
    ],
  ])(
    "rejects %s and preserves all retry evidence (#9189)",
    (_caseName, deleteError, statusResult, expectedError) => {
      const removed: string[] = [];
      const errors: string[] = [];
      const registeredSandboxes = new Set(["alpha", "unrelated"]);
      const portableEvidence = {
        config: true,
        gatewayRegistration: true,
        providerRegistration: true,
        receipt: true,
        registryContainer: true,
        registryRow: true,
        selectors: true,
        state: true,
      };
      const { homeDir, sharedPaths: sharedOpenShellPaths } = sharedOpenShellFixture(
        "nemoclaw-portable-failure-",
      );
      const runHandlers = new Map<string, () => RunResult>([
        [
          "openshell sandbox delete -g nemoclaw alpha",
          () => ({ status: 1, stdout: "", stderr: deleteError }),
        ],
        ["openshell status -g nemoclaw", () => statusResult],
        ["pgrep", notFound],
        ["lsof", notFound],
      ]);
      const run = vi.fn((command: string, args: string[]) =>
        (
          runHandlers.get(`${command} ${args.join(" ")}`) ??
          runHandlers.get(command) ??
          (() => okWithKnownGatewayList(command, args))
        )(),
      );
      const runPortableCleanup = vi.fn(
        (
          _input: PortableRuntimeCleanupInput,
          continueAfterSandboxRemoval: (
            removed: number,
            sandboxNames: readonly string[],
            gatewayName: string,
          ) => boolean,
        ) => {
          const continued = continueAfterSandboxRemoval(1, ["alpha"], "nemoclaw");
          const finishSharedCleanup = () => {
            Object.assign(portableEvidence, {
              config: false,
              gatewayRegistration: false,
              providerRegistration: false,
              receipt: false,
              registryContainer: false,
              registryRow: false,
              selectors: false,
              state: false,
            });
            return {
              registryRemoved: true,
              sandboxContainersRemoved: 1,
              selectorsRemoved: ["CONTAINERS_CONF"],
            };
          };
          return new Map<boolean, () => ReturnType<typeof finishSharedCleanup> | null>([
            [false, () => null],
            [true, finishSharedCleanup],
          ]).get(continued)!();
        },
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
          env: { HOME: homeDir },
          error: (line) => errors.push(line),
          existsSync: (target) => sharedOpenShellPaths.has(String(target)),
          hasPortableRuntimeCleanup: () => true,
          isTty: false,
          log: vi.fn(),
          rmSync: vi.fn((target: fs.PathLike) => removed.push(String(target))),
          run,
          runDocker: () => ok(""),
          runPortableRuntimeCleanupTransaction: runPortableCleanup,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(errors.join("\n")).toContain(expectedError);
      expect(removed).toEqual([]);
      expect(portableEvidence).toEqual({
        config: true,
        gatewayRegistration: true,
        providerRegistration: true,
        receipt: true,
        registryContainer: true,
        registryRow: true,
        selectors: true,
        state: true,
      });
      expect(
        run.mock.calls.some(
          ([command, args]) => command === "openshell" && args.join(" ") === "sandbox delete --all",
        ),
      ).toBe(false);
      expect(
        modeledSandboxStatus(
          "unrelated",
          registeredSandboxes,
          run.mock.calls,
          [...sharedOpenShellPaths].every((target) => !removed.includes(target)),
        ),
      ).toEqual(ok("unrelated usable"));
      expect(sharedOpenShellTeardownWasCalled(run.mock.calls)).toBe(false);
    },
  );

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
        runPortableRuntimeCleanupTransaction: () => {
          throw new Error("recorded container remains");
        },
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

  it.each(["config", "registry"] as const)(
    "keeps repeated %s-stage retirement uninstalls out of generic cleanup (#9189)",
    (crashTarget) => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-repeat-"));
      temporaryDirectories.push(homeDir);
      const stateDir = path.join(homeDir, ".nemoclaw");
      const receipt = path.join(stateDir, "portable-demo-lifecycle", `${"a".repeat(64)}.json`);
      const registry = path.join(stateDir, "sandboxes.json");
      const config = path.join(homeDir, ".config/nemoclaw/portable/containers.conf");
      fs.mkdirSync(path.dirname(receipt), { mode: 0o700, recursive: true });
      fs.mkdirSync(path.dirname(config), { mode: 0o700, recursive: true });
      fs.writeFileSync(receipt, "{}\n", { mode: 0o600 });
      fs.writeFileSync(registry, '{"sandboxes":{"alpha":{"name":"alpha"}}}\n', { mode: 0o600 });
      fs.writeFileSync(config, "[engine]\n", { mode: 0o600 });
      const unlink = fs.unlinkSync.bind(fs);
      vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
        String(target).includes(
          `.${crashTarget === "config" ? "containers.conf" : "sandboxes.json"}.portable-uninstall-`,
        ) && assert.fail("injected registry retirement crash");
        unlink(target);
      });
      expect(() =>
        publishAndRetirePortableEvidence(
          preparePortableRetirement(homeDir, [path.basename(receipt)]),
        ),
      ).toThrow(/injected/);
      vi.restoreAllMocks();
      const stageRoot = crashTarget === "config" ? path.dirname(config) : stateDir;
      const stage = path.join(
        stageRoot,
        fs.readdirSync(stageRoot).find((name) => name.includes(".portable-uninstall-"))!,
      );
      const runDocker = vi.fn(() => ok());
      const runModelCleanup = vi.fn(() => ok());
      const kill = vi.fn(() => true);
      const remove = vi.fn(fs.rmSync);
      const run = vi.fn((command: string, args: string[]) =>
        command === "openshell" ? okWithKnownGatewayList(command, args) : notFound(),
      );
      let stagedObserved = false;
      const deps: UninstallRunDeps = {
        commandExists: (command) => command === "openshell",
        env: { HOME: homeDir },
        existsSync: (target) => String(target).startsWith(homeDir) && fs.existsSync(target),
        isTty: false,
        kill,
        log: vi.fn(),
        rmSync: remove,
        run,
        runDocker,
        runHuggingFaceCacheDataCleanup: runModelCleanup,
        runLocalModelRuntimeCleanup: runModelCleanup,
        runPortableRuntimeCleanupTransaction: (input, continueAfterSandboxRemoval) =>
          runPortableRuntimeCleanupTransaction(input, continueAfterSandboxRemoval, {
            withRegistryLock: (_registryFile, operation) => {
              !stagedObserved && expect(fs.existsSync(stage)).toBe(true);
              stagedObserved = true;
              return operation();
            },
          }),
      };

      expect(
        runUninstallPlan(
          { assumeYes: true, deleteModels: true, destroyUserData: true, keepOpenShell: false },
          deps,
        ).exitCode,
      ).toBe(0);
      expect(
        runUninstallPlan(
          { assumeYes: true, deleteModels: true, destroyUserData: true, keepOpenShell: false },
          deps,
        ).exitCode,
      ).toBe(0);
      expect(runDocker).not.toHaveBeenCalled();
      expect(runModelCleanup).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(stagedObserved).toBe(true);
      expect(fs.existsSync(stage)).toBe(false);
      expect(remove.mock.calls.map(([target]) => String(target))).not.toContain(stage);
      expect(run.mock.calls.every(([command]) => command === "openshell")).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "portable-uninstall-retirement.json"))).toBe(true);
    },
  );

  it("stops state deletion when portable state changes after sandbox removal (#9189)", () => {
    const errors: string[] = [];
    const removed: string[] = [];
    const runPortableCleanup = vi.fn(
      (
        _input: PortableRuntimeCleanupInput,
        continueAfterSandboxRemoval: (
          removed: number,
          sandboxNames: readonly string[],
          gatewayName: string,
        ) => boolean,
      ) => {
        continueAfterSandboxRemoval(1, ["alpha"], "nemoclaw");
        throw new Error(
          "Portable lifecycle or registry state changed during exact uninstall cleanup",
        );
      },
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
        env: { HOME: "/tmp/nemoclaw-uninstall-portable-interleaving-9189" } as NodeJS.ProcessEnv,
        error: (line) => errors.push(line),
        existsSync: () => false,
        hasPortableRuntimeCleanup: () => true,
        isTty: false,
        log: vi.fn(),
        rmSync: vi.fn((target: fs.PathLike) => removed.push(String(target))),
        run: (command, args) =>
          ["pgrep", "lsof"].includes(command) ? notFound() : okWithKnownGatewayList(command, args),
        runDocker: () => ok(""),
        runPortableRuntimeCleanupTransaction: runPortableCleanup,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(runPortableCleanup).toHaveBeenCalledOnce();
    expect(errors.join("\n")).toContain("lifecycle or registry state changed");
    expect(removed).toEqual([]);
  });

  it("keeps detected portable receipts during a sibling-gateway scoped pass (#9189)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-sibling-"));
    const stateDir = path.join(homeDir, ".nemoclaw");
    const uninstallPaths = defaultUninstallPaths({ home: homeDir });
    const gatewayStateDir = uninstallPaths.selectedGatewayLocalStateDir;
    const jwt = ensureDockerDriverGatewayJwtBundle(gatewayStateDir);
    fs.mkdirSync(gatewayStateDir, { mode: 0o700, recursive: true });
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
        jwt,
        gatewayIdForStateDir(gatewayStateDir),
      ),
      { mode: 0o600 },
    );
    writeManagedGatewayRuntimeProof(gatewayStateDir, 8080);
    const receiptFile = portableDemoReceiptPath("alpha", stateDir);
    const containerId = "a".repeat(64);
    fs.mkdirSync(path.dirname(receiptFile), { mode: 0o700, recursive: true });
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
    const config = path.join(homeDir, ".config/nemoclaw/portable/containers.conf");
    fs.mkdirSync(path.dirname(config), { mode: 0o700, recursive: true });
    fs.writeFileSync(config, "[engine]\n", { mode: 0o600 });
    const detectPortable = vi.fn(hasPortableRuntimeCleanup);
    const runPortableCleanup = vi.fn(() => ({
      registryRemoved: true,
      sandboxContainersRemoved: 1,
      selectorsRemoved: [],
    }));
    try {
      expect(hasPortableRuntimeCleanup(stateDir)).toBe(true);
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        withProvenManagedGatewayProcess({
          commandExists: (command) => ["openshell", "pgrep", "lsof"].includes(command),
          env: { HOME: homeDir } as NodeJS.ProcessEnv,
          existsSync: fs.existsSync,
          hasPortableRuntimeCleanup: detectPortable,
          isPortFree: () => true,
          isTty: false,
          log: vi.fn(),
          rmSync: fs.rmSync,
          run: (command, args) =>
            ["pgrep", "lsof"].includes(command)
              ? notFound()
              : command === "openshell" && args.join(" ") === "gateway list -o json"
                ? ok(JSON.stringify([{ name: "nemoclaw" }, { name: "nemoclaw-9000" }]))
                : ok(),
          runDocker: () => ok(""),
          runPortableRuntimeCleanupTransaction: runPortableCleanup,
        }),
      );

      expect(result).toMatchObject({ exitCode: 0, otherGatewayEnvironmentsRemain: true });
      expect(detectPortable).not.toHaveBeenCalled();
      expect(runPortableCleanup).not.toHaveBeenCalled();
      expect(fs.existsSync(receiptFile)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(true);
    } finally {
      fs.rmSync(homeDir, { force: true, recursive: true });
    }
  });

  it("leaves keep-openshell and external-supervisor flows unchanged (#9189)", () => {
    const hasPortable = vi.fn(() => true);
    const runPortableCleanup = vi.fn(() => ({
      registryRemoved: true,
      sandboxContainersRemoved: 1,
      selectorsRemoved: [],
    }));
    const baseDeps: UninstallRunDeps = {
      commandExists: (command) => command === "openshell",
      env: { HOME: "/tmp/nemoclaw-uninstall-portable-unchanged-9189" } as NodeJS.ProcessEnv,
      existsSync: () => false,
      hasPortableRuntimeCleanup: hasPortable,
      isTty: false,
      log: vi.fn(),
      rmSync: vi.fn(),
      run: vi.fn(okWithKnownGatewayList),
      runDocker: () => ok(""),
      runPortableRuntimeCleanupTransaction: runPortableCleanup,
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
    expect(runPortableCleanup).not.toHaveBeenCalled();
  });
});
