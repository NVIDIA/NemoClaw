// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { vi } from "vitest";
import type { SandboxEntry } from "../../state/registry";
import { fingerprintOpenShellSandboxLiveIdentity } from "../../adapters/openshell/sandbox-identity";
import { hermesPortableLifecycleInternals } from "./hermes-portable-lifecycle";
import type { AgentDefinition } from "../../agent/definition-types";
import { hermesPortableContainerInternals } from "./hermes-portable-container";
import { resolveHermesPortableStartupContract } from "./hermes-portable-contract";
import {
  createSandboxListJson,
  poisonUnexpectedCommand,
  directoryChain,
  startupArgv as renderStartupArgv,
} from "./hermes-portable-lifecycle.test-fixtures";
import {
  captureHermesPortablePolicySource,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
  type HermesPortablePendingReceipt,
} from "./hermes-portable-receipt";

import type { HermesPortableOpenShellExecutableAuthority } from "../../adapters/openshell/resolve-shared";
import type { PodmanExecutableAuthorityDeps, PodmanExecutableStat } from "../../adapters/podman";
import type { HermesPortablePodmanExecutableAuthority } from "./hermes-portable-podman-authority";

const PODMAN_BYTES = Buffer.from("podman-5.7.0-test", "utf8");

export function testOpenShellExecutableAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.116",
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

export function testPodmanExecutableAuthority(): HermesPortablePodmanExecutableAuthority {
  return {
    version: "5.7.0",
    executable: {
      executablePath: "/usr/bin/podman",
      device: "1",
      inode: "30",
      mode: String(0o100755),
      ownerUid: "0",
      size: String(PODMAN_BYTES.byteLength),
      modifiedTimeNanoseconds: "31",
      changedTimeNanoseconds: "32",
      sha256: createHash("sha256").update(PODMAN_BYTES).digest("hex"),
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

export function testPodmanExecutableAuthorityDeps(): PodmanExecutableAuthorityDeps {
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
    size: filePath === "/usr/bin/podman" ? BigInt(PODMAN_BYTES.byteLength) : 0n,
    mtimeNs: 31n,
    ctimeNs: 32n,
    isDirectory: () => filePath !== "/usr/bin/podman",
    isFile: () => filePath === "/usr/bin/podman",
    isSymbolicLink: () => false,
  });
  return {
    uid: process.getuid!(),
    lstat: stat,
    readFile: () => PODMAN_BYTES,
    realpath: (filePath) => filePath,
  };
}

export function createHermesPortableLifecycleTestReceipt({
  agent,
  stateDir,
  policyPath,
  homeDir,
  sandboxName,
  gatewayName,
  lifecycleGeneration,
  containerId,
  imageDigest,
  sandboxId,
  labels,
}: {
  agent: AgentDefinition;
  stateDir: string;
  policyPath: string;
  homeDir: string;
  sandboxName: string;
  gatewayName: string;
  lifecycleGeneration: string;
  containerId: string;
  imageDigest: string;
  sandboxId: string;
  labels: Readonly<Record<string, string>>;
}): HermesPortableConfiguredReceipt {
  const uid = process.getuid!();
  const socketPath = `/run/user/${String(uid)}/podman/podman.sock`;
  const transactionId = randomUUID();
  const policy = publishHermesPortableDurablePolicySource({
    sandboxName: sandboxName,
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
    sandboxName: sandboxName,
    gatewayName: gatewayName,
    lifecycleGeneration: lifecycleGeneration,
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
    openshellExecutableAuthority: testOpenShellExecutableAuthority(),
    podmanExecutableAuthority: testPodmanExecutableAuthority(),
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
      agent,
      sandboxName: sandboxName,
      startupArgv: renderStartupArgv(sandboxName),
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
      containerId: containerId,
      sandboxId: sandboxId,
      imageId: `sha256:${imageDigest}`,
      labelsSha256: hermesPortableContainerInternals.labelsDigest(labels),
      name: `openshell-default--${sandboxName}-${sandboxId}`,
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

export const SANDBOX = "alpha";
export const GATEWAY = "nemoclaw";
export const GENERATION = "generation-1";
export const CONTAINER_ID = "a".repeat(64);
export const IMAGE = "b".repeat(64);
export const SANDBOX_ID = "sandbox-id-1";
export const POLICY = "version: 1\nnetwork_policies: {}\n";
const LIVE = `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: Ready\n`;
export const sandboxListJson = createSandboxListJson(SANDBOX);
export const LABELS = {
  "openshell.managed": "true",
  "openshell.ai/sandbox-id": SANDBOX_ID,
  "openshell.ai/sandbox-name": SANDBOX,
  "openshell.ai/sandbox-namespace": "",
  "openshell.ai/sandbox-workspace": "default",
};

export function createHermesPortableLifecycleTestDeps(
  stateDir: string,
  receipt: HermesPortableConfiguredReceipt,
  initiallyRunning = true,
  options: {
    readonly livePolicy?: string;
    readonly registry?: Partial<SandboxEntry>;
    readonly sandboxPhase?: (running: boolean) => string;
    readonly sandboxIdentity?: (running: boolean) => string | undefined;
    readonly failPostStartInspectOnce?: boolean;
    readonly stopRequiresAssist?: boolean;
    readonly startStatus?: number;
    readonly initialPhase?: "Ready" | "Error" | "Stopped";
    readonly nonRunningStatus?: string;
  } = {},
) {
  let running = initiallyRunning,
    workloadRunning = initiallyRunning,
    now = 0;
  let lifecyclePhase: "Ready" | "Error" | "Stopped" | undefined = options.initialPhase;
  let postStartInspectFailurePending = false;
  const sandboxPhase = () =>
    options.sandboxPhase?.(running) ?? lifecyclePhase ?? (running ? "Ready" : "Stopped");
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
                    Status: running ? "running" : (options.nonRunningStatus ?? "exited"),
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
    const stopAssist = args.includes(
      hermesPortableLifecycleInternals.openShellV0116StopAssistProgram,
    );
    workloadRunning = stopAssist && options.stopRequiresAssist ? false : workloadRunning;
    const sandboxExecOutput = args.includes(hermesPortableLifecycleInternals.healthWaitProgram)
      ? "schema=1 result=ready attempts=1 notReady=0 timeouts=0 errors=0 lastFailure=none probeMs=0 sleepMs=0\n"
      : stopAssist
        ? "schema=1 result=armed pgrp=123\n"
        : args.includes("python3")
          ? "200\n"
          : "";
    const operation = args.slice(0, 2).join(":");
    const mutation = {
      "sandbox:start": () => {
        running = true;
        workloadRunning = true;
        lifecyclePhase = "Ready";
        postStartInspectFailurePending = options.failPostStartInspectOnce === true;
        return { status: options.startStatus ?? 0, stdout: "", stderr: "start failed" };
      },
      "sandbox:stop": () => {
        const blocked = options.stopRequiresAssist && workloadRunning;
        running = blocked ? running : false;
        lifecyclePhase = blocked ? lifecyclePhase : "Stopped";
        return blocked
          ? { status: 1, stdout: "", stderr: "managed workload is still running" }
          : { status: 0, stdout: "", stderr: "" };
      },
    }[operation];
    const responses = {
      "policy:get": { status: 0, stdout: options.livePolicy ?? POLICY, stderr: "" },
      "sandbox:list": {
        status: 0,
        stdout: sandboxListJson(SANDBOX_ID, sandboxPhase()),
        stderr: "",
      },
      "sandbox:get": {
        status: 0,
        stdout:
          options.sandboxIdentity?.(running) ??
          `Name: ${SANDBOX}\nID: ${SANDBOX_ID}\nPhase: ${sandboxPhase()}\n`,
        stderr: "",
      },
      "sandbox:exec": { status: 0, stdout: sandboxExecOutput, stderr: "" },
    };
    return (
      mutation?.() ??
      responses[operation as keyof typeof responses] ??
      poisonUnexpectedCommand("OpenShell", args)
    );
  });
  const launchOpenShell = vi.fn();
  const captureSocketAuthority = vi.fn(() => ({ ...receipt.socketAuthority, inode: "102" }));
  const captureOpenShellExecutableAuthority = vi.fn(() => receipt.openshellExecutableAuthority);
  const capturePodmanExecutableAuthority = vi.fn(() => receipt.podmanExecutableAuthority);
  const assertOpenShellExecutableAuthority = vi.fn(() => "/usr/bin/openshell");
  const assertOpenShellExecutableFileAuthority = vi.fn(() => "/usr/bin/openshell");
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
          openshellVersion: "0.0.116",
          ...options.registry,
        }) as SandboxEntry,
      captureOpenShell,
      launchOpenShell,
      assertOpenShellExecutableAuthority,
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
      now: () => now,
      sleep: vi.fn((milliseconds: number) => {
        now += milliseconds;
      }),
    },
    podman,
    captureOpenShell,
    launchOpenShell,
    captureSocketAuthority,
    captureOpenShellExecutableAuthority,
    capturePodmanExecutableAuthority,
    assertOpenShellExecutableAuthority,
    assertOpenShellExecutableFileAuthority,
    capturePodmanExecutableFileAuthority,
  };
}
