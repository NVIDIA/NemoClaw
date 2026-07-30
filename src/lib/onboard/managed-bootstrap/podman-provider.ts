// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolvePodmanGpuAttachment } from "../compute/podman/gpu-attachment";
import {
  attachManagedBootstrapRollbackError,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  runManagedBootstrapSequence,
} from "./adapter";
import { createPodmanManagedBootstrapAdapter } from "./podman";
import type {
  ManagedBootstrapRuntimeCreateLaunchResult,
  ManagedBootstrapRuntimeCreateLifecycle,
  ManagedBootstrapRuntimeCreateLifecycleInput,
  ManagedBootstrapRuntimePatch,
  ManagedBootstrapRuntimeProvider,
} from "./runtime-provider";

function podmanReplacementOptions(
  intent: Parameters<ManagedBootstrapRuntimeProvider["createReplacementOptions"]>[0],
) {
  const enabled = intent.acceleration.strategy === "cdi";
  return {
    values: {
      gpuDevice: intent.acceleration.device,
      gpuEnabled: enabled,
      requiredUlimits: intent.limits.map(
        (limit) => `${limit.name}:${String(limit.soft)}:${String(limit.hard)}`,
      ),
    },
  };
}

function createPodmanCreateLifecycle(
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
): ManagedBootstrapRuntimeCreateLifecycle {
  if (input.route !== "native") {
    throw new Error("Managed bootstrap Podman does not implement a Docker compatibility route.");
  }
  const attachment = resolvePodmanGpuAttachment(
    input.sandboxGpuConfig.sandboxGpuEnabled,
    input.sandboxGpuConfig.sandboxGpuDevice,
  );
  const acceleration = attachment
    ? {
        strategy: "cdi",
        label: "NVIDIA CDI",
        device: attachment.device,
        arguments: ["--device", attachment.device],
      }
    : {
        strategy: "startup-command",
        label: "managed startup",
        device: "none",
        arguments: [],
      };
  const adapter =
    input.adapterOverride ??
    createPodmanManagedBootstrapAdapter({
      ...input.dependencies,
      gpuAttachment: attachment,
    });
  const createPlan = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: input.sandboxName,
    driverId: "podman",
    image: input.image,
    profile: {
      agent: input.request.agent,
      fingerprint: input.request.profileFingerprint,
    },
    agentIdentity: input.agentIdentity,
    intendedWorkloadArgv: input.intendedWorkloadArgv,
    expectedSupervisorArgv: input.expectedSupervisorArgv,
    metadata: {},
  } as const;
  const replacementOptions = podmanReplacementOptions({
    acceleration,
    limits: input.requiredLimits,
    supplementaryGroupIds: [],
  });
  let sequence: Awaited<ReturnType<typeof runManagedBootstrapSequence>> | null = null;
  let finalized = false;

  const patch: ManagedBootstrapRuntimePatch = {
    maybeApplyDuringCreate() {},
    createFailureMessage: () => null,
    exitOnPatchError() {},
    async rollbackManagedStartupAfterCreateFailure() {
      if (!sequence || finalized) return;
      await adapter.finalizeBootstrap({
        outcome: "rollback",
        ...sequence,
      });
      finalized = true;
    },
    ensureApplied() {
      if (!sequence) {
        throw new Error("Managed bootstrap Podman did not complete its provider transaction.");
      }
    },
    waitForSupervisorReconnectIfNeeded() {},
    async commitAfterReady() {
      if (!sequence || finalized) return;
      await adapter.finalizeBootstrap({
        outcome: "commit",
        ...sequence,
      });
      finalized = true;
    },
    selectedMode: () =>
      attachment
        ? {
            kind: acceleration.strategy,
            label: acceleration.label,
            device: acceleration.device,
            args: acceleration.arguments,
          }
        : null,
    printReadinessFailureIfEnabled() {},
    async verifyGpuOrExit(verifyDirectSandboxGpu) {
      return verifyDirectSandboxGpu(input.sandboxName);
    },
  };

  return {
    launchArgv: input.launchArgv,
    patch,
    async prepareNetwork() {},
    async runCreate<T>(
      launch: (launchInput: {
        readonly heldWorkloadArgv: readonly string[];
        readonly bootstrapIdentity: string;
      }) => Promise<ManagedBootstrapRuntimeCreateLaunchResult<T>>,
    ): Promise<T> {
      const launchState: { value?: ManagedBootstrapRuntimeCreateLaunchResult<T> } = {};
      let attemptedLaunch:
        | {
            readonly heldWorkloadArgv: readonly string[];
            readonly bootstrapIdentity: string;
          }
        | undefined;
      try {
        sequence = await runManagedBootstrapSequence(adapter, {
          create: {
            bootstrapIdentity: input.bootstrapIdentity,
            plan: createPlan,
            request: input.request,
            launch: async (launchInput) => {
              attemptedLaunch = launchInput;
              const launched = await launch(launchInput);
              launchState.value = launched;
              return launched.receipt;
            },
          },
          request: input.request,
          replacementOptions,
          timeoutSecs: input.timeoutSecs,
        });
      } catch (error) {
        if (launchState.value || !attemptedLaunch) throw error;
        const failure = error instanceof Error ? error : new Error(String(error));
        try {
          await adapter.cleanupIncompleteCreate({
            plan: createPlan,
            bootstrapIdentity: attemptedLaunch.bootstrapIdentity,
            heldWorkloadArgv: attemptedLaunch.heldWorkloadArgv,
          });
        } catch (cleanupError) {
          attachManagedBootstrapRollbackError(failure, cleanupError);
        }
        throw failure;
      }
      const launched = launchState.value;
      if (!launched) {
        throw new Error("Managed bootstrap Podman did not return its OpenShell create receipt.");
      }
      return launched.value;
    },
  };
}

function createPodmanOnboardRouting() {
  return {
    nativeFallbackHasCleanBaseline: false,
    inspectNativeRuntime: () => null,
    isNativeCreateRoutingFailure: () => false,
    isTrustedNativeRuntimeError: () => false,
    isNativeReadinessRoutingFailure: () => false,
    prepareCompatibilityLaunch(): never {
      throw new Error("Managed bootstrap Podman has no Docker compatibility fallback.");
    },
  };
}

export const PODMAN_MANAGED_BOOTSTRAP_RUNTIME_PROVIDER = Object.freeze({
  driverId: "podman",
  createAdapter: (dependencies = {}) => createPodmanManagedBootstrapAdapter(dependencies),
  createReplacementOptions: podmanReplacementOptions,
  createCreateLifecycle: createPodmanCreateLifecycle,
  createOnboardRouting: createPodmanOnboardRouting,
} satisfies ManagedBootstrapRuntimeProvider);
