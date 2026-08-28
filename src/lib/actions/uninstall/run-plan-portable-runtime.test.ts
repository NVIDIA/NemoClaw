// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import {
  withProvenManagedGatewayProcess,
  withSuccessfulPreUninstallBackup,
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
  HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE,
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

function withManagedGatewayAuthority(deps: UninstallRunDeps): UninstallRunDeps {
  return {
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
  };
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(options, withManagedGatewayAuthority(deps));
}

function runUninstallPlanWithBackup(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanProduction(
    options,
    withSuccessfulPreUninstallBackup(withManagedGatewayAuthority(deps)),
  );
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

function admissionFailureScope(prefix: string) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(homeDir);
  const stateDir = path.join(homeDir, ".nemoclaw");
  const registry = path.join(stateDir, "sandboxes.json");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(registry, '{"defaultSandbox":null,"sandboxes":{}}\n', { mode: 0o600 });
  return {
    homeDir,
    stateDir,
    registry,
    run: vi.fn(okWithKnownGatewayList),
    runDocker: vi.fn(() => ok()),
    runModelCleanup: vi.fn(() => ok()),
    rmSync: vi.fn(),
    kill: vi.fn(() => true),
    runPortableCleanup: vi.fn(),
  };
}

function admissionFailureDeps(scope: ReturnType<typeof admissionFailureScope>): UninstallRunDeps {
  return {
    commandExists: () => false,
    env: { HOME: scope.homeDir },
    hasPortableRuntimeCleanup,
    isTty: false,
    kill: scope.kill,
    log: vi.fn(),
    rmSync: scope.rmSync,
    run: scope.run,
    runDocker: scope.runDocker,
    runDualStationRuntimeCleanup: scope.runModelCleanup,
    runHuggingFaceCacheDataCleanup: scope.runModelCleanup,
    runLocalModelRuntimeCleanup: scope.runModelCleanup,
    runManagedLlamaCppRuntimeCleanup: scope.runModelCleanup,
    runPortableRuntimeCleanupTransaction: scope.runPortableCleanup,
    withPortableHostFence: async (_home, operation) => await operation(),
  };
}

function directoryEvidence(target: string, mode: number, entries = 0): string {
  fs.mkdirSync(target, { mode, recursive: true });
  for (let index = 0; index < entries; index++)
    fs.writeFileSync(path.join(target, `extra-${index}`), "x");
  return target;
}

function symlinkEvidence(target: string, source: string): string {
  fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
  fs.symlinkSync(source, target);
  return target;
}

function deferredEvidence(target: string, create: (target: string) => void) {
  return { evidence: target, arm: () => create(target) };
}

type EvidenceMutation = (home: string, state: string) => string;
type DeferredMutation = (home: string, state: string) => ReturnType<typeof deferredEvidence>;

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable runtime cleanup in the uninstall run plan", testTimeoutOptions(15_000), () => {
  it.each<[string, EvidenceMutation]>([
    ["receipt without configuration", (home, state) => writeAdmissionReceipt(home, state)],
    [
      "forged configuration cleanup",
      (home) => {
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
      (home, state) => {
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
    ["unsafe state root", (_home, state) => (fs.chmodSync(state, 0o777), state)],
    [
      "unsafe receipt root",
      (_home, state) => directoryEvidence(path.join(state, "portable-demo-lifecycle"), 0o755),
    ],
    [
      "symlinked receipt root",
      (_home, state) => symlinkEvidence(path.join(state, "portable-demo-lifecycle"), state),
    ],
    [
      "symlinked configuration root",
      (home, state) => symlinkEvidence(path.join(home, ".config/nemoclaw/portable"), state),
    ],
    [
      "excess receipt entries",
      (_home, state) =>
        directoryEvidence(path.join(state, "portable-demo-lifecycle"), 0o700, 1_025),
    ],
    [
      "excess configuration entries",
      (home) => directoryEvidence(path.join(home, ".config/nemoclaw/portable"), 0o700, 1_025),
    ],
  ])("rejects %s before generic effects (#9189)", (_case, mutate) => {
    const scope = admissionFailureScope("nemoclaw-portable-admission-");
    const evidence = mutate(scope.homeDir, scope.stateDir);
    const expectedRegistry = fs.readFileSync(scope.registry, "utf8");
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: true, destroyUserData: true, keepOpenShell: false },
      admissionFailureDeps(scope),
    );
    expect(result.exitCode).toBe(1);
    expect(
      [
        scope.run,
        scope.runDocker,
        scope.runModelCleanup,
        scope.rmSync,
        scope.kill,
        scope.runPortableCleanup,
      ].every((effect) => effect.mock.calls.length === 0),
    ).toBe(true);
    expect(fs.readFileSync(scope.registry, "utf8")).toBe(expectedRegistry);
    expect(fs.existsSync(evidence)).toBe(true);
  });

  it.each<[string, string, DeferredMutation]>([
    [
      "HOME gateway-limit",
      "Managed llama.cpp cleanup could not safely inventory gateway-scoped ownership state.",
      (_home, state) =>
        deferredEvidence(path.join(state, "gateways"), (evidence) => {
          fs.mkdirSync(evidence, { recursive: true });
          for (let index = 0; index <= 1_024; index++)
            fs.writeFileSync(path.join(evidence, `x${index}`), "");
        }),
    ],
    [
      "HOME gateway-file",
      "Managed llama.cpp cleanup could not safely inventory gateway-scoped ownership state.",
      (_home, state) =>
        deferredEvidence(path.join(state, "gateways", "8090"), (evidence) => {
          fs.mkdirSync(path.dirname(evidence), { recursive: true });
          fs.writeFileSync(evidence, "unsafe");
        }),
    ],
    [
      "HOME receipt-inventory",
      "Could not inspect managed distributed vLLM rollback state.",
      (home, state) => {
        let armed = false;
        const readdir = fs.readdirSync.bind(fs);
        vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options?: any) =>
          armed && String(target) === state
            ? assert.fail(`${home}/receipt`)
            : readdir(target, options)) as typeof fs.readdirSync);
        return { evidence: state, arm: () => (armed = true) };
      },
    ],
    [
      "HOME orphan-binding",
      "A managed distributed vLLM SSH binding exists without its ownership receipt.",
      (_home, state) => {
        const evidence = path.join(state, "dual-station-vllm-runtime.json.ssh-binding");
        fs.mkdirSync(evidence);
        return { evidence, arm: () => undefined };
      },
    ],
  ])("rejects %s before generic effects (#9189)", async (_case, category, prepare) => {
    const scope = admissionFailureScope("nemoclaw-secret-home-sentinel-");
    const { evidence, arm } = prepare(scope.homeDir, scope.stateDir);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runUninstallPlanProduction(
      { assumeYes: true, deleteModels: true, destroyUserData: true, keepOpenShell: false },
      {
        ...admissionFailureDeps(scope),
        commandExists: (command) => command === "openshell",
        hasPortableRuntimeCleanup: () => (arm(), false),
      },
    );
    const output = stderr.mock.calls.flat().join("\n");
    expect(result.exitCode).toBe(1);
    expect(output).toContain(category);
    expect(output).not.toContain(scope.homeDir);
    expect(output).not.toContain("secret-home-sentinel");
    expect(scope.run).toHaveBeenCalled();
    expect(
      scope.run.mock.calls.every(
        ([cmd, args]) => cmd === "openshell" && args.join(" ") === "gateway list -o json",
      ),
    ).toBe(true);
    expect(scope.runDocker).not.toHaveBeenCalled();
    expect(scope.runModelCleanup).not.toHaveBeenCalled();
    expect(scope.rmSync).not.toHaveBeenCalled();
    expect(scope.kill).not.toHaveBeenCalled();
    expect(scope.runPortableCleanup).not.toHaveBeenCalled();
    expect(fs.existsSync(evidence)).toBe(true);
  });

  it("routes schema-5 Hermes cleanup while the portable host fence is held (#9608)", async () => {
    const scope = admissionFailureScope("nemoclaw-hermes-uninstall-");
    const sharedInferenceEvidence = path.join(
      scope.stateDir,
      "portable-inference",
      "shared-runtime",
      "portable-inference.json",
    );
    fs.mkdirSync(path.dirname(sharedInferenceEvidence), { recursive: true });
    fs.writeFileSync(sharedInferenceEvidence, "shared-authority\n", { mode: 0o600 });
    const lifecycleLockEvidence = path.join(scope.stateDir, "state", "lifecycle.lock");
    fs.mkdirSync(path.dirname(lifecycleLockEvidence), { recursive: true });
    fs.writeFileSync(lifecycleLockEvidence, "held\n", { mode: 0o600 });
    const journalEvidence = path.join(scope.stateDir, HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE);
    fs.writeFileSync(journalEvidence, '{"phase":"prepared"}\n', { mode: 0o600 });
    let hostFenceHeld = false;
    const cleanupFenceStates: boolean[] = [];
    scope.runPortableCleanup.mockImplementation(() => {
      cleanupFenceStates.push(hostFenceHeld);
      return {
        registryRemoved: false,
        sandboxContainersRemoved: 1,
        selectorsRemoved: [],
      };
    });

    const result = await runUninstallPlanProduction(
      { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: false },
      {
        ...admissionFailureDeps(scope),
        commandExists: (command) => ["openshell", "pgrep", "lsof"].includes(command),
        env: {
          HOME: scope.homeDir,
        },
        hasPortableRuntimeCleanup: () => true,
        withPortableHostFence: async (_home, operation) => {
          hostFenceHeld = true;
          try {
            return await operation();
          } finally {
            hostFenceHeld = false;
          }
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(scope.runPortableCleanup).toHaveBeenCalledOnce();
    expect(cleanupFenceStates).toEqual([true]);
    expect(fs.existsSync(sharedInferenceEvidence)).toBe(true);
    expect(fs.existsSync(lifecycleLockEvidence)).toBe(true);
    expect(fs.existsSync(journalEvidence)).toBe(true);
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
      [
        "npm",
        () => {
          order.push("cli");
          return ok();
        },
      ],
    ]);
    const run = vi.fn((command: string, args: string[]) => {
      return (
        runHandlers.get(`${command} ${args.join(" ")}`) ??
        runHandlers.get(command) ??
        (() => okWithKnownGatewayList(command, args))
      )();
    });
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
        commandExists: (command) =>
          ["openshell", "pgrep", "lsof", "docker", "npm"].includes(command),
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
    expect(order.slice(0, 3)).toEqual(["exact-sandbox", "exact-openshell", "exact-shared"]);
    expect(order.filter((entry) => entry === "cli")).toHaveLength(2);
    expect(runPortableCleanup).toHaveBeenCalledOnce();
    expect(runDocker).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
    expect(run.mock.calls.every(([command]) => ["openshell", "npm"].includes(command))).toBe(true);
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
    expect(logs.join("\n")).toContain("secret-free portable cleanup evidence");
    expect(logs.join("\n")).toContain("exact retry and lifecycle reconciliation");
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

  it("settles one failed delete only after the connected gateway proves exact absence (#9499)", () => {
    const registeredSandboxes = new Set(["unrelated"]);
    const { homeDir, sharedPaths: sharedOpenShellPaths } = sharedOpenShellFixture(
      "nemoclaw-portable-absent-",
    );
    const removed: string[] = [];
    const error = "code:'Some requested entity was not found',message:'sandbox not found'";
    const runHandlers = new Map<string, () => RunResult>([
      [
        "openshell sandbox delete -g nemoclaw alpha",
        () => ({ status: 1, stdout: "", stderr: "Error: request settlement unavailable" }),
      ],
      ["openshell sandbox get -g nemoclaw alpha", () => ({ status: 1, stdout: "", stderr: error })],
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

    expect(
      run.mock.calls.filter(
        ([command, args]) =>
          command === "openshell" && args.join(" ") === "sandbox delete -g nemoclaw alpha",
      ),
    ).toHaveLength(1);
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
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-retry-cli-"));
    temporaryDirectories.push(homeDir);
    const sourceMarker = path.join(homeDir, ".nemoclaw/source/retry-source-marker");
    fs.mkdirSync(path.dirname(sourceMarker), { recursive: true });
    fs.writeFileSync(sourceMarker, "retry\n");
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
        commandExists: (command) => ["openshell", "pgrep", "lsof", "npm"].includes(command),
        env: { HOME: homeDir } as NodeJS.ProcessEnv,
        error: (line) => errors.push(line),
        existsSync: (target) => fs.existsSync(String(target)),
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
    expect(fs.readFileSync(sourceMarker, "utf8")).toBe("retry\n");
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

  it("keeps detected portable receipts during a sibling-gateway scoped pass (#9189)", async () => {
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
      const result = await runUninstallPlanWithBackup(
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
