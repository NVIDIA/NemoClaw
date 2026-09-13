// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentDefinition } from "../../agent/definition-types";
import { hermesPortableContainerInternals } from "./hermes-portable-container";
import { resolveHermesPortableStartupContract } from "./hermes-portable-contract";
import {
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

/**
 * Builds receipts for the lifecycle test in its companion module so that the
 * lifecycle scenarios stay within the repository's test-file size limit.
 */
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
