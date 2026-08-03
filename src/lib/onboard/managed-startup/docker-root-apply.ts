// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { dockerCapture } from "../../adapters/docker/run";
import { isImmutableDockerImageId } from "../openshell-docker-sandbox-containers";
import { MANAGED_STARTUP_RUNTIME_EXECUTABLE } from "./image-runtime";
import {
  type ManagedStartupRootApplyRequest,
  selectManagedStartupApplicationRuntimeEnvironment,
  serializeManagedStartupRootApplyRequest,
} from "./root-apply";
import { MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY } from "./shared-state-transaction";

const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const ROOT_APPLY_TIMEOUT_MS = 300_000;
const FIXED_ROOT_ENV = [
  "HOME=/root",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
] as const;

interface DockerManagedStartupInspect {
  readonly Id?: string;
  readonly Image?: string;
  readonly State?: {
    readonly Running?: boolean;
    readonly Paused?: boolean;
    readonly Restarting?: boolean;
    readonly Dead?: boolean;
  } | null;
}

export interface DockerManagedStartupTransaction {
  readonly agent: ManagedStartupRootApplyRequest["agent"];
  readonly containerId: string;
  readonly image: string;
}

export interface DockerManagedStartupRootApplyDeps {
  readonly dockerCapture?: typeof dockerCapture;
  readonly dockerSpawnSync?: typeof dockerSpawnSync;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export function getDockerManagedStartupFailureTransaction(
  error: unknown,
): DockerManagedStartupTransaction | null {
  if (typeof error === "object" && error !== null && "managedStartupTransaction" in error) {
    return (
      (error as { managedStartupTransaction?: DockerManagedStartupTransaction })
        .managedStartupTransaction ?? null
    );
  }
  return null;
}

function commandDetail(result: {
  readonly status?: number | null;
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: Error | null;
}): string {
  return `${String(result.stderr ?? "")} ${String(result.stdout ?? "")} ${String(
    result.error?.message ?? "",
  )}`
    .trim()
    .slice(-1200);
}

function inspectExactContainer(
  containerId: string,
  capture: typeof dockerCapture,
): { readonly containerId: string; readonly image: string } {
  if (!FULL_CONTAINER_ID_RE.test(containerId)) {
    throw new Error("Managed startup requires one full lowercase Docker container ID.");
  }
  const output = capture(["inspect", "--type", "container", containerId], {
    ignoreError: false,
    timeout: 30_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Docker returned malformed inspect output for the managed-startup container.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Docker inspect did not resolve exactly one managed-startup container.");
  }
  const inspect = parsed[0] as DockerManagedStartupInspect;
  const exactId = String(inspect.Id ?? "").toLowerCase();
  const image = String(inspect.Image ?? "").toLowerCase();
  if (exactId !== containerId) {
    throw new Error("Managed-startup container identity changed before root application.");
  }
  if (!isImmutableDockerImageId(image)) {
    throw new Error("Managed-startup container does not have an immutable image identity.");
  }
  if (
    inspect.State?.Running !== true ||
    inspect.State.Paused === true ||
    inspect.State.Restarting === true ||
    inspect.State.Dead === true
  ) {
    throw new Error("Managed-startup container is not stably running for root application.");
  }
  return { containerId: exactId, image };
}

export function applyDockerManagedStartupRootRequest(
  input: {
    readonly containerId: string;
    readonly request: ManagedStartupRootApplyRequest;
  },
  deps: DockerManagedStartupRootApplyDeps = {},
): DockerManagedStartupTransaction | null {
  const capture = deps.dockerCapture ?? dockerCapture;
  const spawn = deps.dockerSpawnSync ?? dockerSpawnSync;
  const pinned = inspectExactContainer(input.containerId, capture);
  const transaction = {
    agent: input.request.agent,
    containerId: pinned.containerId,
    image: pinned.image,
  } satisfies DockerManagedStartupTransaction;
  const payload = serializeManagedStartupRootApplyRequest(input.request);
  const applicationRuntimeEnvironment = Object.entries(
    selectManagedStartupApplicationRuntimeEnvironment(deps.environment ?? process.env),
  ).map(([name, value]) => `${name}=${value}`);
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
    ...applicationRuntimeEnvironment,
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
  // The image-side coordinator and transaction are idempotent. One retry
  // reconciles the only ambiguous case: Docker lost the first exec
  // acknowledgement after the completion marker was already published.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawn(argv, {
      encoding: "utf8",
      input: payload,
      timeout: ROOT_APPLY_TIMEOUT_MS,
    });
    if (result.status === 0) {
      const receiptProbe = spawn(receiptProbeArgv, {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (receiptProbe.status === 0) return transaction;
      if (receiptProbe.status === 1) return null;
      const receiptProbeDetail = commandDetail(receiptProbe);
      const error = new Error(
        `Managed startup root application completed, but transaction state could not be verified in exact container ${pinned.containerId.slice(0, 12)}${
          receiptProbeDetail ? `: ${receiptProbeDetail}` : ""
        }`,
      );
      (
        error as Error & {
          managedStartupTransaction?: DockerManagedStartupTransaction;
        }
      ).managedStartupTransaction = transaction;
      throw error;
    }
    lastFailure = commandDetail(result);
  }
  const error = new Error(
    `Managed startup root application failed in exact container ${pinned.containerId.slice(0, 12)}${
      lastFailure ? `: ${lastFailure}` : ""
    }`,
  );
  (
    error as Error & {
      managedStartupTransaction?: DockerManagedStartupTransaction;
    }
  ).managedStartupTransaction = transaction;
  throw error;
}
