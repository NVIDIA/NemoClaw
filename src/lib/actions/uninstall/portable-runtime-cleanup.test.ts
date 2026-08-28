// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, assert, beforeAll, describe, expect, it, vi } from "vitest";

import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { createSession } from "../../state/onboard-session";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
import {
  hasPortableRetirementRecord,
  inspectPortableRetirementRecovery,
  preparePortableRetirement,
  publishAndRetirePortableEvidence,
} from "../../state/portable-uninstall-retirement";
import {
  supersedePortableRetirementAfterCompletedOnboard,
  withPortableOnboardRetirementBoundary,
  type PortableOnboardRetirementBoundary,
} from "../../onboard/portable-retirement-authority";
import { listPortableDemoSandboxLifecycleReceipts } from "../../onboard/experimental/portable-demo-lifecycle";
import { portableDemoReceiptPath } from "../../onboard/experimental/portable-runtime-receipt-readiness";
import {
  withProcessBoundRegistryLockAt,
  withRegistryLockAt,
  type RegistryLockDeps,
} from "../../state/registry/lock";
import {
  hasPortableRuntimeCleanup,
  runPortableRuntimeCleanupTransaction,
  type PortableRuntimeCleanupDeps,
  type PortableRuntimeCleanupInput,
} from "./portable-runtime-cleanup";

const UID = process.getuid?.() ?? 1001;
const ALPHA_ID = "a".repeat(64);
const BETA_ID = "b".repeat(64);
const REGISTRY_ID = "c".repeat(64);
const PROCESS_IDENTITY = "12345678-1234-1234-1234-123456789abc 123456";

interface ContainerRecord {
  id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
}

const temporaryDirectories: string[] = [];

const RETIREMENT_COMPETITOR_SCRIPT = String.raw`
  import fs from "node:fs";
  const [lifecycleUrl, registryUrl, stateDir, registryFile, receiptFile, marker, sandboxName, control] = process.argv.slice(1);
  const lifecycle = (await import(lifecycleUrl)).default;
  const registry = (await import(registryUrl)).default;
  const attempt = (owner) => {
  const mutate = () => {
    fs.writeFileSync(marker, "entered");
    fs.unlinkSync(receiptFile);
  };
  try {
    if (owner === "registry-only") {
      registry.withRegistryLockAt(registryFile, mutate, { maxRetries: 2, wait: () => {} });
    } else {
      lifecycle.withMcpLifecycleLockSync(owner, () => registry.withRegistryLockAt(
        registryFile,
        mutate,
        { maxRetries: 2, wait: () => {} },
      ), { stateDir, pollIntervalMs: 1, timeoutMs: 10 });
    }
    return 0;
  } catch {
    return 2;
  }
  };
  if (!control) process.exit(attempt(sandboxName));
  fs.writeFileSync(control + ".ready", "ready");
  while (!fs.existsSync(control + ".trigger")) await new Promise(resolve => setTimeout(resolve, 1));
  const resultPayload = JSON.stringify([attempt(sandboxName), attempt("registry-only")]);
  const resultTmp = control + ".result.tmp";
  fs.writeFileSync(resultTmp, resultPayload);
  fs.renameSync(resultTmp, control + ".result");
  process.exit(0);
`;

function fixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-uninstall-"));
  temporaryDirectories.push(homeDir);
  const stateDir = path.join(homeDir, ".nemoclaw");
  const registryFile = path.join(stateDir, "sandboxes.json");
  const authority: CheckpointPortableRuntimeAuthority = {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: UID,
    homeDir,
    configHome: path.join(homeDir, ".config"),
    runtimeDir: path.join("/run/user", String(UID)),
    socketPath: path.join("/run/user", String(UID), "podman", "podman.sock"),
  };
  fs.mkdirSync(path.dirname(portableDemoReceiptPath("alpha", stateDir)), {
    mode: 0o700,
    recursive: true,
  });
  const writeReceipt = (sandboxName: string, containerId: string, sandboxId: string) => {
    fs.writeFileSync(
      portableDemoReceiptPath(sandboxName, stateDir),
      `${JSON.stringify(
        {
          schemaVersion: 4,
          sandboxName,
          sandboxId,
          containerId,
          dashboardPort: sandboxName === "alpha" ? 18789 : 18790,
          registryGeneration: containerId,
          runtimeAuthority: authority,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  };
  writeReceipt("alpha", ALPHA_ID, "sandbox-alpha");
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          openshellDriver: "docker",
          lifecycleGeneration: ALPHA_ID,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  const containersConf = path.join(homeDir, ".config/nemoclaw/portable/containers.conf");
  fs.mkdirSync(path.dirname(containersConf), { mode: 0o700, recursive: true });
  fs.writeFileSync(containersConf, "[engine]\nhelper_binaries_dir=[]\n", { mode: 0o600 });
  const containers = new Map<string, ContainerRecord>();
  const addSandbox = (
    sandboxName: string,
    sandboxId: string,
    containerId: string,
    labels: Record<string, string> = {},
  ) => {
    containers.set(containerId, {
      id: containerId,
      name: `openshell-default--${sandboxName}-${sandboxId}`,
      labels: {
        "openshell.managed": "true",
        "openshell.ai/sandbox-id": sandboxId,
        "openshell.ai/sandbox-name": sandboxName,
        "openshell.ai/sandbox-namespace": "",
        "openshell.ai/sandbox-workspace": "default",
        ...labels,
      },
      running: true,
    });
  };
  addSandbox("alpha", "sandbox-alpha", ALPHA_ID);
  containers.set(REGISTRY_ID, {
    id: REGISTRY_ID,
    name: "nemoclaw-portable-registry",
    labels: { "com.nvidia.nemoclaw.portable": "1" },
    running: true,
  });
  const podmanCalls: string[][] = [];
  const podmanEnvironments: NodeJS.ProcessEnv[] = [];
  const podmanHandlers = new Map<
    string,
    (args: readonly string[]) => { status: number; stdout?: string; stderr?: string }
  >([
    [
      "ps",
      (args) => {
        const joined = args.join(" ");
        const sandbox = /openshell\.ai\/sandbox-name=([^ ]+)/u.exec(joined)?.[1];
        const matchesPortableRegistry = joined.includes("com.nvidia.nemoclaw.portable=1");
        const matches = [...containers.values()].filter((container) =>
          matchesPortableRegistry
            ? container.labels["com.nvidia.nemoclaw.portable"] === "1"
            : sandbox !== undefined && container.labels["openshell.ai/sandbox-name"] === sandbox,
        );
        return { status: 0, stdout: matches.map(({ id }) => id).join("\n") };
      },
    ],
    [
      "inspect",
      (args) => {
        const target = String(args[1]);
        const record =
          containers.get(target) ?? [...containers.values()].find(({ name }) => name === target);
        return record === undefined
          ? { status: 1, stderr: `Error: no such container ${target}` }
          : {
              status: 0,
              stdout: JSON.stringify([
                {
                  Id: record.id,
                  Name: record.name,
                  Config: { Labels: record.labels },
                  State: { Running: record.running },
                },
              ]),
            };
      },
    ],
    [
      "rm",
      (args) => {
        containers.delete(String(args[2]));
        return { status: 0 };
      },
    ],
  ]);
  const unexpectedPodmanCommand = (args: readonly string[]) => {
    throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
  };
  const podman = vi.fn((rawArgs: readonly string[], env?: NodeJS.ProcessEnv) => {
    podmanEnvironments.push({ ...(env ?? {}) });
    const args = rawArgs[0] === "--url" ? rawArgs.slice(2) : rawArgs;
    podmanCalls.push([...args]);
    return (podmanHandlers.get(String(args[0])) ?? unexpectedPodmanCommand)(args);
  });
  const selectors = new Map<string, string>([
    ["CONTAINERS_CONF", `$'${containersConf}'`],
    ["NETAVARK_FW", "iptables"],
    ["CONTAINER_HOST", "ssh://user-managed.example"],
    ["CONTAINER_CONNECTION", "user-managed"],
    ["CONTAINER_SSHKEY", "/home/test/.ssh/user-managed"],
    ["UNRELATED", "keep"],
  ]);
  const systemctlCalls: string[][] = [];
  const systemctlHandlers = new Map<
    string,
    (args: readonly string[]) => { status: number; stdout?: string }
  >([
    [
      "show-environment",
      () => ({
        status: 0,
        stdout: [...selectors].map(([name, value]) => `${name}=${value}`).join("\n"),
      }),
    ],
    [
      "unset-environment",
      (args) => {
        for (const name of args.slice(2)) selectors.delete(name);
        return { status: 0 };
      },
    ],
  ]);
  const unexpectedSystemctlCommand = (args: readonly string[]) => {
    throw new Error(`Unexpected systemctl command: ${args.join(" ")}`);
  };
  const systemctl = vi.fn((args: readonly string[]) => {
    systemctlCalls.push([...args]);
    return (systemctlHandlers.get(String(args[1])) ?? unexpectedSystemctlCommand)(args);
  });
  const input: PortableRuntimeCleanupInput = {
    env: {
      HOME: homeDir,
      CONTAINER_HOST: "tcp://ambient-attacker.invalid",
      CONTAINER_CONNECTION: "ambient-attacker",
      CONTAINER_SSHKEY: "/tmp/ambient-attacker-key",
    },
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    homeDir,
    registryFile,
    stateDir,
  };
  const deps: PortableRuntimeCleanupDeps = {
    hardenSocketDirectory: vi.fn(),
    platform: "linux",
    podman,
    systemctl,
    runtimeReadiness: {
      uid: UID,
      home: homeDir,
      systemctl: () => ({ status: 0 }),
      captureSocketAuthority: () => ({
        socketPath: authority.socketPath,
        device: "1",
        inode: "2",
        mode: String(0o660),
        ownerUid: String(UID),
        directoryChain: [],
      }),
      assertSocketAuthority: vi.fn(),
      podmanCapture: () => ({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
        stderr: "",
      }),
    },
    log: vi.fn(),
    inspectRetirement: () => null,
    prepareRetirement: preparePortableRetirement,
    publishRetirement: vi.fn(),
    withRegistryLock: (_registryFile, operation) => operation(),
  };
  return {
    addSandbox,
    authority,
    containers,
    deps,
    homeDir,
    input,
    podman,
    podmanCalls,
    podmanEnvironments,
    registryFile,
    selectors,
    stateDir,
    systemctl,
    systemctlCalls,
    writeReceipt,
  };
}

function completeCleanup(input: PortableRuntimeCleanupInput, deps: PortableRuntimeCleanupDeps) {
  return runPortableRuntimeCleanupTransaction(input, () => true, deps);
}

type PodmanObservation = ReturnType<NonNullable<PortableRuntimeCleanupDeps["podman"]>>;
type PodmanObservationResponse = PodmanObservation | (() => PodmanObservation);

function interceptSandboxDiscoveries(
  test: ReturnType<typeof fixture>,
  responses: readonly PodmanObservationResponse[],
): () => number {
  const originalPodman = test.deps.podman!;
  let observations = 0;
  test.deps.podman = vi.fn((args, env) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    const observesSandbox =
      command[0] === "ps" && command.includes("label=openshell.ai/sandbox-name=alpha");
    const response = observesSandbox ? responses[observations++] : undefined;
    return (typeof response === "function" ? response() : response) ?? originalPodman(args, env);
  });
  return () => observations;
}

function addRetirementConfig(test: ReturnType<typeof fixture>): string {
  const target = path.join(test.homeDir, ".config/nemoclaw/portable/containers.conf");
  fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
  fs.writeFileSync(target, "[engine]\nhelper_binaries_dir=[]\n", { mode: 0o600 });
  return target;
}

function authorityDeps(test: ReturnType<typeof fixture>) {
  return {
    listReceipts: listPortableDemoSandboxLifecycleReceipts,
    loadRegistry: () => JSON.parse(fs.readFileSync(test.registryFile, "utf8")),
    withLifecycleLock: async <T>(sandboxName: string, operation: () => Promise<T> | T) =>
      await withMcpLifecycleLockSync(sandboxName, operation, {
        stateDir: path.join(test.stateDir, "state"),
      }),
  };
}

function stageRetirementTarget(
  test: ReturnType<typeof fixture>,
  role: "config" | "receipt" | "registry",
): string {
  addRetirementConfig(test);
  const basename = {
    config: "containers.conf",
    receipt: path.basename(portableDemoReceiptPath("alpha", test.stateDir)),
    registry: "sandboxes.json",
  }[role];
  const unlink = fs.unlinkSync.bind(fs);
  vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
    String(target).includes(`.${basename}.portable-uninstall-`) &&
      assert.fail(`injected ${role} retirement crash`);
    unlink(target);
  });
  expect(() =>
    publishAndRetirePortableEvidence(
      preparePortableRetirement(test.homeDir, [
        path.basename(portableDemoReceiptPath("alpha", test.stateDir)),
      ]),
    ),
  ).toThrow(/injected/);
  vi.restoreAllMocks();
  const artifact = inspectPortableRetirementRecovery(test.homeDir)!.artifacts.find(
    (candidate) => candidate.root === role,
  )!;
  const directory =
    role === "config"
      ? path.join(test.homeDir, ".config/nemoclaw/portable")
      : role === "receipt"
        ? path.join(test.stateDir, "portable-demo-lifecycle")
        : test.stateDir;
  return path.join(directory, artifact.basename);
}

function completedOnboardAuthority(test: ReturnType<typeof fixture>, portable: boolean) {
  const sessionFile = path.join(test.stateDir, "onboard-session.json");
  const generation = "e".repeat(64);
  const sandboxName = "later-sandbox";
  const sessionId = "completed-after-portable-uninstall";
  const dashboardPort = 18791;
  const gateway = {
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    mode: "nemoclaw-managed" as const,
    source: "standalone" as const,
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  };
  const session = createSession({
    agent: null,
    sandboxName,
    sessionId,
    metadata: { gatewayName: gateway.gatewayName, fromDockerfile: null },
  });
  session.status = "complete";
  session.resumable = false;
  session.machine = {
    version: 1,
    state: "complete",
    stateEnteredAt: "2026-08-15T00:00:00.000Z",
    revision: 1,
  };
  session.checkpoint = {
    schemaVersion: 4,
    sessionId,
    machineState: "complete",
    updatedAt: "2026-08-15T00:00:00.000Z",
    profile: { kind: "selected", value: portable ? "portable" : "default" },
    runtimeAuthority: portable ? { kind: "selected", value: test.authority } : { kind: "unset" },
    sandboxIdentity: { kind: "selected", value: { name: sandboxName, agent: "openclaw" } },
    webSearch: { kind: "unset" },
    messaging: { kind: "unset" },
    resourceProfile: { kind: "unset" },
    gatewayAuthority: { kind: "selected", value: gateway },
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
    sandboxRecreate: null,
  };
  fs.mkdirSync(test.stateDir, { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify(session)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    test.registryFile,
    `${JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          agent: null,
          dashboardPort,
          gatewayName: gateway.gatewayName,
          gatewayPort: gateway.gatewayPort,
          lifecycleGeneration: generation,
          openshellDriver: "docker",
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  const writePortableReceipt = () => {
    const receipt = portableDemoReceiptPath(sandboxName, test.stateDir);
    fs.mkdirSync(path.dirname(receipt), { mode: 0o700, recursive: true });
    fs.writeFileSync(
      receipt,
      `${JSON.stringify({
        schemaVersion: 4,
        sandboxName,
        sandboxId: "later-sandbox-id",
        containerId: "f".repeat(64),
        dashboardPort,
        registryGeneration: generation,
        runtimeAuthority: test.authority,
      })}\n`,
      { mode: 0o600 },
    );
  };
  portable && writePortableReceipt();
  portable && addRetirementConfig(test);
  return {
    boundary: {
      homeDir: test.homeDir,
      registryFile: test.registryFile,
      sessionFile,
      stateDir: test.stateDir,
    } satisfies PortableOnboardRetirementBoundary,
    deps: authorityDeps(test),
    profile: portable ? ("portable" as const) : ("default" as const),
    sandboxName,
  };
}

function retiredOnboardAuthority(portable: boolean) {
  const test = fixture();
  addRetirementConfig(test);
  publishAndRetirePortableEvidence(
    preparePortableRetirement(test.homeDir, [
      path.basename(portableDemoReceiptPath("alpha", test.stateDir)),
    ]),
  );
  return { authority: completedOnboardAuthority(test, portable), test };
}

type ReplacementPhase = "config" | "receipt" | "registry" | "pre-complete";

function resumableReplacementAuthority(
  test: ReturnType<typeof fixture>,
  portable: boolean,
  phase: ReplacementPhase,
) {
  const authority = completedOnboardAuthority(test, portable);
  rewriteJson(authority.boundary.sessionFile, (session) => {
    const state = phase === "pre-complete" ? "failed" : "init";
    session.status = phase === "pre-complete" ? "failed" : "in_progress";
    session.resumable = true;
    session.machine.state = state;
    session.checkpoint.machineState = state;
  });
  portable &&
    phase === "config" &&
    (() => {
      fs.rmSync(path.join(test.stateDir, "portable-demo-lifecycle"), { recursive: true });
    })();
  (phase === "config" || phase === "receipt") && fs.unlinkSync(test.registryFile);
  return authority;
}

async function supersedeCompleted(
  authority: ReturnType<typeof completedOnboardAuthority>,
): Promise<void> {
  await supersedePortableRetirementAfterCompletedOnboard(
    authority.boundary,
    authority.profile,
    authority.deps,
  );
}

function rewriteJson(target: string, mutate: (value: Record<string, any>) => void): void {
  const value = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, any>;
  mutate(value);
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function afterReceiptDirectoryRead(directory: string, mutate: () => void): void {
  const readdir = fs.readdirSync.bind(fs);
  vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options?: any) => {
    const entries = readdir(target, options);
    new Map([[directory, mutate]]).get(String(target))?.();
    return entries;
  }) as typeof fs.readdirSync);
}

const receiptDirectoryMutations = {
  "link-count": (directory: string) =>
    afterReceiptDirectoryRead(directory, () =>
      fs.mkdirSync(path.join(directory, "concurrent-generation")),
    ),
  replacement: (directory: string) =>
    afterReceiptDirectoryRead(directory, () => {
      fs.renameSync(directory, `${directory}.moved`);
      fs.mkdirSync(directory, { mode: 0o700 });
    }),
  symlink: (directory: string) => {
    const moved = `${directory}.moved`;
    fs.renameSync(directory, moved);
    fs.symlinkSync(moved, directory);
  },
} as const;
const receiptDirectoryMutationNames = ["link-count", "replacement", "symlink"] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("portable runtime uninstall cleanup", () => {
  it("admits only exact completed ordinary authority to generic uninstall (#9189)", () => {
    const ordinary = fixture();
    fs.rmSync(path.join(ordinary.stateDir, "portable-demo-lifecycle"), { recursive: true });
    fs.rmSync(path.join(ordinary.homeDir, ".config/nemoclaw/portable"), { recursive: true });
    completedOnboardAuthority(ordinary, false);
    expect(hasPortableRuntimeCleanup(ordinary.stateDir)).toBe(false);
  });

  it.each([false, true])(
    "supersedes the retry record only after durable completed onboarding (portable=%s) (#9189)",
    async (portable) => {
      const { authority, test } = retiredOnboardAuthority(portable);
      const record = path.join(test.stateDir, "portable-uninstall-retirement.json");

      await supersedeCompleted(authority);

      expect(fs.existsSync(record)).toBe(false);
      expect(
        fs
          .readdirSync(test.stateDir)
          .filter((name) => name.includes("portable-uninstall-retirement")),
      ).toEqual([]);
      expect(fs.existsSync(authority.boundary.sessionFile)).toBe(true);
      expect(fs.existsSync(authority.boundary.registryFile)).toBe(true);
    },
  );

  it("skips completed authority proof when no retirement record exists (#9189)", async () => {
    const authority = completedOnboardAuthority(fixture(), false);
    const loadRegistry = vi.fn(() => authority.deps.loadRegistry());
    await supersedePortableRetirementAfterCompletedOnboard(authority.boundary, "default", {
      ...authority.deps,
      loadRegistry,
    });
    expect(loadRegistry).not.toHaveBeenCalled();
  });

  it.each(
    (
      [
        ["default", false],
        ["portable", true],
      ] as const
    ).flatMap(([profile, portable]) =>
      (["config", "receipt", "registry", "pre-complete"] as const).map(
        (phase) => [`${profile} after ${phase}`, portable, phase] as const,
      ),
    ),
  )("keeps R through %s replacement state recovery (#9189)", async (_case, portable, phase) => {
    const { test } = retiredOnboardAuthority(portable);
    const authority = resumableReplacementAuthority(test, portable, phase);
    const record = path.join(test.stateDir, "portable-uninstall-retirement.json");
    const resumed = await withPortableOnboardRetirementBoundary(
      authority.boundary,
      () => true,
      authority.deps,
    );
    expect(resumed).toBe(true);
    expect(fs.existsSync(record)).toBe(true);
    !portable && (phase === "config" || phase === "receipt")
      ? expect(hasPortableRuntimeCleanup(test.stateDir)).toBe(true)
      : expect(() => hasPortableRuntimeCleanup(test.stateDir)).toThrow();
    completedOnboardAuthority(test, portable);
    await withPortableOnboardRetirementBoundary(authority.boundary, () => {}, authority.deps);
    expect(fs.existsSync(record)).toBe(false);
  });

  it.each(["config", "receipt", "registry"] as const)(
    "retires an authenticated staged %s target before onboarding writes (#9189)",
    async (role) => {
      const test = fixture();
      const staged = stageRetirementTarget(test, role);
      const boundary = {
        homeDir: test.homeDir,
        registryFile: test.registryFile,
        sessionFile: path.join(test.stateDir, "onboard-session.json"),
        stateDir: test.stateDir,
      };
      let newAuthority: ReturnType<typeof completedOnboardAuthority> | null = null;

      await withPortableOnboardRetirementBoundary(
        boundary,
        () => {
          expect(fs.existsSync(staged)).toBe(false);
          newAuthority = completedOnboardAuthority(test, true);
        },
        authorityDeps(test),
      );

      expect(newAuthority).not.toBeNull();
      expect(fs.existsSync(test.registryFile)).toBe(true);
      expect(
        fs.existsSync(path.join(test.homeDir, ".config/nemoclaw/portable/containers.conf")),
      ).toBe(true);
      expect(listPortableDemoSandboxLifecycleReceipts(test.stateDir)).toHaveLength(1);
    },
  );

  it.each(["R+S", "RC+S", "S", "SC"] as const)(
    "continues completed-onboarding supersession from fixed %s state (#9189)",
    async (fixedState) => {
      const { authority, test } = retiredOnboardAuthority(true);
      const record = path.join(test.stateDir, "portable-uninstall-retirement.json");
      const canonicalCleanup = path.join(
        test.stateDir,
        ".portable-uninstall-retirement.canonical.cleanup",
      );
      const superseded = path.join(test.stateDir, ".portable-uninstall-retirement.superseded");
      const supersededCleanup = path.join(
        test.stateDir,
        ".portable-uninstall-retirement.superseded.cleanup",
      );
      fs.linkSync(record, superseded);
      fixedState === "RC+S" && fs.renameSync(record, canonicalCleanup);
      (fixedState === "S" || fixedState === "SC") && fs.unlinkSync(record);
      fixedState === "SC" && fs.renameSync(superseded, supersededCleanup);

      await supersedeCompleted(authority);

      expect([record, canonicalCleanup, superseded, supersededCleanup].some(fs.existsSync)).toBe(
        false,
      );
    },
  );

  describe("completed-onboarding writer exclusion", () => {
    let scope: ReturnType<typeof retiredOnboardAuthority>;
    let writer: ChildProcess;
    let control: string;
    let receipt: string;

    beforeAll(async () => {
      scope = retiredOnboardAuthority(true);
      control = path.join(scope.test.homeDir, "resident-writer");
      receipt = portableDemoReceiptPath(scope.authority.sandboxName, scope.test.stateDir);
      writer = spawn(process.execPath, [
        "--no-warnings",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        RETIREMENT_COMPETITOR_SCRIPT,
        new URL("../../state/mcp-lifecycle-lock-acquisition.ts", import.meta.url).href,
        new URL("../../state/registry/lock.ts", import.meta.url).href,
        path.join(scope.test.stateDir, "state"),
        scope.test.registryFile,
        receipt,
        path.join(scope.test.homeDir, "unused-entered"),
        scope.authority.sandboxName,
        control,
      ]);
      for (let attempt = 0; attempt < 1_000 && !fs.existsSync(`${control}.ready`); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fs.existsSync(`${control}.ready`)).toBe(true);
    });

    afterAll(() => {
      writer?.kill("SIGTERM");
    });

    it("blocks real lifecycle and registry writers through final supersession (#9189)", async () => {
      const originalLoad = scope.authority.deps.loadRegistry;
      const loadRegistry = () => {
        fs.writeFileSync(`${control}.trigger`, "trigger");
        const deadline = Date.now() + 1_000;
        while (!fs.existsSync(`${control}.result`) && Date.now() < deadline)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        expect(JSON.parse(fs.readFileSync(`${control}.result`, "utf8"))).toEqual([2, 2]);
        return originalLoad();
      };
      await supersedePortableRetirementAfterCompletedOnboard(
        scope.authority.boundary,
        scope.authority.profile,
        { ...scope.authority.deps, loadRegistry },
      );
      await new Promise<void>((resolve) =>
        writer.exitCode === null ? writer.once("exit", () => resolve()) : resolve(),
      );
      expect(writer.exitCode).toBe(0);
      expect(fs.existsSync(path.join(scope.test.homeDir, "unused-entered"))).toBe(false);
      expect(fs.existsSync(receipt)).toBe(true);
    });
  });

  it("preserves the retry record when completed onboarding authority is incomplete (#9189)", async () => {
    const { authority, test: incomplete } = retiredOnboardAuthority(true);
    fs.unlinkSync(portableDemoReceiptPath(authority.sandboxName, incomplete.stateDir));
    await expect(supersedeCompleted(authority)).rejects.toThrow(/ENOENT|missing/);
    expect(hasPortableRetirementRecord(incomplete.homeDir)).toBe(true);
  });

  it("rejects an extra portable config-root entry before supersession (#9189)", async () => {
    const scope = retiredOnboardAuthority(true);
    fs.writeFileSync(
      path.join(scope.test.homeDir, ".config/nemoclaw/portable/unexpected.conf"),
      "unexpected\n",
      { mode: 0o600 },
    );
    await expect(supersedeCompleted(scope.authority)).rejects.toThrow(/incomplete/);
    expect(hasPortableRetirementRecord(scope.test.homeDir)).toBe(true);
  });

  const setRegistryAgentDrift = (value: any) => (value.sandboxes["later-sandbox"].agent = "hermes");
  it.each([
    ["an unknown profile", "session", (value: any) => (value.checkpoint.profile.value = "unknown")],
    ["a profile mismatch", "session", (value: any) => (value.checkpoint.profile.value = "default")],
    ["a schema-old checkpoint", "session", (value: any) => (value.checkpoint.schemaVersion = 3)],
    ["a session identity drift", "session", (value: any) => (value.checkpoint.sessionId = "other")],
    ["a missing session agent", "session", (value: any) => delete value.agent],
    [
      "a sandbox identity drift",
      "session",
      (value: any) => (value.checkpoint.sandboxIdentity.value.name = "other"),
    ],
    [
      "an agent identity drift",
      "session",
      (value: any) => (value.checkpoint.sandboxIdentity.value.agent = "hermes"),
    ],
    [
      "a checkpoint gateway drift",
      "session",
      (value: any) => (value.checkpoint.gatewayAuthority.value.gatewayName = "other"),
    ],
    [
      "an incomplete registry row",
      "registry",
      (value: any) => delete value.sandboxes["later-sandbox"].openshellDriver,
    ],
    ["a registry agent identity drift", "registry", setRegistryAgentDrift],
    [
      "a registry gateway drift",
      "registry",
      (value: any) => (value.sandboxes["later-sandbox"].gatewayName = "other"),
    ],
    [
      "a schema-old receipt",
      "receipt",
      (value: any) => {
        value.schemaVersion = 3;
        delete value.runtimeAuthority;
      },
    ],
    ["a runtime authority drift", "receipt", (value: any) => (value.runtimeAuthority.uid += 1)],
    [
      "a registry generation drift",
      "receipt",
      (value: any) => (value.registryGeneration = "other"),
    ],
  ])("rejects %s before supersession (#9189)", async (_label, target, mutate) => {
    const scope = retiredOnboardAuthority(true);
    const authorityFile =
      target === "session"
        ? scope.authority.boundary.sessionFile
        : target === "registry"
          ? scope.authority.boundary.registryFile
          : portableDemoReceiptPath(scope.authority.sandboxName, scope.test.stateDir);
    rewriteJson(authorityFile, mutate);

    await expect(supersedeCompleted(scope.authority)).rejects.toThrow();
    expect(hasPortableRetirementRecord(scope.test.homeDir)).toBe(true);
  });

  it.each([
    [
      "state",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        path.join(
          scope.test.stateDir,
          `.sandboxes.json.portable-uninstall-${"f".repeat(64)}.cleanup`,
        ),
    ],
    [
      "receipt",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        portableDemoReceiptPath("unknown", scope.test.stateDir),
    ],
    [
      "receipt cleanup",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        path.join(
          scope.test.stateDir,
          `portable-demo-lifecycle/.${"f".repeat(64)}.json.portable-uninstall-${"e".repeat(64)}.cleanup`,
        ),
    ],
    [
      "receipt temporary",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        path.join(scope.test.stateDir, "portable-demo-lifecycle/.unknown.tmp"),
    ],
    [
      "receipt retiring",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        path.join(scope.test.stateDir, "portable-demo-lifecycle/.unknown.retiring"),
    ],
    [
      "configuration",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        path.join(scope.test.homeDir, ".config/nemoclaw/portable/containers.conf"),
    ],
    [
      "configuration cleanup",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        path.join(
          scope.test.homeDir,
          `.config/nemoclaw/portable/.containers.conf.portable-uninstall-${"e".repeat(64)}.cleanup`,
        ),
    ],
    [
      "configuration temporary",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        path.join(scope.test.homeDir, ".config/nemoclaw/portable/.unknown.tmp"),
    ],
    [
      "configuration retiring",
      (scope: ReturnType<typeof retiredOnboardAuthority>) =>
        path.join(scope.test.homeDir, ".config/nemoclaw/portable/.unknown.retiring"),
    ],
  ])(
    "rejects an ordinary completion with a portable %s artifact (#9189)",
    async (_label, target) => {
      const scope = retiredOnboardAuthority(false);
      const artifact = target(scope);
      fs.mkdirSync(path.dirname(artifact), { mode: 0o700, recursive: true });
      fs.writeFileSync(artifact, "{}\n", { mode: 0o600 });

      await expect(supersedeCompleted(scope.authority)).rejects.toThrow();
      expect(hasPortableRetirementRecord(scope.test.homeDir)).toBe(true);
    },
  );

  it.each(receiptDirectoryMutationNames)(
    "rejects receipt-directory %s drift (#9189)",
    async (mutation) => {
      const scope = retiredOnboardAuthority(true);
      const receiptDirectory = path.join(scope.test.stateDir, "portable-demo-lifecycle");
      receiptDirectoryMutations[mutation](receiptDirectory);

      await expect(supersedeCompleted(scope.authority)).rejects.toThrow(/changed|Unsafe|ENOTDIR/);
      expect(hasPortableRetirementRecord(scope.test.homeDir)).toBe(true);
    },
  );

  it("removes only exact receipt-owned containers and exact current selector projections (#9189)", () => {
    const test = fixture();

    expect(hasPortableRuntimeCleanup(test.stateDir)).toBe(true);
    const cleanup = completeCleanup(test.input, test.deps);

    expect(cleanup).toEqual({
      registryRemoved: true,
      sandboxContainersRemoved: 1,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });
    expect(test.containers.has(ALPHA_ID)).toBe(false);
    expect(test.containers.size).toBe(0);
    expect(test.selectors).toEqual(
      new Map([
        ["CONTAINER_HOST", "ssh://user-managed.example"],
        ["CONTAINER_CONNECTION", "user-managed"],
        ["CONTAINER_SSHKEY", "/home/test/.ssh/user-managed"],
        ["UNRELATED", "keep"],
      ]),
    );
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);
    expect(test.podmanEnvironments).not.toEqual([]);
    test.podmanEnvironments.forEach((env) => {
      expect(env.CONTAINER_HOST).toBeUndefined();
      expect(env.CONTAINER_CONNECTION).toBeUndefined();
      expect(env.CONTAINER_SSHKEY).toBeUndefined();
    });
    expect(fs.existsSync(`${test.registryFile}.lock`)).toBe(false);
  });

  it("retries one failed read-only sandbox discovery under reasserted authority (#9499)", () => {
    const test = fixture();
    const observations = interceptSandboxDiscoveries(test, [
      { status: 125, stdout: "", stderr: "transient local Podman observation failure" },
    ]);

    expect(completeCleanup(test.input, test.deps)).toEqual({
      registryRemoved: true,
      sandboxContainersRemoved: 1,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });
    expect(observations()).toBe(4);
    expect(test.containers.has(ALPHA_ID)).toBe(false);
  });

  it.each([
    ["non-125 status", { status: 126, stdout: "", stderr: "permission denied" }],
    ["spawn error", { status: null, stdout: "", stderr: "", error: new Error("spawn EACCES") }],
  ] as const)("does not retry a %s sandbox discovery failure (#9499)", (_label, failure) => {
    const test = fixture();
    const observations = interceptSandboxDiscoveries(test, [failure]);

    expect(() => completeCleanup(test.input, test.deps)).toThrow(
      "Finding portable sandbox 'alpha' failed",
    );
    expect(observations()).toBe(1);
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.containers.has(REGISTRY_ID)).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("stops a status-125 retry when socket authority changes before re-observation (#9499)", () => {
    const test = fixture();
    let authorityChanged = false;
    const authorityError = "Podman socket authority changed after it was qualified";
    const rejectChangedAuthority = () => {
      throw new Error(authorityError);
    };
    const assertSocketAuthority = vi.fn(() =>
      authorityChanged ? rejectChangedAuthority() : undefined,
    );
    test.deps.runtimeReadiness = { ...test.deps.runtimeReadiness, assertSocketAuthority };
    const observations = interceptSandboxDiscoveries(test, [
      () => {
        authorityChanged = true;
        return { status: 125, stdout: "", stderr: "transient local Podman observation failure" };
      },
    ]);

    expect(() => completeCleanup(test.input, test.deps)).toThrow(authorityError);
    expect(observations()).toBe(1);
    expect(assertSocketAuthority).toHaveBeenCalled();
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.containers.has(REGISTRY_ID)).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("stops without mutation after two failed read-only sandbox discoveries (#9499)", () => {
    const test = fixture();
    const failure = {
      status: 125,
      stdout: "",
      stderr: "persistent local Podman observation failure",
    };
    const observations = interceptSandboxDiscoveries(test, [failure, failure]);

    expect(() => completeCleanup(test.input, test.deps)).toThrow(
      "Finding portable sandbox 'alpha' failed",
    );
    expect(observations()).toBe(2);
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.containers.has(REGISTRY_ID)).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("preserves changed current-user manager selector values (#9189)", () => {
    const test = fixture();
    test.selectors.set("CONTAINERS_CONF", "/home/test/user-containers.conf");
    test.selectors.set("NETAVARK_FW", "nftables");

    expect(completeCleanup(test.input, test.deps)).toEqual({
      registryRemoved: true,
      sandboxContainersRemoved: 1,
      selectorsRemoved: [],
    });
    expect(test.selectors.get("CONTAINERS_CONF")).toBe("/home/test/user-containers.conf");
    expect(test.selectors.get("NETAVARK_FW")).toBe("nftables");
  });

  it("prevalidates every receipt before deleting the first container (#9189)", () => {
    const test = fixture();
    test.writeReceipt("beta", BETA_ID, "sandbox-beta");
    test.addSandbox("beta", "sandbox-beta", BETA_ID, { "openshell.managed": "false" });
    const registry = JSON.parse(fs.readFileSync(test.registryFile, "utf8")) as {
      sandboxes: Record<string, unknown>;
    };
    registry.sandboxes.beta = {
      name: "beta",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      lifecycleGeneration: BETA_ID,
    };
    fs.writeFileSync(test.registryFile, `${JSON.stringify(registry)}\n`);

    expect(() => completeCleanup(test.input, test.deps)).toThrow(
      /OpenShell identity does not match sandbox 'beta'/,
    );
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });

  it.each([
    [
      "missing",
      (test: ReturnType<typeof fixture>) => {
        fs.writeFileSync(
          test.registryFile,
          `${JSON.stringify({ defaultSandbox: null, sandboxes: {} })}\n`,
        );
      },
      /has no current registry ownership/,
    ],
    [
      "extra",
      (test: ReturnType<typeof fixture>) => {
        const registry = JSON.parse(fs.readFileSync(test.registryFile, "utf8")) as {
          sandboxes: Record<string, unknown>;
        };
        registry.sandboxes.beta = {
          name: "beta",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          openshellDriver: "docker",
          lifecycleGeneration: BETA_ID,
        };
        fs.writeFileSync(test.registryFile, `${JSON.stringify(registry)}\n`);
      },
      /not represented by the complete lifecycle receipt set/,
    ],
    [
      "mismatched gateway name",
      (test: ReturnType<typeof fixture>) => {
        const registry = JSON.parse(fs.readFileSync(test.registryFile, "utf8")) as {
          sandboxes: { alpha: { gatewayName: string } };
        };
        registry.sandboxes.alpha.gatewayName = "other";
        fs.writeFileSync(test.registryFile, `${JSON.stringify(registry)}\n`);
      },
      /unrecognized gatewayName/,
    ],
    [
      "mismatched gateway port",
      (test: ReturnType<typeof fixture>) => {
        const registry = JSON.parse(fs.readFileSync(test.registryFile, "utf8")) as {
          sandboxes: { alpha: { gatewayPort: number } };
        };
        registry.sandboxes.alpha.gatewayPort = 9000;
        fs.writeFileSync(test.registryFile, `${JSON.stringify(registry)}\n`);
      },
      /conflicting gateway identity/,
    ],
  ])("rejects a %s registry row before any mutation (#9189)", (_case, prepare, expected) => {
    const test = fixture();
    prepare(test);

    expect(() => completeCleanup(test.input, test.deps)).toThrow(expected);
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.containers.has(REGISTRY_ID)).toBe(true);
    expect(test.selectors.has("CONTAINERS_CONF")).toBe(true);
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("preserves shared portable evidence when exact OpenShell retirement fails (#9189)", () => {
    const test = fixture();
    const configMarker = path.join(test.homeDir, ".config", "nemoclaw", "keep-for-retry");
    fs.mkdirSync(path.dirname(configMarker), { recursive: true });
    fs.writeFileSync(configMarker, "retry\n");
    const retireOpenShell = vi.fn(() => false);

    expect(runPortableRuntimeCleanupTransaction(test.input, retireOpenShell, test.deps)).toBeNull();
    expect(retireOpenShell).toHaveBeenCalledWith(1, ["alpha"], "nemoclaw");
    expect(test.containers.has(ALPHA_ID)).toBe(false);
    expect(test.containers.has(REGISTRY_ID)).toBe(true);
    expect(test.selectors.has("CONTAINERS_CONF")).toBe(true);
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);
    expect(fs.existsSync(test.registryFile)).toBe(true);
    expect(fs.existsSync(configMarker)).toBe(true);
    expect(fs.existsSync(test.stateDir)).toBe(true);
  });

  it("holds sorted lifecycle locks before the registry lock and releases in reverse (#9189)", () => {
    const test = fixture();
    const order: string[] = [];
    test.writeReceipt("beta", BETA_ID, "sandbox-beta");
    test.addSandbox("beta", "sandbox-beta", BETA_ID);
    const registry = JSON.parse(fs.readFileSync(test.registryFile, "utf8")) as {
      sandboxes: Record<string, unknown>;
    };
    registry.sandboxes.beta = {
      name: "beta",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      lifecycleGeneration: BETA_ID,
    };
    fs.writeFileSync(test.registryFile, `${JSON.stringify(registry)}\n`);

    expect(
      runPortableRuntimeCleanupTransaction(test.input, () => true, {
        ...test.deps,
        withLifecycleLock: (sandboxName, operation) => {
          order.push(`acquire:${sandboxName}`);
          try {
            return operation();
          } finally {
            order.push(`release:${sandboxName}`);
          }
        },
        withRegistryLock: (_registryFile, operation) => {
          order.push("acquire:registry");
          try {
            return operation();
          } finally {
            order.push("release:registry");
          }
        },
      }),
    ).toMatchObject({ sandboxContainersRemoved: 2 });
    expect(order).toEqual([
      "acquire:alpha",
      "acquire:beta",
      "acquire:registry",
      "release:registry",
      "release:beta",
      "release:alpha",
    ]);
  });

  it("runs final evidence retirement while both production lock primitives are held (#9189)", () => {
    const test = fixture();
    const lifecycleStateDir = path.join(test.stateDir, "state");
    const lockDeps: RegistryLockDeps = {
      isProcessAlive: () => true,
      readProcessIdentity: () => PROCESS_IDENTITY,
    };
    let lifecycleHeld = false;
    let registryHeld = false;
    const retireEvidence = vi.fn(() => {
      expect(lifecycleHeld).toBe(true);
      expect(registryHeld).toBe(true);
      return true;
    });

    expect(
      runPortableRuntimeCleanupTransaction(test.input, () => true, {
        ...test.deps,
        publishRetirement: retireEvidence,
        withLifecycleLock: (sandboxName, operation, stateDir) =>
          withMcpLifecycleLockSync(
            sandboxName,
            () => {
              lifecycleHeld = true;
              try {
                return operation();
              } finally {
                lifecycleHeld = false;
              }
            },
            { stateDir },
          ),
        withRegistryLock: (registryFile, operation) =>
          withProcessBoundRegistryLockAt(
            registryFile,
            () => {
              registryHeld = true;
              try {
                return operation();
              } finally {
                registryHeld = false;
              }
            },
            lockDeps,
          ),
      }),
    ).toMatchObject({ sandboxContainersRemoved: 1 });
    expect(retireEvidence).toHaveBeenCalledOnce();
    expect(lifecycleHeld).toBe(false);
    expect(registryHeld).toBe(false);
    expect(fs.existsSync(path.join(lifecycleStateDir, "mcp-lifecycle-locks"))).toBe(true);
  });

  it("preserves receipts and selectors when exact container removal cannot be verified (#9189)", () => {
    const test = fixture();
    test.deps.podman = vi.fn((rawArgs: readonly string[], env?: NodeJS.ProcessEnv) => {
      const args = rawArgs[0] === "--url" ? rawArgs.slice(2) : rawArgs;
      return args[0] === "rm"
        ? { status: 1, stderr: "permission denied" }
        : test.podman(rawArgs, env);
    });

    expect(() => completeCleanup(test.input, test.deps)).toThrow(/still has/);
    expect(test.systemctlCalls.some((args) => args[1] === "unset-environment")).toBe(false);
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);
  });

  it("preserves retry evidence when managed registry removal fails (#9189)", () => {
    const test = fixture();
    const failingDeps: PortableRuntimeCleanupDeps = {
      ...test.deps,
      podman: vi.fn((rawArgs: readonly string[], env?: NodeJS.ProcessEnv) => {
        const args = rawArgs[0] === "--url" ? rawArgs.slice(2) : rawArgs;
        return args[0] === "rm" && args[2] === REGISTRY_ID
          ? { status: 1, stderr: "registry removal denied" }
          : test.podman(rawArgs, env);
      }),
    };

    expect(() => completeCleanup(test.input, failingDeps)).toThrow(
      /Removing the managed portable registry container failed: registry removal denied/,
    );
    expect(test.containers.has(REGISTRY_ID)).toBe(true);
    expect(test.systemctlCalls.some((args) => args[1] === "unset-environment")).toBe(false);
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);

    expect(completeCleanup(test.input, test.deps)).toEqual({
      registryRemoved: true,
      sandboxContainersRemoved: 0,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });
  });

  it("retries selector cleanup after the managed registry was already removed (#9189)", () => {
    const test = fixture();
    const systemctl = test.deps.systemctl!;
    const failingDeps: PortableRuntimeCleanupDeps = {
      ...test.deps,
      systemctl: vi.fn((args, env) =>
        args[1] === "unset-environment"
          ? { status: 1, stderr: "permission denied" }
          : systemctl(args, env),
      ),
    };

    expect(() => completeCleanup(test.input, failingDeps)).toThrow(
      /Clearing NemoClaw portable selectors.*permission denied/,
    );
    expect(test.containers.has(REGISTRY_ID)).toBe(false);
    expect(fs.existsSync(portableDemoReceiptPath("alpha", test.stateDir))).toBe(true);

    expect(completeCleanup(test.input, test.deps)).toEqual({
      registryRemoved: false,
      sandboxContainersRemoved: 0,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });
  });

  it("accepts an already-absent exact sandbox on retry but rejects a replaced identity (#9189)", () => {
    const retry = fixture();
    retry.containers.delete(ALPHA_ID);
    expect(completeCleanup(retry.input, retry.deps)).toEqual({
      registryRemoved: true,
      sandboxContainersRemoved: 0,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });

    const replaced = fixture();
    replaced.containers.delete(ALPHA_ID);
    replaced.addSandbox("alpha", "sandbox-replacement", BETA_ID);
    expect(() => completeCleanup(replaced.input, replaced.deps)).toThrow(
      /replaced or ambiguous container/,
    );
  });

  it("rejects duplicate containers in the sandbox label index before removal (#9189)", () => {
    const test = fixture();
    test.addSandbox("alpha", "sandbox-duplicate", BETA_ID);

    expect(() => completeCleanup(test.input, test.deps)).toThrow(/replaced or ambiguous container/);
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.containers.has(BETA_ID)).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("fails closed on malformed receipts and mismatched lifecycle generations (#9189)", () => {
    const malformed = fixture();
    fs.writeFileSync(portableDemoReceiptPath("alpha", malformed.stateDir), "{not-json\n");
    expect(() => hasPortableRuntimeCleanup(malformed.stateDir)).toThrow(/malformed/);

    const mismatch = fixture();
    const registry = JSON.parse(fs.readFileSync(mismatch.registryFile, "utf8")) as {
      sandboxes: { alpha: { lifecycleGeneration: string } };
    };
    registry.sandboxes.alpha.lifecycleGeneration = "different-generation";
    fs.writeFileSync(mismatch.registryFile, `${JSON.stringify(registry)}\n`);
    expect(() => completeCleanup(mismatch.input, mismatch.deps)).toThrow(
      /current registry ownership/,
    );
    expect(mismatch.containers.has(ALPHA_ID)).toBe(true);
  });

  it("blocks a destroy-shaped retirement until exact shared cleanup completes (#9189)", () => {
    const test = fixture();
    const receiptFile = portableDemoReceiptPath("alpha", test.stateDir);
    const configMarker = path.join(test.homeDir, ".config", "nemoclaw", "keep-for-retry");
    const lifecycleStateDir = path.join(test.stateDir, "state");
    const competitorMarker = path.join(test.homeDir, "competing-destroy-entered");
    const lifecycleUrl = new URL("../../state/mcp-lifecycle-lock-acquisition.ts", import.meta.url)
      .href;
    const registryUrl = new URL("../../state/registry/lock.ts", import.meta.url).href;
    const lockDeps: RegistryLockDeps = {
      isProcessAlive: () => true,
      readProcessIdentity: () => PROCESS_IDENTITY,
    };
    fs.mkdirSync(path.dirname(configMarker), { recursive: true });
    fs.writeFileSync(configMarker, "retry\n");
    const competingDestroy = () =>
      spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          RETIREMENT_COMPETITOR_SCRIPT,
          lifecycleUrl,
          registryUrl,
          lifecycleStateDir,
          test.registryFile,
          receiptFile,
          competitorMarker,
          "alpha",
        ],
        { encoding: "utf8" },
      );

    const cleanup = runPortableRuntimeCleanupTransaction(
      test.input,
      () => {
        expect(competingDestroy().status).toBe(2);
        return true;
      },
      {
        ...test.deps,
        publishRetirement: () => {
          expect(competingDestroy().status).toBe(2);
        },
        withLifecycleLock: (sandboxName, operation, stateDir) =>
          withMcpLifecycleLockSync(sandboxName, operation, { stateDir }),
        withRegistryLock: (registryFile, operation) =>
          withProcessBoundRegistryLockAt(registryFile, operation, lockDeps),
      },
    );

    expect(cleanup).toEqual({
      registryRemoved: true,
      sandboxContainersRemoved: 1,
      selectorsRemoved: ["CONTAINERS_CONF", "NETAVARK_FW"],
    });
    expect(fs.existsSync(competitorMarker)).toBe(false);
    expect(test.containers.has(ALPHA_ID)).toBe(false);
    expect(test.containers.has(REGISTRY_ID)).toBe(false);
    expect(test.selectors.has("CONTAINERS_CONF")).toBe(false);
    expect(test.selectors.get("CONTAINER_HOST")).toBe("ssh://user-managed.example");
    expect(fs.existsSync(receiptFile)).toBe(true);
    expect(fs.existsSync(test.registryFile)).toBe(true);
    expect(
      (JSON.parse(fs.readFileSync(test.registryFile, "utf8")) as { sandboxes: object }).sandboxes,
    ).toHaveProperty("alpha");
    expect(fs.existsSync(configMarker)).toBe(true);
    expect(fs.existsSync(`${test.registryFile}.lock`)).toBe(false);
  });

  it("fails before mutation when destroy retires ownership before lock acquisition (#9189)", () => {
    const test = fixture();
    const receiptFile = portableDemoReceiptPath("alpha", test.stateDir);
    const lifecycleLocks = path.join(test.stateDir, "test-pre-acquisition-locks");
    const configMarker = path.join(test.homeDir, ".config", "nemoclaw", "keep-for-retry");
    const lockDeps: RegistryLockDeps = {
      isProcessAlive: () => true,
      readProcessIdentity: () => PROCESS_IDENTITY,
    };
    const withLifecycleLock = <Value>(sandboxName: string, operation: () => Value): Value => {
      const lockPath = path.join(lifecycleLocks, sandboxName);
      fs.mkdirSync(lockPath, { recursive: false });
      try {
        return operation();
      } finally {
        fs.rmdirSync(lockPath);
      }
    };
    const retireOwnership = () =>
      withLifecycleLock("alpha", () =>
        withRegistryLockAt(
          test.registryFile,
          () => {
            fs.unlinkSync(receiptFile);
            fs.writeFileSync(
              test.registryFile,
              `${JSON.stringify({ defaultSandbox: null, sandboxes: {} })}\n`,
            );
          },
          lockDeps,
        ),
      );
    const acquireAfterRetirement = <Value>(sandboxName: string, operation: () => Value): Value => {
      retireOwnership();
      return withLifecycleLock(sandboxName, operation);
    };
    fs.mkdirSync(lifecycleLocks, { recursive: true });
    fs.mkdirSync(path.dirname(configMarker), { recursive: true });
    fs.writeFileSync(configMarker, "retry\n");

    expect(() =>
      runPortableRuntimeCleanupTransaction(test.input, () => true, {
        ...test.deps,
        withLifecycleLock: acquireAfterRetirement,
        withRegistryLock: (registryFile, operation) =>
          withProcessBoundRegistryLockAt(registryFile, operation, lockDeps),
      }),
    ).toThrow(/state changed while uninstall acquired its fences/);
    expect(test.containers.has(ALPHA_ID)).toBe(true);
    expect(test.containers.has(REGISTRY_ID)).toBe(true);
    expect(test.selectors.has("CONTAINERS_CONF")).toBe(true);
    expect(fs.existsSync(configMarker)).toBe(true);
    expect(test.podmanCalls.some((args) => args[0] === "rm")).toBe(false);
  });
});
