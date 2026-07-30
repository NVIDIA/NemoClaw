// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PodmanSocketAuthority } from "../compute/podman/socket-authority";
import { MANAGED_STARTUP_RUNTIME_EXECUTABLE } from "./image-runtime";
import {
  assertPodmanManagedStartupRuntime,
  inspectExactPodmanManagedStartupContainer,
  type PodmanManagedStartupRuntimeDeps,
  type PodmanManagedStartupRuntimeIdentity,
  pinPodmanManagedStartupRuntime,
  podmanManagedStartupCommandDetail,
  runManagedStartupPodman,
} from "./podman-runtime";
import {
  type ManagedStartupRootApplyRequest,
  serializeManagedStartupRootApplyRequest,
} from "./root-apply";
import { MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY } from "./shared-state-transaction";

const ROOT_APPLY_TIMEOUT_MS = 300_000;
const FIXED_ROOT_ENV = [
  "HOME=/root",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
] as const;

export interface PodmanManagedStartupTransaction {
  readonly agent: ManagedStartupRootApplyRequest["agent"];
  readonly bootstrapIdentity?: string | null;
  readonly containerId: string;
  readonly image: string;
  readonly profileFingerprint?: string | null;
  readonly runtime: PodmanManagedStartupRuntimeIdentity;
}

export type PodmanManagedStartupRootApplyDeps = PodmanManagedStartupRuntimeDeps;

export function getPodmanManagedStartupFailureTransaction(
  error: unknown,
): PodmanManagedStartupTransaction | null {
  if (typeof error === "object" && error !== null && "managedStartupTransaction" in error) {
    return (
      (error as { managedStartupTransaction?: PodmanManagedStartupTransaction })
        .managedStartupTransaction ?? null
    );
  }
  return null;
}

function failureWithTransaction(
  message: string,
  transaction: PodmanManagedStartupTransaction,
): Error {
  const error = new Error(message);
  (
    error as Error & {
      managedStartupTransaction?: PodmanManagedStartupTransaction;
    }
  ).managedStartupTransaction = transaction;
  return error;
}

export function applyPodmanManagedStartupRootRequest(
  input: {
    readonly bootstrapIdentity?: string | null;
    readonly containerId: string;
    readonly request: ManagedStartupRootApplyRequest;
    readonly socketAuthority: PodmanSocketAuthority;
    readonly socketPath: string;
  },
  deps: PodmanManagedStartupRootApplyDeps = {},
): PodmanManagedStartupTransaction | null {
  deps = { ...deps, socketAuthority: input.socketAuthority };
  const runtime = pinPodmanManagedStartupRuntime(input.socketPath, input.socketAuthority, deps);
  const pinned = inspectExactPodmanManagedStartupContainer(
    runtime,
    { containerId: input.containerId, requireRunning: true },
    deps,
  );
  const transaction = Object.freeze({
    agent: input.request.agent,
    bootstrapIdentity: input.bootstrapIdentity ?? null,
    containerId: pinned.containerId,
    image: pinned.image,
    profileFingerprint: input.request.profileFingerprint,
    runtime,
  }) satisfies PodmanManagedStartupTransaction;
  const payload = serializeManagedStartupRootApplyRequest(input.request);
  const argv = [
    "exec",
    "--interactive",
    "--user",
    "0:0",
    "--workdir",
    "/",
    pinned.containerId,
    "/usr/bin/env",
    "-i",
    ...FIXED_ROOT_ENV,
    "/usr/local/bin/node",
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    "--apply-root-stdin",
    "--agent",
    input.request.agent,
  ];
  const receiptProbeArgv = [
    "exec",
    "--user",
    "0:0",
    "--workdir",
    "/",
    pinned.containerId,
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "/bin/sh",
    "-c",
    'if [ -d "$1" ] && [ ! -L "$1" ]; then exit 0; fi; if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 1; fi; exit 2',
    "nemoclaw-transaction-probe",
    MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
  ];

  let lastFailure = "";
  // Root application is idempotent. Retry only the ambiguous lost-ack window,
  // using the same socket, full container identity, command, and stdin bytes.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertPodmanManagedStartupRuntime(runtime, deps);
      inspectExactPodmanManagedStartupContainer(
        runtime,
        { containerId: pinned.containerId, image: pinned.image, requireRunning: true },
        deps,
      );
    } catch (error) {
      throw failureWithTransaction(
        `Managed startup could not revalidate the exact Podman runtime and container before root application: ${
          error instanceof Error ? error.message : String(error)
        }`,
        transaction,
      );
    }
    const result = runManagedStartupPodman(
      runtime.socketPath,
      argv,
      { input: payload, timeout: ROOT_APPLY_TIMEOUT_MS },
      deps,
    );
    if (result.status === 0) {
      try {
        assertPodmanManagedStartupRuntime(runtime, deps);
        inspectExactPodmanManagedStartupContainer(
          runtime,
          { containerId: pinned.containerId, image: pinned.image, requireRunning: true },
          deps,
        );
      } catch (error) {
        throw failureWithTransaction(
          `Managed startup could not revalidate the exact Podman runtime and container before transaction proof: ${
            error instanceof Error ? error.message : String(error)
          }`,
          transaction,
        );
      }
      const receiptProbe = runManagedStartupPodman(runtime.socketPath, receiptProbeArgv, {}, deps);
      if (receiptProbe.status === 0) return transaction;
      if (receiptProbe.status === 1) return null;
      const detail = podmanManagedStartupCommandDetail(receiptProbe);
      throw failureWithTransaction(
        `Managed startup root application completed, but transaction state could not be verified in exact Podman container ${pinned.containerId.slice(0, 12)}${
          detail ? `: ${detail}` : ""
        }`,
        transaction,
      );
    }
    lastFailure = podmanManagedStartupCommandDetail(result);
  }
  throw failureWithTransaction(
    `Managed startup root application failed in exact Podman container ${pinned.containerId.slice(0, 12)}${
      lastFailure ? `: ${lastFailure}` : ""
    }`,
    transaction,
  );
}
