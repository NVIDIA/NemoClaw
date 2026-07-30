// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertPodmanGpuAttachmentQualified,
  type PodmanGpuAttachment,
} from "../compute/podman/gpu-attachment";
import type { PodmanSandboxCreateRuntimeAuthority } from "../compute/podman/sandbox-create-authority";
import {
  capturePodmanManagedSandboxLaunchSnapshot,
  finalizePodmanManagedSandbox,
  findPodmanManagedSandboxContainerIds,
  inspectExactPodmanManagedSandbox,
  type PodmanManagedSandboxRecreateDeps,
  type PodmanManagedSandboxRecreateTransaction,
  quiesceExactPodmanManagedSandbox,
  type RunQualifiedPodmanCommand,
  recreatePodmanManagedSandbox,
} from "../compute/podman/sandbox-recreate";
import type {
  PodmanManagedSandboxInspect,
  PodmanUlimit,
} from "../compute/podman/sandbox-recreate-spec";
import { assertPodmanSocketAuthority } from "../compute/podman/socket-authority";
import { openshellSandboxCommandEnvValue } from "../docker-startup-command-env";
import {
  applyPodmanManagedStartupRootRequest,
  getPodmanManagedStartupFailureTransaction,
  type PodmanManagedStartupTransaction,
} from "../managed-startup/podman-root-apply";
import { finalizePodmanManagedStartupSharedState } from "../managed-startup/podman-shared-state";
import {
  resolveSupervisorReconnectTimeoutSecs,
  waitForSupervisorReconnect,
} from "../sandbox-create-runtime/supervisor-reconnect";
import {
  assertManagedBootstrapIdentity,
  createManagedBootstrapIdentity,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapAdapter,
  type ManagedBootstrapCompletionReceipt,
  ManagedBootstrapDurableCommitCleanupPendingError,
  type ManagedBootstrapFinalizationReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  ManagedBootstrapOwnerCleanupRequiredError,
  renderManagedBootstrapHeldCommand,
} from "./adapter";
import type { ManagedBootstrapRuntimeDependencies } from "./runtime-provider";

const PODMAN_DRIVER_ID = "podman";
const FULL_SHA256 = /^sha256:[a-f0-9]{64}$/u;

export interface PodmanManagedBootstrapDependencies extends ManagedBootstrapRuntimeDependencies {
  readonly gpuAttachment?: PodmanGpuAttachment | null;
  readonly now?: () => Date;
  readonly runPodman?: RunQualifiedPodmanCommand;
  readonly runtimeAuthority?: unknown;
}

interface PodmanBootstrapTransaction {
  readonly recreation: PodmanManagedSandboxRecreateTransaction;
  readonly managedStartup: PodmanManagedStartupTransaction | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Managed bootstrap Podman ${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (value == null) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.includes("\0"))
  ) {
    throw new Error(`Managed bootstrap Podman ${label} is not an exact string array.`);
  }
  return value;
}

function exactImageReference(repository: string, manifestDigest: string): string {
  if (
    !repository ||
    repository !== repository.trim() ||
    repository.includes("@") ||
    !FULL_SHA256.test(manifestDigest)
  ) {
    throw new Error("Managed bootstrap Podman image identity is invalid.");
  }
  return `${repository}@${manifestDigest}`;
}

function config(inspect: PodmanManagedSandboxInspect): Record<string, unknown> {
  return record(inspect.raw.Config, "inspect Config");
}

function assertImage(
  inspect: PodmanManagedSandboxInspect,
  image: ManagedBootstrapHeldWorkloadHandle["plan"]["image"],
): string {
  const configured = String(config(inspect).Image ?? "");
  const expected = exactImageReference(image.repository, image.manifestDigest);
  if (configured !== expected) {
    throw new Error(
      `Managed bootstrap Podman configured image '${configured}' does not match '${expected}'.`,
    );
  }
  if (!FULL_SHA256.test(inspect.immutableImage)) {
    throw new Error("Managed bootstrap Podman runtime image content identity is not immutable.");
  }
  return inspect.immutableImage;
}

function assertHeldCommand(
  inspect: PodmanManagedSandboxInspect,
  heldWorkloadArgv: readonly string[],
  bootstrapIdentity: string,
): void {
  assertManagedBootstrapIdentity(bootstrapIdentity);
  const expected = openshellSandboxCommandEnvValue(heldWorkloadArgv);
  const entries = stringArray(config(inspect).Env, "inspect environment");
  const matches = entries.filter((entry) => entry.startsWith("OPENSHELL_SANDBOX_COMMAND="));
  if (
    matches.length !== 1 ||
    matches[0] !== `OPENSHELL_SANDBOX_COMMAND=${expected ?? ""}` ||
    !heldWorkloadArgv.includes(bootstrapIdentity)
  ) {
    throw new Error("Managed bootstrap Podman held command is not identity-bound.");
  }
}

function supervisorArgv(inspect: PodmanManagedSandboxInspect): readonly string[] {
  const argv = stringArray(config(inspect).Entrypoint, "supervisor entrypoint");
  if (argv.length === 0 || !argv[0]?.startsWith("/")) {
    throw new Error("Managed bootstrap Podman supervisor entrypoint is not absolute.");
  }
  return Object.freeze([...argv]);
}

function exactArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function runtimeAuthority(value: unknown): PodmanSandboxCreateRuntimeAuthority {
  if (typeof value !== "object" || value === null) {
    throw new Error("Managed bootstrap Podman requires an exact runtime authority.");
  }
  const authority = value as Partial<PodmanSandboxCreateRuntimeAuthority>;
  if (
    typeof authority.socketPath !== "string" ||
    !authority.socketAuthority ||
    authority.socketAuthority.socketPath !== authority.socketPath ||
    !authority.watcherController ||
    typeof authority.watcherController.quiesceAndProve !== "function" ||
    !Array.isArray(authority.cdiDevices)
  ) {
    throw new Error("Managed bootstrap Podman runtime authority is incomplete.");
  }
  assertPodmanSocketAuthority(authority.socketAuthority);
  return authority as PodmanSandboxCreateRuntimeAuthority;
}

function podmanDeps(
  authority: PodmanSandboxCreateRuntimeAuthority,
  dependencies: PodmanManagedBootstrapDependencies,
): PodmanManagedSandboxRecreateDeps {
  return {
    socketAuthority: authority.socketAuthority,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.runPodman ? { run: dependencies.runPodman } : {}),
  };
}

function inspectExact(
  sandboxName: string,
  sandboxId: string,
  containerId: string,
  authority: PodmanSandboxCreateRuntimeAuthority,
  dependencies: PodmanManagedBootstrapDependencies,
  requireRunning = true,
): PodmanManagedSandboxInspect {
  return inspectExactPodmanManagedSandbox(
    {
      containerId,
      requireRunning,
      sandboxId,
      sandboxName,
      socketAuthority: authority.socketAuthority,
      socketPath: authority.socketPath,
    },
    podmanDeps(authority, dependencies),
  );
}

function replacementOptions(
  values: Readonly<Record<string, string | number | boolean | readonly string[]>>,
  authority: PodmanSandboxCreateRuntimeAuthority,
): {
  readonly gpuAttachment: PodmanGpuAttachment | null;
  readonly requiredUlimits: readonly PodmanUlimit[];
} {
  const expectedKeys = ["gpuDevice", "gpuEnabled", "requiredUlimits"];
  const actualKeys = Object.keys(values).sort();
  if (actualKeys.join(",") !== expectedKeys.sort().join(",")) {
    throw new Error("Managed bootstrap Podman replacement options have an unknown shape.");
  }
  const gpuEnabled = values.gpuEnabled;
  const gpuDevice = values.gpuDevice;
  const encodedLimits = values.requiredUlimits;
  if (
    typeof gpuEnabled !== "boolean" ||
    typeof gpuDevice !== "string" ||
    !Array.isArray(encodedLimits) ||
    encodedLimits.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Managed bootstrap Podman replacement options are invalid.");
  }
  const gpuAttachment = gpuEnabled
    ? ({ kind: "cdi", device: gpuDevice } satisfies PodmanGpuAttachment)
    : null;
  if (gpuAttachment) {
    assertPodmanGpuAttachmentQualified(authority.cdiDevices, gpuAttachment);
  }
  const requiredUlimits = encodedLimits.map((entry) => {
    const match = entry.match(/^([A-Za-z][A-Za-z0-9_]*):(-?\d+):(-?\d+)$/u);
    const soft = Number(match?.[2]);
    const hard = Number(match?.[3]);
    if (!match?.[1] || !Number.isSafeInteger(soft) || !Number.isSafeInteger(hard)) {
      throw new Error(`Managed bootstrap Podman ulimit '${entry}' is invalid.`);
    }
    return { name: match[1], soft, hard };
  });
  return { gpuAttachment, requiredUlimits };
}

function ownerCleanupRequired(
  input: {
    readonly sandboxName: string;
    readonly sandboxId: string;
    readonly runtimeId: string;
  },
  authority: PodmanSandboxCreateRuntimeAuthority,
  dependencies: PodmanManagedBootstrapDependencies,
): never {
  quiesceExactPodmanManagedSandbox(
    {
      containerId: input.runtimeId,
      sandboxId: input.sandboxId,
      sandboxName: input.sandboxName,
      socketAuthority: authority.socketAuthority,
      socketPath: authority.socketPath,
    },
    podmanDeps(authority, dependencies),
  );
  throw new ManagedBootstrapOwnerCleanupRequiredError(input);
}

export function createPodmanManagedBootstrapAdapter(
  dependencies: PodmanManagedBootstrapDependencies = {},
): ManagedBootstrapAdapter {
  const authority = runtimeAuthority(dependencies.runtimeAuthority);
  const transactions = new Map<string, PodmanBootstrapTransaction>();
  const committed = new Set<string>();
  const durablyCommitted = new Set<string>();
  const now = dependencies.now ?? (() => new Date());
  const deps = podmanDeps(authority, dependencies);

  const rollback = (
    handle: ManagedBootstrapHeldWorkloadHandle,
    runtimeId: string,
  ): ManagedBootstrapFinalizationReceipt => {
    if (committed.has(handle.bootstrapIdentity) || durablyCommitted.has(handle.bootstrapIdentity)) {
      throw new ManagedBootstrapDurableCommitCleanupPendingError({
        bootstrapIdentity: handle.bootstrapIdentity,
        cleanupRuntimeId: runtimeId,
        detail: "Podman rollback is forbidden after durable shared-state commit",
      });
    }
    const transaction = transactions.get(handle.bootstrapIdentity);
    let retainedRuntimeId = runtimeId;
    if (transaction) {
      if (transaction.managedStartup) {
        const shared = finalizePodmanManagedStartupSharedState(
          {
            containerRollbackAuthority: transaction.recreation,
            supervisorReady: false,
            transaction: transaction.managedStartup,
          },
          deps,
        );
        if (shared.failure || shared.supervisorReady) {
          throw (
            shared.failure ?? new Error("Managed bootstrap Podman shared-state rollback failed.")
          );
        }
      }
      const outcome = finalizePodmanManagedSandbox(
        {
          replacementReady: false,
          transaction: transaction.recreation,
          watcherController: authority.watcherController,
        },
        deps,
      );
      if (!outcome.rolledBack) {
        throw new Error("Managed bootstrap Podman runtime rollback could not be proven.");
      }
      retainedRuntimeId = transaction.recreation.oldContainerId;
      transactions.delete(handle.bootstrapIdentity);
    }
    return ownerCleanupRequired(
      {
        sandboxName: handle.sandbox.sandboxName,
        sandboxId: handle.sandbox.sandboxId,
        runtimeId: retainedRuntimeId,
      },
      authority,
      dependencies,
    );
  };

  return {
    async createHeldWorkload(input) {
      if (
        input.plan.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
        input.plan.driverId !== PODMAN_DRIVER_ID ||
        input.request.agent !== input.plan.profile.agent ||
        input.request.profileFingerprint !== input.plan.profile.fingerprint
      ) {
        throw new Error("Managed bootstrap Podman create plan does not match its root request.");
      }
      const bootstrapIdentity = input.bootstrapIdentity ?? createManagedBootstrapIdentity();
      assertManagedBootstrapIdentity(bootstrapIdentity);
      const heldWorkloadArgv = renderManagedBootstrapHeldCommand(
        input.request,
        bootstrapIdentity,
        input.plan.intendedWorkloadArgv,
      );
      const createReceipt = await input.launch({ heldWorkloadArgv, bootstrapIdentity });
      if (
        createReceipt.ready !== true ||
        createReceipt.sandbox.sandboxName !== input.plan.sandboxName ||
        createReceipt.sandbox.driverId !== PODMAN_DRIVER_ID ||
        !createReceipt.sandbox.sandboxId
      ) {
        throw new Error(
          "Managed bootstrap Podman create did not return one Ready durable sandbox identity.",
        );
      }
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: Object.freeze({ ...createReceipt.sandbox }),
        bootstrapIdentity,
        heldWorkloadArgv,
        intendedWorkloadArgv: Object.freeze([...input.plan.intendedWorkloadArgv]),
        plan: input.plan,
        createReceipt,
      });
    },

    async cleanupIncompleteCreate(input) {
      if (
        input.plan.schemaVersion !== MANAGED_BOOTSTRAP_SCHEMA_VERSION ||
        input.plan.driverId !== PODMAN_DRIVER_ID
      ) {
        throw new Error("Managed bootstrap Podman cleanup received another driver.");
      }
      assertManagedBootstrapIdentity(input.bootstrapIdentity);
      const ids = findPodmanManagedSandboxContainerIds(
        authority.socketPath,
        input.plan.sandboxName,
        deps,
      );
      if (ids.length !== 1) {
        throw new Error(
          `Managed bootstrap Podman cleanup requires exactly one held workload; found ${String(ids.length)}.`,
        );
      }
      const runtimeId = ids[0] as string;
      const inspect = inspectExactPodmanManagedSandbox(
        {
          containerId: runtimeId,
          sandboxName: input.plan.sandboxName,
          socketAuthority: authority.socketAuthority,
          socketPath: authority.socketPath,
        },
        deps,
      );
      assertImage(inspect, input.plan.image);
      assertHeldCommand(inspect, input.heldWorkloadArgv, input.bootstrapIdentity);
      return ownerCleanupRequired(
        {
          sandboxName: input.plan.sandboxName,
          sandboxId: inspect.sandboxId,
          runtimeId,
        },
        authority,
        dependencies,
      );
    },

    async discoverHeldWorkload(input) {
      if (input.sandbox.driverId !== PODMAN_DRIVER_ID) {
        throw new Error("Managed bootstrap Podman adapter received another runtime driver.");
      }
      if (Object.keys(input.metadata).length > 0) {
        throw new Error("Managed bootstrap Podman metadata labels are not registered.");
      }
      const ids = findPodmanManagedSandboxContainerIds(
        authority.socketPath,
        input.sandbox.sandboxName,
        deps,
      );
      if (ids.length !== 1) {
        throw new Error(
          `Managed bootstrap Podman discovery requires exactly one held workload; found ${String(ids.length)}.`,
        );
      }
      const runtimeId = ids[0] as string;
      const inspect = inspectExact(
        input.sandbox.sandboxName,
        input.sandbox.sandboxId,
        runtimeId,
        authority,
        dependencies,
      );
      assertImage(inspect, input.expectedImage);
      return Object.freeze({
        sandbox: input.sandbox,
        runtimeId,
        bootstrapIdentity: input.bootstrapIdentity,
      });
    },

    async inspectHeldWorkload({ handle, discovered }) {
      if (
        discovered.bootstrapIdentity !== handle.bootstrapIdentity ||
        discovered.sandbox.sandboxId !== handle.sandbox.sandboxId ||
        discovered.runtimeId.length !== 64
      ) {
        throw new Error("Managed bootstrap Podman identity changed before inspection.");
      }
      const firstInspect = inspectExact(
        handle.sandbox.sandboxName,
        handle.sandbox.sandboxId,
        discovered.runtimeId,
        authority,
        dependencies,
      );
      assertImage(firstInspect, handle.plan.image);
      assertHeldCommand(firstInspect, handle.heldWorkloadArgv, handle.bootstrapIdentity);
      const first = capturePodmanManagedSandboxLaunchSnapshot(
        {
          containerId: discovered.runtimeId,
          gpuAttachment: dependencies.gpuAttachment,
          sandboxId: handle.sandbox.sandboxId,
          sandboxName: handle.sandbox.sandboxName,
          socketAuthority: authority.socketAuthority,
          socketPath: authority.socketPath,
        },
        deps,
      );
      const second = capturePodmanManagedSandboxLaunchSnapshot(
        {
          containerId: discovered.runtimeId,
          gpuAttachment: dependencies.gpuAttachment,
          sandboxId: handle.sandbox.sandboxId,
          sandboxName: handle.sandbox.sandboxName,
          socketAuthority: authority.socketAuthority,
          socketPath: authority.socketPath,
        },
        deps,
      );
      if (first.hash !== second.hash || first.canonicalJson !== second.canonicalJson) {
        throw new Error("Managed bootstrap Podman launch spec changed during stable capture.");
      }
      const supervisor = supervisorArgv(second.inspect);
      if (!exactArrayEqual(supervisor, handle.plan.expectedSupervisorArgv)) {
        throw new Error("Managed bootstrap Podman supervisor argv changed before replacement.");
      }
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        runtimeId: discovered.runtimeId,
        bootstrapIdentity: handle.bootstrapIdentity,
        image: handle.plan.image,
        runtimeImageContentId: assertImage(second.inspect, handle.plan.image),
        specHash: second.hash,
        specCanonicalJson: second.canonicalJson,
        agentIdentity: Object.freeze({ ...handle.plan.agentIdentity }),
        supervisorArgv: supervisor,
        heldWorkloadArgv: handle.heldWorkloadArgv,
        metadata: handle.plan.metadata,
      });
    },

    async replaceForBootstrap({ handle, snapshot, request, replacementOptions: rawOptions }) {
      if (
        snapshot.bootstrapIdentity !== handle.bootstrapIdentity ||
        snapshot.runtimeId.length !== 64 ||
        request.agent !== handle.plan.profile.agent ||
        request.profileFingerprint !== handle.plan.profile.fingerprint
      ) {
        throw new Error("Managed bootstrap Podman replacement identities do not match.");
      }
      const options = replacementOptions(rawOptions.values, authority);
      const recreation = recreatePodmanManagedSandbox(
        {
          command: handle.intendedWorkloadArgv,
          gpuAttachment: options.gpuAttachment,
          requiredUlimits: options.requiredUlimits,
          sandboxName: handle.sandbox.sandboxName,
          socketAuthority: authority.socketAuthority,
          socketPath: authority.socketPath,
          transactionIdentity: handle.bootstrapIdentity,
          watcherController: authority.watcherController,
        },
        deps,
      );
      if (
        recreation.oldContainerId !== snapshot.runtimeId ||
        recreation.originalSemanticDigest !== snapshot.specHash ||
        recreation.immutableImage !== snapshot.runtimeImageContentId
      ) {
        transactions.set(handle.bootstrapIdentity, { recreation, managedStartup: null });
        throw new Error("Managed bootstrap Podman recreation changed the captured workload.");
      }
      let managedStartup: PodmanManagedStartupTransaction | null = null;
      transactions.set(handle.bootstrapIdentity, { recreation, managedStartup });
      try {
        managedStartup = applyPodmanManagedStartupRootRequest(
          {
            bootstrapIdentity: handle.bootstrapIdentity,
            containerId: recreation.newContainerId,
            request,
            socketAuthority: authority.socketAuthority,
            socketPath: authority.socketPath,
          },
          deps,
        );
        transactions.set(handle.bootstrapIdentity, { recreation, managedStartup });
      } catch (error) {
        managedStartup = getPodmanManagedStartupFailureTransaction(error);
        transactions.set(handle.bootstrapIdentity, { recreation, managedStartup });
        throw error;
      }
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        originalRuntimeId: snapshot.runtimeId,
        replacementRuntimeId: recreation.newContainerId,
        image: snapshot.image,
        runtimeImageContentId: snapshot.runtimeImageContentId,
        originalSpecHash: snapshot.specHash,
        replacementSpecHash: recreation.semanticDigest,
        profileFingerprint: handle.plan.profile.fingerprint,
      });
    },

    async awaitBootstrap({ handle, snapshot, replacement, timeoutSecs }) {
      const transaction = transactions.get(handle.bootstrapIdentity);
      if (
        !transaction ||
        replacement.originalRuntimeId !== snapshot.runtimeId ||
        replacement.replacementRuntimeId !== transaction.recreation.newContainerId ||
        replacement.replacementSpecHash !== transaction.recreation.semanticDigest
      ) {
        throw new Error("Managed bootstrap Podman completion identities do not match.");
      }
      const timeout = resolveSupervisorReconnectTimeoutSecs(timeoutSecs);
      if (
        !waitForSupervisorReconnect(handle.sandbox.sandboxName, timeout, {
          runCaptureOpenshell: dependencies.runCaptureOpenshell,
          runOpenshell: dependencies.runOpenshell,
          sleep: dependencies.sleep,
        })
      ) {
        throw new Error("Managed bootstrap Podman supervisor did not reconnect.");
      }
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        runtimeId: replacement.replacementRuntimeId,
        image: replacement.image,
        runtimeImageContentId: replacement.runtimeImageContentId,
        originalSpecHash: replacement.originalSpecHash,
        replacementSpecHash: replacement.replacementSpecHash,
        profileFingerprint: replacement.profileFingerprint,
        bootstrapIdentity: replacement.bootstrapIdentity,
        transactionPending: transaction.managedStartup !== null,
        completedAt: now().toISOString(),
      } satisfies ManagedBootstrapCompletionReceipt);
    },

    async finalizeBootstrap(input) {
      const { handle, snapshot } = input;
      if (input.outcome === "rollback") {
        return rollback(
          handle,
          snapshot?.runtimeId ??
            findPodmanManagedSandboxContainerIds(
              authority.socketPath,
              handle.sandbox.sandboxName,
              deps,
            )[0] ??
            "",
        );
      }
      const transaction = transactions.get(handle.bootstrapIdentity);
      const completion = input.completion;
      const replacement = input.replacement;
      if (!transaction || !completion || !replacement || !snapshot) {
        throw new Error("Managed bootstrap Podman commit requires one complete transaction.");
      }
      if (!durablyCommitted.has(handle.bootstrapIdentity) && transaction.managedStartup) {
        const shared = finalizePodmanManagedStartupSharedState(
          {
            containerRollbackAuthority: transaction.recreation,
            supervisorReady: true,
            transaction: transaction.managedStartup,
          },
          deps,
        );
        if (shared.failure || !shared.supervisorReady) {
          throw shared.failure ?? new Error("Managed bootstrap Podman shared-state commit failed.");
        }
        durablyCommitted.add(handle.bootstrapIdentity);
      }
      let outcome: ReturnType<typeof finalizePodmanManagedSandbox>;
      try {
        outcome = finalizePodmanManagedSandbox(
          { replacementReady: true, transaction: transaction.recreation },
          deps,
        );
      } catch (error) {
        if (durablyCommitted.has(handle.bootstrapIdentity)) {
          throw new ManagedBootstrapDurableCommitCleanupPendingError({
            bootstrapIdentity: handle.bootstrapIdentity,
            cleanupRuntimeId: transaction.recreation.backupContainerId,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
      if (!outcome.backupRemoved) {
        throw new ManagedBootstrapDurableCommitCleanupPendingError({
          bootstrapIdentity: handle.bootstrapIdentity,
          cleanupRuntimeId: transaction.recreation.backupContainerId,
          detail: "exact Podman rollback-backup absence was not proven",
        });
      }
      transactions.delete(handle.bootstrapIdentity);
      durablyCommitted.delete(handle.bootstrapIdentity);
      committed.add(handle.bootstrapIdentity);
      return Object.freeze({
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: handle.sandbox,
        bootstrapIdentity: handle.bootstrapIdentity,
        outcome: "committed",
        restoredRuntimeId: null,
        restoredSpecHash: null,
        heldWorkloadRemoved: false,
        alreadyRolledBack: false,
        finalizedAt: now().toISOString(),
      } satisfies ManagedBootstrapFinalizationReceipt);
    },
  };
}
