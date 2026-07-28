// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { vi } from "vitest";
import {
  DUAL_STATION_VLLM_RUNTIME,
  type DualStationVllmPlan,
} from "../../src/lib/inference/vllm-station-cluster";
import {
  DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL,
  DUAL_STATION_VLLM_CLUSTER_LABEL,
  DUAL_STATION_VLLM_ENDPOINT_LABEL,
  DUAL_STATION_VLLM_GPU_LABEL,
  DUAL_STATION_VLLM_GPU_SMOKE_LABEL,
  DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
  DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL,
  DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL,
  DUAL_STATION_VLLM_MANAGED_LABEL,
  DUAL_STATION_VLLM_ROLE_LABEL,
  DUAL_STATION_VLLM_TRANSACTION_LABEL,
  DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
  type DualStationDockerOptions,
  type DualStationLegacyMigration,
  type DualStationVllmLifecycleDeps,
  type StartDualStationVllmResult,
} from "../../src/lib/inference/vllm-station-cluster-lifecycle";
import type { DualStationSshBinding } from "../../src/lib/inference/vllm-station-ssh-binding";

export type LifecycleFakeContainer = {
  id: string;
  name: string;
  state: string;
  image: string;
  labels: Record<string, string>;
};

export type LifecycleHarnessOptions = {
  failRole?: "head" | "worker";
  invalidIdRole?: "head" | "worker";
  failSmokeTarget?: "local" | "peer";
  failSmokeCleanupTarget?: "local" | "peer";
  missingImageTarget?: "local" | "peer";
  smokeGpuOutput?: Partial<Record<"local" | "peer", string>>;
  lateCreateRole?: "head" | "worker";
  failedRoleForeignTransaction?: "head" | "worker";
  failFinalInspectionRole?: "head" | "worker";
  failLegacyBackupRemoval?: boolean;
};

type LifecycleHarnessFixture = {
  apiKey: string;
  fakeContainer: (
    role: "head" | "worker",
    overrides?: Partial<LifecycleFakeContainer>,
  ) => LifecycleFakeContainer;
  headSmokeId: string;
  legacyHeadId: string;
  plan: () => DualStationVllmPlan;
  workerSmokeId: string;
};

export function dualStationDockerValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag && index < args.length - 1 ? [args[index + 1]] : [],
  );
}

export function requireLegacyMigration(
  result: StartDualStationVllmResult,
): DualStationLegacyMigration {
  if (!result.ok || !result.legacyMigration) {
    throw new Error("expected legacy migration handle");
  }
  return result.legacyMigration;
}

function raise(message: string): never {
  throw new Error(message);
}

function row(container: LifecycleFakeContainer): string {
  return [
    container.id,
    container.name,
    container.state,
    container.image,
    container.labels[DUAL_STATION_VLLM_MANAGED_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_ROLE_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_ENDPOINT_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_CLUSTER_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_GPU_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL] ?? "",
    container.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL] ?? "",
  ].join("\t");
}

export function createDualStationLifecycleHarness(
  fixture: LifecycleHarnessFixture,
  options: LifecycleHarnessOptions = {},
) {
  const containers = new Map<string, LifecycleFakeContainer[]>();
  const operations: Array<{
    kind: "capture" | "rename" | "rm" | "run" | "start" | "stop";
    target: string;
    value: string;
  }> = [];
  const captureOptions: Array<DualStationDockerOptions | undefined> = [];
  const rmOptions: Array<DualStationDockerOptions | undefined> = [];
  const runCalls: Array<{
    args: readonly string[];
    options: DualStationDockerOptions | undefined;
  }> = [];
  const buildRemoteDockerEnv = vi.fn((binding: DualStationSshBinding) => ({
    TARGET: "peer",
    DOCKER_HOST: `ssh://${binding.sshUser}@${binding.resolvedHost}`,
    VLLM_API_KEY: "ambient-must-be-stripped",
  }));
  let nonceCounter = 0;
  let transactionCounter = 0;
  let lifecycleLockActive = 0;
  let maxLifecycleLockActive = 0;
  let lifecycleLockTail = Promise.resolve();
  const lifecycleLockContext = new AsyncLocalStorage<boolean>();
  let lateContainer: { targetName: string; container: LifecycleFakeContainer } | null = null;
  const launchedRoles = new Set<"head" | "worker">();
  const managedInspectionCounts = { head: 0, worker: 0 };
  let finalInspectionFailureInjected = false;

  async function acquireLifecycleLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = lifecycleLockTail;
    let release: () => void = () => undefined;
    lifecycleLockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    lifecycleLockActive += 1;
    maxLifecycleLockActive = Math.max(maxLifecycleLockActive, lifecycleLockActive);
    try {
      return await lifecycleLockContext.run(true, operation);
    } finally {
      lifecycleLockActive -= 1;
      release();
    }
  }

  function target(optionsArg?: DualStationDockerOptions): string {
    return String(optionsArg?.env?.TARGET ?? "unknown");
  }

  function key(targetName: string, name: string): string {
    return `${targetName}:${name}`;
  }

  function exactContainerById(
    targetName: string,
    containerId: string,
  ): {
    containerKey: string;
    entries: LifecycleFakeContainer[];
    container: LifecycleFakeContainer;
  } | null {
    for (const [containerKey, entries] of containers.entries()) {
      if (!containerKey.startsWith(`${targetName}:`)) continue;
      const container = entries.find((entry) => entry.id === containerId);
      if (container) return { containerKey, entries, container };
    }
    return null;
  }

  const deps: DualStationVllmLifecycleDeps = {
    buildLocalDockerEnv: () => ({
      TARGET: "local",
      VLLM_API_KEY: "ambient-must-be-stripped",
    }),
    buildRemoteDockerEnv,
    createProbeNonce: () => {
      nonceCounter += 1;
      return nonceCounter.toString(16).padStart(32, "0");
    },
    createTransactionId: () => {
      transactionCounter += 1;
      return transactionCounter.toString(16).padStart(32, "0");
    },
    effectiveControllerUid: () => fixture.plan().local.uid,
    readControllerUid: () => fixture.plan().local.uid,
    loadApiKey: () => fixture.apiKey,
    localInterfaceAddresses: () => [fixture.plan().masterAddress],
    waitBeforeReconcile: async () => {
      const pending = lateContainer;
      lateContainer = null;
      return pending
        ? void containers.set(key(pending.targetName, pending.container.name), [pending.container])
        : undefined;
    },
    withLifecycleLock: async <T>(operation: () => Promise<T> | T) =>
      lifecycleLockContext.getStore() ? await operation() : await acquireLifecycleLock(operation),
    dockerCapture: (args, optionsArg) => {
      captureOptions.push(optionsArg);
      const targetName = target(optionsArg);
      if (args[0] === "container" && args[1] === "rename") {
        const containerId = args[2];
        const newName = args[3];
        operations.push({
          kind: "rename",
          target: targetName,
          value: `${containerId}:${newName}`,
        });
        const located = exactContainerById(targetName, containerId);
        if (!located || (containers.get(key(targetName, newName)) ?? []).length > 0) {
          return raise("rename failed");
        }
        containers.set(
          located.containerKey,
          located.entries.filter((entry) => entry.id !== containerId),
        );
        located.container.name = newName;
        containers.set(key(targetName, newName), [located.container]);
        return "";
      }
      if (args[0] === "container" && (args[1] === "start" || args[1] === "stop")) {
        const action = args[1];
        const containerId = args.at(-1) ?? "";
        operations.push({ kind: action, target: targetName, value: containerId });
        const located = exactContainerById(targetName, containerId);
        if (!located) return raise(`${action} failed`);
        located.container.state = action === "start" ? "running" : "exited";
        return containerId;
      }
      switch (args[0]) {
        case "image": {
          operations.push({ kind: "capture", target: targetName, value: `image:${args.at(-1)}` });
          return options.missingImageTarget === targetName
            ? raise("missing image")
            : `sha256:${"f".repeat(64)}\n`;
        }
        case "wait":
          operations.push({ kind: "capture", target: targetName, value: `wait:${args[1]}` });
          return "0\n";
        case "logs": {
          operations.push({ kind: "capture", target: targetName, value: `logs:${args[1]}` });
          const defaultUuid =
            targetName === "local" ? fixture.plan().local.gpu.uuid : fixture.plan().peer.gpu.uuid;
          return `${options.smokeGpuOutput?.[targetName as "local" | "peer"] ?? defaultUuid}\n`;
        }
        default:
          break;
      }
      const filter = dualStationDockerValues(args, "--filter")[0] ?? "";
      const name = filter.replace(/^name=\^\//, "").replace(/\$$/, "");
      operations.push({ kind: "capture", target: targetName, value: name });
      const isSmokeInspection =
        dualStationDockerValues(args, "--format")[0]?.includes(DUAL_STATION_VLLM_GPU_SMOKE_LABEL) ??
        false;
      let inspected = containers.get(key(targetName, name)) ?? [];
      const inspectedRole =
        name === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME
          ? "head"
          : name === DUAL_STATION_VLLM_WORKER_CONTAINER_NAME
            ? "worker"
            : null;
      if (!isSmokeInspection && inspectedRole && launchedRoles.has(inspectedRole)) {
        managedInspectionCounts[inspectedRole] += 1;
        if (
          options.failFinalInspectionRole === inspectedRole &&
          managedInspectionCounts[inspectedRole] === 2 &&
          !finalInspectionFailureInjected
        ) {
          finalInspectionFailureInjected = true;
          inspected = inspected.map((container) => ({ ...container, state: "exited" }));
        }
      }
      return inspected
        .map((container) =>
          isSmokeInspection
            ? [
                container.id,
                container.name,
                container.image,
                container.labels[DUAL_STATION_VLLM_GPU_SMOKE_LABEL] ?? "",
                container.labels[DUAL_STATION_VLLM_ROLE_LABEL] ?? "",
              ].join("\t")
            : row(container),
        )
        .join("\n");
    },
    dockerRunDetached: (args, optionsArg) => {
      const targetName = target(optionsArg);
      const name = dualStationDockerValues(args, "--name")[0];
      runCalls.push({ args: [...args], options: optionsArg });
      operations.push({ kind: "run", target: targetName, value: name });
      const labels = Object.fromEntries(
        dualStationDockerValues(args, "--label").map((label) => {
          const separator = label.indexOf("=");
          return [label.slice(0, separator), label.slice(separator + 1)];
        }),
      );
      switch (name.startsWith("nemoclaw-vllm-gpu-smoke-")) {
        case true:
          return options.failSmokeTarget === targetName
            ? { status: 1, stdout: "", stderr: "smoke failed" }
            : (() => {
                const smokeContainer: LifecycleFakeContainer = {
                  id: targetName === "local" ? fixture.headSmokeId : fixture.workerSmokeId,
                  name,
                  state: "exited",
                  image: DUAL_STATION_VLLM_RUNTIME.image,
                  labels,
                };
                containers.set(key(targetName, name), [smokeContainer]);
                return { status: 0, stdout: `${smokeContainer.id}\n` };
              })();
        default:
          break;
      }
      const role = name === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME ? "head" : "worker";
      launchedRoles.add(role);
      const imageIndex = args.indexOf("/bin/bash") + 1;
      const container = fixture.fakeContainer(role, {
        image: args[imageIndex],
        labels,
      });
      return options.failedRoleForeignTransaction === role
        ? (() => {
            container.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL] = "f".repeat(32);
            containers.set(key(targetName, name), [container]);
            return { status: 1, stdout: "", stderr: "ambiguous failed create" };
          })()
        : options.lateCreateRole === role
          ? (() => {
              lateContainer = { targetName, container };
              return { status: null, stdout: "", stderr: "timed out" };
            })()
          : options.failRole === role
            ? { status: 1, stdout: "", stderr: "failed" }
            : (() => {
                containers.set(key(targetName, name), [container]);
                return {
                  status: 0,
                  stdout:
                    options.invalidIdRole === role ? "not-a-container-id\n" : `${container.id}\n`,
                };
              })();
    },
    dockerForceRm: (containerId, optionsArg) => {
      rmOptions.push(optionsArg);
      const targetName = target(optionsArg);
      operations.push({ kind: "rm", target: targetName, value: containerId });
      const shouldFail =
        (options.failSmokeCleanupTarget === targetName &&
          (containerId === fixture.workerSmokeId || containerId === fixture.headSmokeId)) ||
        (options.failLegacyBackupRemoval && containerId === fixture.legacyHeadId);
      const match = [...containers.entries()].find(
        ([containerKey, entries]) =>
          containerKey.startsWith(`${targetName}:`) &&
          entries.some((entry) => entry.id === containerId),
      );
      return shouldFail || !match
        ? { status: 1 }
        : (() => {
            const [containerKey, entries] = match;
            const remaining = entries.filter((entry) => entry.id !== containerId);
            containers.set(containerKey, remaining);
            return { status: 0 };
          })();
    },
  };

  function seed(targetName: "local" | "peer", container: LifecycleFakeContainer): void {
    const containerKey = key(targetName, container.name);
    containers.set(containerKey, [...(containers.get(containerKey) ?? []), container]);
  }

  return {
    buildRemoteDockerEnv,
    captureOptions,
    containers,
    deps,
    getMaxLifecycleLockActive: () => maxLifecycleLockActive,
    operations,
    rmOptions,
    runCalls,
    seed,
  };
}
