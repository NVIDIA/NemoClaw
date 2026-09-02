// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock";
import { withPortableHostFence } from "../../state/portable-uninstall-retirement";
import type { SandboxEntry } from "../../state/registry";
import { fingerprintOpenShellSandboxLiveIdentity } from "../../adapters/openshell/sandbox-identity";
import type { HermesPortableOpenShellExecutableAuthority } from "../../adapters/openshell/resolve-shared";
import type { PodmanExecutableAuthorityDeps, PodmanExecutableStat } from "../../adapters/podman";
import type { ContainerEngineCommandCapture } from "../../adapters/container-engine";
import type { HermesPortablePodmanExecutableAuthority } from "./hermes-portable-podman-authority";
import { hermesPortableContainerInternals } from "./hermes-portable-container";
import { resolveHermesPortableStartupContract } from "./hermes-portable-contract";
import {
  hermesPortableLifecycleInternals,
  prepareHermesPortableSandboxRemoval,
  recoverHermesPortableSandboxLifecycle,
  requalifyHermesPortableSandboxAuthority,
  stopHermesPortableSandboxLifecycle,
  type HermesPortableLifecycleDeps,
} from "./hermes-portable-lifecycle";
import {
  captureHermesPortablePolicySource,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  publishHermesPortableSuccessorReceipt,
  readHermesPortableLifecycleReceipt,
  readHermesPortableLifecycleReceiptForRequalification,
  type HermesPortableConfiguredReceipt,
  type HermesPortablePendingReceipt,
} from "./hermes-portable-receipt";

const SANDBOX = "alpha";
const GATEWAY = "nemoclaw";
const GENERATION = "generation-1";
const CONTAINER_ID = "a".repeat(64);
const IMAGE = "b".repeat(64);
const SANDBOX_ID = "sandbox-id-1";
const POLICY = "version: 1\nnetwork_policies: {}\n";
const LIVE = `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: Ready\n`;
const LABELS = {
  "openshell.managed": "true",
  "openshell.ai/sandbox-id": SANDBOX_ID,
  "openshell.ai/sandbox-name": SANDBOX,
  "openshell.ai/sandbox-namespace": "",
  "openshell.ai/sandbox-workspace": "default",
};

function sandboxListJson(sandboxId: string, phase: string): string {
  return JSON.stringify([
    {
      id: sandboxId,
      name: SANDBOX,
      labels: {},
      resource_version: 1,
      created_at: "2026-01-01T00:00:00Z",
      phase,
      current_policy_version: 1,
    },
  ]);
}

let stateDir: string;
let policyPath: string;

function startupArgv() {
  return [
    "env",
    "NEMOCLAW_HERMES_API_PORT=8642",
    `NEMOCLAW_SANDBOX_NAME=${SANDBOX}`,
    "/usr/local/bin/nemoclaw-start",
  ];
}

function poisonUnexpectedCommand(scope: string, args: readonly string[]): never {
  throw new Error(`unexpected ${scope} command: ${args.join(" ")}`);
}

function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

function openshellExecutableAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.106",
    executable: {
      executablePath: "/usr/bin/openshell",
      device: "1",
      inode: "10",
      mode: String(0o100755),
      ownerUid: "0",
      size: "1024",
      modifiedTimeNanoseconds: "11",
      changedTimeNanoseconds: "12",
      sha256: "f".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 20),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function podmanExecutableAuthority(): HermesPortablePodmanExecutableAuthority {
  const bytes = Buffer.from("podman-5.7.0-test", "utf8");
  return {
    version: "5.7.0",
    executable: {
      executablePath: "/usr/bin/podman",
      device: "1",
      inode: "30",
      mode: String(0o100755),
      ownerUid: "0",
      size: String(bytes.byteLength),
      modifiedTimeNanoseconds: "31",
      changedTimeNanoseconds: "32",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 40),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function podmanExecutableAuthorityDeps(): PodmanExecutableAuthorityDeps {
  const bytes = Buffer.from("podman-5.7.0-test", "utf8");
  const stat = (filePath: string): PodmanExecutableStat => ({
    dev: 1n,
    ino:
      filePath === "/usr/bin/podman"
        ? 30n
        : filePath === "/usr/bin"
          ? 40n
          : filePath === "/usr"
            ? 41n
            : 42n,
    mode: filePath === "/usr/bin/podman" ? 0o100755n : 0o40755n,
    uid: 0n,
    size: filePath === "/usr/bin/podman" ? BigInt(bytes.byteLength) : 0n,
    mtimeNs: 31n,
    ctimeNs: 32n,
    isDirectory: () => filePath !== "/usr/bin/podman",
    isFile: () => filePath === "/usr/bin/podman",
    isSymbolicLink: () => false,
  });
  return {
    uid: process.getuid!(),
    lstat: stat,
    readFile: () => bytes,
    realpath: (filePath) => filePath,
  };
}

function activeReceipt(homeDir = "/home/test"): HermesPortableConfiguredReceipt {
  const uid = process.getuid!();
  const socketPath = `/run/user/${String(uid)}/podman/podman.sock`;
  const transactionId = randomUUID();
  const policy = publishHermesPortableDurablePolicySource({
    sandboxName: SANDBOX,
    transactionId,
    stateDir,
    source: captureHermesPortablePolicySource(policyPath),
    hooks: { assertLifecycleLock: () => undefined },
  });
  const pending: HermesPortablePendingReceipt = {
    schemaVersion: 7,
    agent: "hermes",
    phase: "pending",
    transactionId,
    createIntentSha256: "c".repeat(64),
    sandboxName: SANDBOX,
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    runtimeAuthority: {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid,
      homeDir,
      configHome: path.join(homeDir, ".config"),
      runtimeDir: `/run/user/${String(uid)}`,
      socketPath,
    },
    openshellExecutableAuthority: openshellExecutableAuthority(),
    podmanExecutableAuthority: podmanExecutableAuthority(),
    socketAuthority: {
      device: "1",
      inode: "2",
      mode: String(0o140600),
      ownerUid: String(uid),
      socketPath,
      directoryChain: directoryChain(path.dirname(socketPath)).map((directory, index) => ({
        device: "1",
        inode: String(index + 3),
        mode: String(index === 0 ? 0o40700 : 0o40755),
        ownerUid: String(index === 0 ? uid : 0),
        path: directory,
      })),
    },
    startup: resolveHermesPortableStartupContract({
      agent: loadAgent("hermes"),
      sandboxName: SANDBOX,
      startupArgv: startupArgv(),
    }),
    policy,
  };
  const first = publishHermesPortableLifecycleReceipt(pending, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  const { policy: _policy, ...transaction } = pending;
  const configuring: HermesPortableConfiguredReceipt = {
    ...transaction,
    phase: "configuring",
    previousPhaseSha256: first.sha256,
    container: {
      containerId: CONTAINER_ID,
      sandboxId: SANDBOX_ID,
      imageId: `sha256:${IMAGE}`,
      labelsSha256: hermesPortableContainerInternals.labelsDigest(LABELS),
      name: `openshell-default--${SANDBOX}-${SANDBOX_ID}`,
      running: true,
      restartPolicy: "no",
    },
  };
  const second = publishHermesPortableLifecycleReceipt(configuring, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  const active: HermesPortableConfiguredReceipt = {
    ...configuring,
    phase: "active",
    previousPhaseSha256: second.sha256,
    container: { ...configuring.container, restartPolicy: "unless-stopped" },
  };
  publishHermesPortableLifecycleReceipt(active, stateDir, {
    assertLifecycleLock: () => undefined,
  });
  return active;
}

function lifecycleDeps(
  receipt: HermesPortableConfiguredReceipt,
  initiallyRunning = true,
  options: {
    readonly livePolicy?: string;
    readonly registry?: Partial<SandboxEntry>;
    readonly sandboxPhase?: (running: boolean) => string;
    readonly failPostStartInspectOnce?: boolean;
  } = {},
) {
  let running = initiallyRunning;
  let postStartInspectFailurePending = false;
  const sandboxPhase = () => options.sandboxPhase?.(running) ?? (running ? "Ready" : "Error");
  const podman = vi.fn((args: readonly string[]) => {
    const actions = {
      inspect: () => {
        const failThisInspection = postStartInspectFailurePending;
        postStartInspectFailurePending = false;
        return failThisInspection
          ? { status: 1, stdout: "", stderr: "post-start inspection failed" }
          : {
              status: 0,
              stdout: JSON.stringify([
                {
                  Id: CONTAINER_ID,
                  Image: IMAGE,
                  Name: receipt.container.name,
                  Config: { Labels: LABELS },
                  State: {
                    Running: running,
                    Paused: false,
                    Status: running ? "running" : "exited",
                  },
                  HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
                },
              ]),
              stderr: "",
            };
      },
      exec: () => ({ status: 0, stdout: "200\n", stderr: "" }),
      start: () => {
        running = true;
        postStartInspectFailurePending = options.failPostStartInspectOnce === true;
        return { status: 0, stdout: "", stderr: "" };
      },
      stop: () => {
        running = false;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const action = actions[args[1] as keyof typeof actions];
    return action?.() ?? poisonUnexpectedCommand("podman", args);
  });
  const liveIdentityFingerprint = fingerprintOpenShellSandboxLiveIdentity(LIVE)!;
  const captureOpenShell = vi.fn((args: readonly string[]) => {
    const sandboxExecOutput = args.includes("python3") ? "200\n" : "";
    const responses = {
      "policy:get": { status: 0, stdout: options.livePolicy ?? POLICY, stderr: "" },
      "sandbox:list": {
        status: 0,
        stdout: sandboxListJson(SANDBOX_ID, sandboxPhase()),
        stderr: "",
      },
      "sandbox:get": {
        status: 0,
        stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${sandboxPhase()}\n`,
        stderr: "",
      },
      "sandbox:exec": { status: 0, stdout: sandboxExecOutput, stderr: "" },
    };
    return (
      responses[args.slice(0, 2).join(":") as keyof typeof responses] ??
      poisonUnexpectedCommand("OpenShell", args)
    );
  });
  const launchOpenShell = vi.fn();
  const captureSocketAuthority = vi.fn(() => ({ ...receipt.socketAuthority, inode: "102" }));
  const captureOpenShellExecutableAuthority = vi.fn(() => receipt.openshellExecutableAuthority);
  const capturePodmanExecutableAuthority = vi.fn(() => receipt.podmanExecutableAuthority);
  const assertOpenShellExecutableFileAuthority = vi.fn(
    () => receipt.openshellExecutableAuthority.executable.executablePath,
  );
  const capturePodmanExecutableFileAuthority = vi.fn(() => receipt.podmanExecutableAuthority);
  return {
    deps: {
      stateDir,
      env: {
        HOME: receipt.runtimeAuthority.homeDir,
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
        XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
      },
      readRegistry: () =>
        ({
          name: SANDBOX,
          agent: "hermes",
          openshellDriver: "docker",
          gatewayName: GATEWAY,
          lifecycleGeneration: GENERATION,
          lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
          openshellVersion: "0.0.106",
          ...options.registry,
        }) as SandboxEntry,
      captureOpenShell,
      launchOpenShell,
      assertOpenShellExecutableAuthority: vi.fn(() => "/usr/bin/openshell"),
      operatingAuthority: {
        env: {
          HOME: receipt.runtimeAuthority.homeDir,
          PATH: "/usr/bin",
          XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
          XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
        },
        captureSocketAuthority,
        captureOpenShellExecutableAuthority,
        capturePodmanExecutableAuthority,
        assertOpenShellExecutableFileAuthority,
        capturePodmanExecutableFileAuthority,
      },
      container: { podman, assertSocketAuthority: vi.fn() },
      sleep: vi.fn(),
    },
    podman,
    captureOpenShell,
    launchOpenShell,
    captureSocketAuthority,
    captureOpenShellExecutableAuthority,
    capturePodmanExecutableAuthority,
    assertOpenShellExecutableFileAuthority,
    capturePodmanExecutableFileAuthority,
  };
}

function publishSuccessor(): void {
  withMcpLifecycleLockSync(
    SANDBOX,
    () => publishHermesPortableSuccessorReceipt(SANDBOX, stateDir),
    { stateDir: path.join(stateDir, "state") },
  );
}

function lifecycleContext() {
  return {
    agent: "hermes",
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    openshellDriver: "docker",
    provider: "ollama",
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-lifecycle-"));
  policyPath = path.join(stateDir, "policy.yaml");
  fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("Hermes portable lifecycle", () => {
  it("uses one entry and final qualification when the timing callback fails (#10423)", () => {
    const receipt = activeReceipt();
    publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const evidence = vi.fn(() => {
      throw new Error("timing sink unavailable");
    });
    let timingNow = 0;

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () =>
        recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
          ...fixture.deps,
          recoveryTiming: {
            now: () => (timingNow += 1),
            onComplete: evidence,
          },
        }),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(evidence).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationCount: 2,
        containerStartCount: 1,
        execReadyAttempts: 1,
        authenticatedHealthCount: 1,
        startupLaunchCount: 1,
        rollbackCount: 0,
        containerAction: "started",
        result: "recovered",
      }),
    );
    const operations = fixture.captureOpenShell.mock.calls.map(([args]) =>
      args.slice(0, 2).join(":"),
    );
    expect(operations.filter((operation) => operation === "sandbox:list")).toHaveLength(3);
    expect(operations.filter((operation) => operation === "sandbox:get")).toHaveLength(3);
    expect(operations.filter((operation) => operation === "policy:get")).toHaveLength(3);
    expect(fixture.podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1);
    expect(fixture.podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(0);
    expect(fixture.assertOpenShellExecutableFileAuthority).toHaveBeenCalled();
    expect(fixture.capturePodmanExecutableFileAuthority).toHaveBeenCalled();
  });

  it("emits failed timing when entry qualification rejects socket authority (#10423)", () => {
    const receipt = activeReceipt();
    publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const entryError = new Error("socket authority changed during entry qualification");
    const evidence = vi.fn();
    fixture.captureSocketAuthority.mockImplementation(() => {
      throw entryError;
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...fixture.deps,
            recoveryTiming: { onComplete: evidence },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow(entryError);
    expect(fixture.podman.mock.calls.some(([args]) => args[1] === "start")).toBe(false);
    expect(evidence).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationCount: 1,
        containerStartCount: 0,
        result: "failed",
      }),
    );
  });

  it("fails before post-start work when retained socket authority drifts (#10423)", () => {
    const receipt = activeReceipt();
    publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const stableCapture = fixture.captureSocketAuthority.getMockImplementation()!;
    fixture.captureSocketAuthority.mockImplementation(() => {
      const socket = stableCapture();
      const started = fixture.podman.mock.calls.some(([args]) => args[1] === "start");
      return started ? { ...socket, inode: "changed-after-start" } : socket;
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), fixture.deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow(
      "Hermes portable lifecycle recovery failed and exact container rollback was not proven",
    );
    expect(fixture.captureOpenShell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["true"]),
      expect.any(Number),
    );
    expect(fixture.podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(0);
  });

  it("records polling failure and proves exact stopped rollback under retained authority (#10423)", () => {
    const receipt = activeReceipt();
    publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const defaultCapture = fixture.captureOpenShell.getMockImplementation()!;
    fixture.captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes("python3")
        ? { status: 0, stdout: "unavailable\n", stderr: "" }
        : defaultCapture(args),
    );
    const evidence = vi.fn();
    let now = 0;

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...fixture.deps,
            now: () => now,
            sleep: (milliseconds) => {
              now += milliseconds;
            },
            recoveryTiming: { now: () => now, onComplete: evidence },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("managed startup did not pass authenticated health");
    expect(fixture.podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
    expect(evidence).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationCount: 2,
        containerStartCount: 1,
        startupLaunchCount: 1,
        rollbackCount: 1,
        containerAction: "started",
        result: "failed",
      }),
    );
    expect(evidence.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ authenticatedHealthSleepMs: 90_000 }),
    );
  });

  it("rejects live sandbox rebind before the name-addressed startup launch (#10423)", () => {
    const receipt = activeReceipt();
    publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const defaultCapture = fixture.captureOpenShell.getMockImplementation()!;
    fixture.captureOpenShell
      .mockImplementationOnce(defaultCapture)
      .mockImplementationOnce(defaultCapture)
      .mockImplementationOnce(defaultCapture)
      .mockImplementationOnce(defaultCapture)
      .mockImplementationOnce(defaultCapture)
      .mockImplementationOnce(defaultCapture)
      .mockReturnValueOnce({
        status: 0,
        stdout: sandboxListJson("rebound-sandbox-id", "Ready"),
        stderr: "",
      })
      .mockImplementation(defaultCapture);

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), fixture.deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees with the receipt container");

    expect(fixture.launchOpenShell).not.toHaveBeenCalled();
    expect(fixture.podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1);
    expect(fixture.podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("rolls back when the final full qualification detects registry drift (#10423)", () => {
    const receipt = activeReceipt();
    publishSuccessor();
    const fixture = lifecycleDeps(receipt, false);
    const stableReadRegistry: NonNullable<HermesPortableLifecycleDeps["readRegistry"]> =
      fixture.deps.readRegistry!;
    let registryReads = 0;

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...fixture.deps,
            readRegistry: (sandboxName) => {
              registryReads += 1;
              const entry = stableReadRegistry(sandboxName);
              return registryReads === 2 && entry
                ? { ...entry, lifecycleGeneration: "f".repeat(64) }
                : entry;
            },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("registry authority disagrees with the active receipt");
    expect(fixture.podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1);
    expect(fixture.podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
    expect(registryReads).toBe(3);
  });

  it("reconciles an interrupted schema-8 publication inside both probe fences (#10423)", async () => {
    const receipt = activeReceipt(stateDir);
    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          publishHermesPortableSuccessorReceipt(SANDBOX, stateDir, {
            afterCanonicalLink: () => {
              throw new Error("simulated schema-8 process exit");
            },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("simulated schema-8 process exit");
    const fixture = lifecycleDeps(receipt);

    const recovered = await withPortableHostFence(stateDir, () =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => requalifyHermesPortableSandboxAuthority(SANDBOX, lifecycleContext(), fixture.deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    );

    expect(recovered.kind).toBe("already-current");
    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)?.successor).toBeDefined();
  });

  it("rejects successor-publication generation drift between lifecycle snapshots (#10423)", async () => {
    const receipt = activeReceipt(stateDir);
    const fixture = lifecycleDeps(receipt);

    await withPortableHostFence(stateDir, () =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => {
          const expected = readHermesPortableLifecycleReceiptForRequalification(SANDBOX, stateDir)!;
          expect(() =>
            publishHermesPortableSuccessorReceipt(SANDBOX, stateDir, {
              afterCanonicalLink: () => {
                throw new Error("simulated schema-8 process exit");
              },
            }),
          ).toThrow("simulated schema-8 process exit");

          expect(() =>
            hermesPortableLifecycleInternals.qualify(
              SANDBOX,
              lifecycleContext(),
              fixture.deps,
              expected,
              ["Ready", "Error", "Stopped"],
              { permitSchema5Requalification: true },
            ),
          ).toThrow("receipt authority changed");
        },
        { stateDir: path.join(stateDir, "state") },
      ),
    );
  });

  it("constructs production Podman dependencies from the receipt identity (#9203)", () => {
    const receipt = activeReceipt();
    const capture = vi.fn<ContainerEngineCommandCapture>(
      (_executable, args, _timeoutMs, _input, environment) => {
        expect(environment).toEqual({
          HOME: receipt.runtimeAuthority.homeDir,
          XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
          XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
        });
        const operation = args.includes("version")
          ? "version"
          : args.includes("info")
            ? "info"
            : "business";
        const responses = {
          version: {
            status: 0,
            stdout: JSON.stringify({
              Client: { Version: "5.7.0" },
              Server: { Version: "5.7.0" },
            }),
            stderr: "",
          },
          info: {
            status: 0,
            stdout: JSON.stringify({
              host: {
                arch: "amd64",
                os: "linux",
                cgroupVersion: "v2",
                networkBackend: "netavark",
                security: { rootless: true },
                idMappings: {
                  uidmap: [
                    { container_id: 0, host_id: receipt.runtimeAuthority.uid, size: 1 },
                    { container_id: 1, host_id: 100000, size: 65536 },
                  ],
                  gidmap: [
                    { container_id: 0, host_id: receipt.runtimeAuthority.uid, size: 1 },
                    { container_id: 1, host_id: 100000, size: 65536 },
                  ],
                },
              },
            }),
            stderr: "",
          },
          business: { status: 0, stdout: "exact container", stderr: "" },
        } as const;
        return responses[operation];
      },
    );
    const container = hermesPortableLifecycleInternals.createContainerDeps(
      receipt,
      {
        HOME: receipt.runtimeAuthority.homeDir,
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: receipt.runtimeAuthority.configHome,
        XDG_RUNTIME_DIR: receipt.runtimeAuthority.runtimeDir,
      },
      {
        capture,
        executableAuthorityDeps: podmanExecutableAuthorityDeps(),
        assertSocketAuthority: vi.fn(),
        resolveExecutablePath: () => receipt.podmanExecutableAuthority.executable.executablePath,
        platform: "linux",
        architecture: "x64",
        uid: receipt.runtimeAuthority.uid,
      },
    );

    expect(container.podman(["container", "inspect", CONTAINER_ID], 5_000)).toMatchObject({
      status: 0,
      stdout: "exact container",
    });
    expect(capture).toHaveBeenLastCalledWith(
      receipt.podmanExecutableAuthority.executable.executablePath,
      [
        "--url",
        `unix://${receipt.socketAuthority.socketPath}`,
        "container",
        "inspect",
        CONTAINER_ID,
      ],
      5_000,
      undefined,
      expect.any(Object),
    );
  });

  it("starts the exact stopped Podman container from the OpenShell Error phase and proves authenticated health (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(podman.mock.calls.some(([args]) => args[1] === "start")).toBe(true);
    expect(podman.mock.calls.every(([args]) => !String(args[0]).includes("docker"))).toBe(true);
    expect(captureOpenShell).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "-g",
        GATEWAY,
        "--name",
        SANDBOX,
        "--no-tty",
        "--",
        "python3",
        "-c",
        hermesPortableContainerInternals.authenticatedHealthScript,
      ],
      40_000,
    );
  });

  it("starts through the exact OpenShell Stopped phase before proving Ready health (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    let listObservations = 0;
    const observeList = () => {
      listObservations += 1;
      return {
        status: 0,
        stdout: sandboxListJson(SANDBOX_ID, listObservations <= 2 ? "Stopped" : "Ready"),
        stderr: "",
      };
    };
    captureOpenShell.mockImplementation((args: readonly string[]) => {
      const operation = args.slice(0, 2).join(":");
      return operation === "sandbox:list"
        ? observeList()
        : operation === "sandbox:get"
          ? {
              status: 0,
              stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${listObservations <= 2 ? "Stopped" : "Ready"}\n`,
              stderr: "",
            }
          : defaultCapture(args);
    });

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(listObservations).toBeGreaterThanOrEqual(3);
    expect(podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1);
  });

  it("uses only the receipt-owned startup after restarting a stopped container (#9211)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    let healthAttempts = 0;
    let now = 0;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes("python3")
        ? {
            status: 0,
            stdout:
              (healthAttempts += 1) >= 2 && launchOpenShell.mock.calls.length === 1
                ? "200\n"
                : "unavailable\n",
            stderr: "",
          }
        : defaultCapture(args),
    );

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () =>
        recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
          ...deps,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        }),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(healthAttempts).toBe(2);
    expect(launchOpenShell).toHaveBeenCalledTimes(1);
    expect(podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1); expect(launchOpenShell).toHaveBeenCalledWith([
      "sandbox",
      "exec",
      "-g",
      GATEWAY,
      "--name",
      SANDBOX,
      "--no-tty",
      "--",
      ...receipt.startup.argv,
    ]);
    const execCommands = captureOpenShell.mock.calls
      .map(([args]) => args)
      .filter((args) => args.slice(0, 2).join(":") === "sandbox:exec")
      .map((args) => args.slice(args.indexOf("--") + 1));
    expect(execCommands).toEqual([
      ["true"],
      ...Array.from({ length: 2 }, () => [
        "python3",
        "-c",
        hermesPortableContainerInternals.authenticatedHealthScript,
      ]),
    ]);
  });

  it("launches the receipt-owned startup once before rolling back unavailable health (#9211)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    let now = 0;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes("python3")
        ? { status: 0, stdout: "unavailable\n", stderr: "" }
        : defaultCapture(args),
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...deps,
            now: () => now,
            sleep: (milliseconds) => {
              now += milliseconds;
            },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("managed startup did not pass authenticated health");
    expect(now).toBe(90_000);
    expect(launchOpenShell).toHaveBeenCalledTimes(1);
    const execCommands = captureOpenShell.mock.calls
      .map(([args]) => args)
      .filter((args) => args.slice(0, 2).join(":") === "sandbox:exec")
      .map((args) => args.slice(args.indexOf("--") + 1));
    expect(execCommands[0]).toEqual(["true"]);
    expect(
      execCommands
        .slice(1)
        .every(
          (command) =>
            command.length === 3 &&
            command[0] === "python3" &&
            command[1] === "-c" &&
            command[2] === hermesPortableContainerInternals.authenticatedHealthScript,
        ),
    ).toBe(true);
    expect(execCommands.flat()).not.toContain(receipt.startup.argv.at(-1));
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("rolls back without a second launch when the startup handoff throws (#9211)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes("python3")
        ? { status: 0, stdout: "unavailable\n", stderr: "" }
        : defaultCapture(args),
    );
    launchOpenShell.mockImplementation(() => {
      throw new Error("startup handoff failed");
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("startup handoff failed");
    expect(launchOpenShell).toHaveBeenCalledTimes(1);
    expect(podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1);
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("rejects authority drift after exec readiness without launching startup (#9211)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    const stableReadRegistry: NonNullable<HermesPortableLifecycleDeps["readRegistry"]> =
      deps.readRegistry!;
    let execReady = false;
    let driftPending = true;
    captureOpenShell.mockImplementation((args: readonly string[]) => {
      execReady ||= args.at(-1) === "true";
      return defaultCapture(args);
    });
    const driftLifecycleGeneration = (entry: SandboxEntry): SandboxEntry => {
      driftPending = false;
      return { ...entry, lifecycleGeneration: "f".repeat(64) };
    };
    const driftedDeps = {
      ...deps,
      readRegistry: (_sandboxName: string) => {
        const entry = stableReadRegistry(_sandboxName);
        return entry && execReady && driftPending ? driftLifecycleGeneration(entry) : entry;
      },
    };

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), driftedDeps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("registry authority disagrees with the active receipt");
    expect(launchOpenShell).not.toHaveBeenCalled();
    expect(podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1);
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("rolls back its exact container when OpenShell does not reconnect (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    let now = 0;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.at(-1) === "true"
        ? { status: 1, stdout: "", stderr: "unavailable" }
        : defaultCapture(args),
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...deps,
            now: () => now,
            sleep: (milliseconds) => {
              now += milliseconds;
            },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("did not reconnect to the selected OpenShell gateway");
    expect(now).toBe(90_000);
    expect(podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1);
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("reconciles and rolls back a start whose post-start inspection fails (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false, {
      failPostStartInspectOnce: true,
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("exact inspect failed with status 1");
    expect(podman.mock.calls.filter(([args]) => args[1] === "start")).toHaveLength(1);
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("does not stop an already-running container after a health failure (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell, launchOpenShell } = lifecycleDeps(receipt);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    let now = 0;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.includes("python3")
        ? { status: 0, stdout: "unavailable\n", stderr: "" }
        : defaultCapture(args),
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), {
            ...deps,
            now: () => now,
            sleep: (milliseconds) => {
              now += milliseconds;
            },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("managed startup did not pass authenticated health");
    expect(launchOpenShell).not.toHaveBeenCalled();
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("recovers against the current live OpenShell policy (#9211)", () => {
    const receipt = activeReceipt();
    const registry = {} satisfies Partial<SandboxEntry>;
    const livePolicy = POLICY;
    const { deps, podman } = lifecycleDeps(receipt, false, { livePolicy, registry });

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(podman.mock.calls.some(([args]) => args[1] === "start")).toBe(true);
  });

  it("uses structured list phase when sandbox get omits phase (#9211)", () => {
    const receipt = activeReceipt();
    const { deps, captureOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.slice(0, 2).join(":") === "sandbox:get"
        ? {
            status: 0,
            stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\n`,
            stderr: "",
          }
        : defaultCapture(args),
    );

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "recovered" });
    expect(captureOpenShell).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", GATEWAY, "-o", "json"],
      5_000,
    );
  });

  it("accepts a valid host-edited policy without a finalized policy receipt (#9211)", () => {
    const receipt = activeReceipt();
    const finalized = {
      name: SANDBOX,
      agent: "hermes",
    } as SandboxEntry;
    const livePolicy = POLICY;
    const { deps, podman } = lifecycleDeps(receipt, false, {
      livePolicy,
      registry: { ...finalized },
    });

    expect(
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toEqual({ kind: "recovered" });
    expect(podman).toHaveBeenCalled();
  });

  it("rejects an ambient OpenShell endpoint before Podman or OpenShell effects (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);
    const endpointDeps = {
      ...deps,
      env: { OPENSHELL_GATEWAY_ENDPOINT: "https://ambient.example" },
    };

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), endpointDeps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OPENSHELL_GATEWAY_ENDPOINT is set");
    expect(podman).not.toHaveBeenCalled();
    expect(captureOpenShell).not.toHaveBeenCalled();
  });

  it("proves the exact stopped Podman container and OpenShell Error phase after stopping one full ID (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt);

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([
      [["container", "stop", CONTAINER_ID], 40_000],
    ]);
    expect(captureOpenShell).toHaveReturnedWith({
      status: 0,
      stdout: sandboxListJson(SANDBOX_ID, "Error"),
      stderr: "",
    });
  });

  it("accepts the exact already-stopped Podman container and OpenShell Error phase without another stop (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false);

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "already-stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("accepts the exact already-stopped Podman container and OpenShell Stopped phase (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false, {
      sandboxPhase: () => "Stopped",
    });

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "already-stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("rejects OpenShell Stopped while the receipt-owned container is running (#9203)", () => {
    const receipt = activeReceipt();
    const beforeStop = vi.fn();
    const { deps, podman } = lifecycleDeps(receipt, true, {
      sandboxPhase: () => "Stopped",
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), beforeStop, deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell Stopped phase disagrees with the running receipt container");
    expect(beforeStop).not.toHaveBeenCalled();
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("rejects an already-stopped container when OpenShell remains Ready (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt, false);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.slice(0, 2).join(":") === "sandbox:list"
        ? { status: 0, stdout: sandboxListJson(SANDBOX_ID, "Ready"), stderr: "" }
        : defaultCapture(args),
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("rejects a stopped container when OpenShell remains Ready (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman, captureOpenShell } = lifecycleDeps(receipt);
    const defaultCapture = captureOpenShell.getMockImplementation()!;
    captureOpenShell.mockImplementation((args: readonly string[]) =>
      args.slice(0, 2).join(":") === "sandbox:list"
        ? { status: 0, stdout: sandboxListJson(SANDBOX_ID, "Ready"), stderr: "" }
        : defaultCapture(args),
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toHaveLength(1);
  });

  it("reconciles a receipt-owned stopping state without another stop command (#9203)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt, false);
    let inspectionCount = 0;
    podman.mockImplementation((args: readonly string[]) => {
      inspectionCount += args[1] === "inspect" ? 1 : 0;
      const status = inspectionCount < 4 ? "stopping" : "exited";
      return args[1] === "inspect"
        ? {
            status: 0,
            stdout: JSON.stringify([
              {
                Id: CONTAINER_ID,
                Image: IMAGE,
                Name: receipt.container.name,
                Config: { Labels: LABELS },
                State: { Running: false, Paused: false, Status: status },
                HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
              },
            ]),
            stderr: "",
          }
        : poisonUnexpectedCommand("podman", args);
    });
    let now = 0;

    const result = withMcpLifecycleLockSync(
      SANDBOX,
      () =>
        stopHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), vi.fn(), {
          ...deps,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        }),
      { stateDir: path.join(stateDir, "state") },
    );

    expect(result).toEqual({ kind: "stopped" });
    expect(podman.mock.calls.filter(([args]) => args[1] === "stop")).toEqual([]);
  });

  it("fails closed when OpenShell same-name identity changes (#9203)", () => {
    const receipt = activeReceipt();
    const { deps } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) =>
      args[0] === "policy"
        ? { status: 0, stdout: POLICY, stderr: "" }
        : args[1] === "list"
          ? { status: 0, stdout: sandboxListJson("replacement", "Ready"), stderr: "" }
          : {
              status: 0,
              stdout: `Name: ${SANDBOX}\nID: replacement\n`,
              stderr: "",
            },
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
  });

  it("fails closed when the exact OpenShell sandbox is no longer Ready (#9608)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) =>
      args[0] === "policy"
        ? { status: 0, stdout: POLICY, stderr: "" }
        : args[1] === "list"
          ? { status: 0, stdout: sandboxListJson(SANDBOX_ID, "Creating"), stderr: "" }
          : {
              status: 0,
              stdout: `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\n`,
              stderr: "",
            },
    );

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () => recoverHermesPortableSandboxLifecycle(SANDBOX, lifecycleContext(), deps),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("OpenShell sandbox identity disagrees");
    expect(podman).not.toHaveBeenCalled();
  });

  it.each(["Ready", "Stopped", "Error"] as const)(
    "removes one exact %s sandbox and rejects a same-name replacement on retry (#9608)",
    (phase) => {
      const receipt = activeReceipt();
      const { deps, podman } = lifecycleDeps(receipt, phase === "Ready");
      const originalPodman = podman.getMockImplementation()!;
      let sandboxPresent = true;
      let containerPresent = true;
      let replacement = false;
      const live = `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${phase}\n`;
      podman.mockImplementation((args: readonly string[]) => {
        switch (args[0]) {
          case "container":
            return args[1] === "inspect" && !containerPresent
              ? { status: 125, stdout: "", stderr: "no such container" }
              : originalPodman(args);
          case "ps":
            return { status: 0, stdout: containerPresent ? `${CONTAINER_ID}\n` : "", stderr: "" };
          default:
            return originalPodman(args);
        }
      });
      deps.captureOpenShell = vi.fn((args: readonly string[]) => {
        const command = args.slice(0, 2).join(":");
        switch (command) {
          case "policy:get":
            return { status: 0, stdout: POLICY, stderr: "" };
          case "sandbox:list":
            return {
              status: 0,
              stdout: args.includes("json")
                ? sandboxPresent
                  ? sandboxListJson(SANDBOX_ID, phase)
                  : "[]"
                : live,
              stderr: "",
            };
          case "sandbox:delete":
            sandboxPresent = false;
            containerPresent = false;
            return { status: 0, stdout: "", stderr: "" };
          case "sandbox:get":
            return replacement
              ? {
                  status: 0,
                  stdout: `Name: ${SANDBOX}\nID: replacement\nPhase: Ready\n`,
                  stderr: "",
                }
              : sandboxPresent
                ? { status: 0, stdout: live, stderr: "" }
                : {
                    status: 1,
                    stdout: "",
                    stderr: `Error: sandbox '${SANDBOX}' not found`,
                  };
          default:
            return poisonUnexpectedCommand("OpenShell", args);
        }
      });

      withMcpLifecycleLockSync(
        SANDBOX,
        () => {
          const prepared = prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
            allowAbsent: true,
          });
          expect(prepared.present).toBe(true);
          prepared.removeAndVerify();
          prepared.verifyAbsent();
          expect(
            prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
              allowAbsent: true,
            }).present,
          ).toBe(false);

          replacement = true;
          expect(() =>
            prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
              allowAbsent: true,
            }),
          ).toThrow("OpenShell sandbox identity disagrees");
        },
        { stateDir: path.join(stateDir, "state") },
      );
      expect(
        deps.captureOpenShell.mock.calls.filter(([args]) => args[1] === "delete"),
      ).toHaveLength(1);
    },
  );

  it("rejects rendered absence text when the JSON sandbox list is malformed (#9608)", () => {
    const receipt = activeReceipt();
    const { deps, podman } = lifecycleDeps(receipt);
    deps.captureOpenShell = vi.fn((args: readonly string[]) => {
      const command = args.slice(0, 2).join(":");
      switch (command) {
        case "sandbox:get":
          return { status: 1, stdout: "", stderr: `sandbox ${SANDBOX} not found` };
        case "sandbox:list":
          return { status: 0, stdout: "warning: stale cache", stderr: "" };
        default:
          return poisonUnexpectedCommand("OpenShell", args);
      }
    });

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          prepareHermesPortableSandboxRemoval(SANDBOX, lifecycleContext(), deps, {
            allowAbsent: true,
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("cannot prove the current OpenShell sandbox");
    expect(podman).not.toHaveBeenCalled();
  });
});
