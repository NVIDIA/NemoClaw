// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { detectTegraDeviceGroupGids } from "../docker-gpu-jetson-groups";
import { buildDockerGpuMode, selectDockerGpuPatchMode } from "../docker-gpu-patch-mode";
import type { DockerGpuPatchMode } from "../docker-gpu-patch-types";
import { renderCompatibilityFallbackCreateArgs } from "../docker-gpu-route";
import {
  createDockerGpuSandboxCreatePatch,
  isDockerDesktopWslRuntime,
} from "../docker-gpu-sandbox-create";
import {
  isImmutableDockerImageId,
  queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot,
} from "../openshell-docker-sandbox-containers";
import * as sandboxGpuCreateAttempt from "../sandbox-gpu-create-attempt";
import { MANAGED_BOOTSTRAP_SCHEMA_VERSION, runManagedBootstrapSequence } from "./adapter";
import { createDockerManagedBootstrapAdapter } from "./docker";
import {
  type ManagedBootstrapRuntimeCompatibilityLaunchInput,
  type ManagedBootstrapRuntimeCreateLaunchResult,
  type ManagedBootstrapRuntimeCreateLifecycle,
  type ManagedBootstrapRuntimeCreateLifecycleInput,
  type ManagedBootstrapRuntimeProvider,
  type ManagedBootstrapRuntimeProviderRegistry,
  resolveManagedBootstrapRuntimeProvider,
} from "./runtime-provider";

function dockerReplacementOptions(
  intent: Parameters<ManagedBootstrapRuntimeProvider["createReplacementOptions"]>[0],
) {
  return {
    values: {
      gpuModeArgs: [...intent.acceleration.arguments],
      gpuModeDevice: intent.acceleration.device,
      gpuModeKind: intent.acceleration.strategy,
      gpuModeLabel: intent.acceleration.label,
      requiredUlimits: intent.limits.map((limit) => `${limit.name}=${limit.soft}:${limit.hard}`),
      extraGroupGids: [...intent.supplementaryGroupIds],
    },
  };
}

function selectedDockerMode(
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
  dockerDesktopWsl: boolean | undefined,
): DockerGpuPatchMode {
  const backend = input.sandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic";
  if (input.route !== "compatibility" || !input.sandboxGpuConfig.sandboxGpuEnabled) {
    return buildDockerGpuMode("startup-command");
  }
  const selection = selectDockerGpuPatchMode(
    {
      image: `${input.image.repository}@${input.image.manifestDigest}`,
      device: input.sandboxGpuConfig.sandboxGpuDevice,
      backend,
      dockerDesktopWsl,
    },
    input.dependencies,
  );
  if (selection.mode) return selection.mode;
  throw new Error(
    backend === "jetson"
      ? "Docker did not accept the Jetson NVIDIA runtime GPU mode for managed bootstrap."
      : "Docker did not accept a compatibility GPU mode for managed bootstrap.",
  );
}

function createDockerCreateLifecycle(
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
): ManagedBootstrapRuntimeCreateLifecycle {
  const dockerDesktopWsl =
    input.route === "compatibility" ? isDockerDesktopWslRuntime() : undefined;
  const mode = selectedDockerMode(input, dockerDesktopWsl);
  const backend = input.sandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic";
  const persistStartupCommand =
    input.persistStartupCommand && (input.route !== "native" || input.requiredLimits.length > 0);
  const patch = createDockerGpuSandboxCreatePatch({
    route: input.route,
    persistStartupCommand,
    externalRecreation: true,
    sandboxName: input.sandboxName,
    gpuDevice: input.sandboxGpuConfig.sandboxGpuDevice,
    openshellSandboxCommand: input.heldWorkloadArgv,
    requiredUlimits: input.requiredLimits,
    timeoutSecs: input.timeoutSecs,
    backend,
    dockerDesktopWsl,
    deps: input.dependencies,
    ...(input.onPatchFailure
      ? {
          overrides: {
            onPatchFailureExit: (_sandboxName, error) => input.onPatchFailure?.(error),
          },
        }
      : {}),
  });
  const adapter = input.adapterOverride ?? createDockerManagedBootstrapAdapter(input.dependencies);
  const createPlan = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: input.sandboxName,
    driverId: "docker",
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
  const replacementOptions = dockerReplacementOptions({
    acceleration: {
      strategy: mode.kind,
      label: mode.label,
      device: mode.device,
      arguments: mode.args,
    },
    limits: input.requiredLimits,
    supplementaryGroupIds:
      backend === "jetson" && input.route === "compatibility" ? detectTegraDeviceGroupGids() : [],
  });

  return {
    launchArgv: input.launchArgv,
    patch,
    async prepareNetwork() {
      if (input.route !== "compatibility") return;
      const { enforceDockerGpuPatchPreserveNetwork } = await import(
        "../docker-gpu-local-inference"
      );
      await enforceDockerGpuPatchPreserveNetwork(
        input.network.inferenceProvider,
        input.sandboxGpuConfig,
        {
          dockerDriverGateway: input.network.dockerDriverGateway,
          selectedRoute: input.route,
          gatewayPort: input.network.gatewayPort,
          log: console.log,
        },
      );
    },
    async runCreate<T>(
      launch: (input: {
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
      let sequence: Awaited<ReturnType<typeof runManagedBootstrapSequence>>;
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
          const rollback = await adapter.cleanupIncompleteCreate({
            plan: createPlan,
            bootstrapIdentity: attemptedLaunch.bootstrapIdentity,
            heldWorkloadArgv: attemptedLaunch.heldWorkloadArgv,
          });
          (
            failure as Error & {
              managedBootstrapRollback?: Awaited<
                ReturnType<typeof adapter.cleanupIncompleteCreate>
              >;
            }
          ).managedBootstrapRollback = rollback;
        } catch (cleanupError) {
          (
            failure as Error & { managedBootstrapRollbackError?: unknown }
          ).managedBootstrapRollbackError = cleanupError;
        }
        throw failure;
      }
      const launched = launchState.value;
      if (!launched) {
        throw new Error("Managed bootstrap did not return its OpenShell create receipt.");
      }
      let finalized = false;
      patch.attachManagedBootstrapCutover({
        selectedMode: mode,
        failureContext: {
          sandboxName: input.sandboxName,
          oldContainerId: sequence.snapshot.runtimeId,
          newContainerId: sequence.replacement.replacementRuntimeId,
          backupContainerName: null,
          selectedMode: mode,
        },
        async rollback() {
          if (finalized) return;
          await adapter.finalizeBootstrap({
            outcome: "rollback",
            ...sequence,
          });
          finalized = true;
        },
        async commit() {
          if (finalized) return;
          await adapter.finalizeBootstrap({
            outcome: "commit",
            ...sequence,
          });
          finalized = true;
        },
      });
      return launched.value;
    },
  };
}

function createDockerOnboardRouting(input: {
  readonly sandboxName: string;
  readonly openshellArgv: (args: string[]) => string[];
  readonly nativeFallbackEnabled: boolean;
}) {
  const baseline = input.nativeFallbackEnabled
    ? queryOpenShellDockerSandboxContainers(input.sandboxName)
    : null;
  const inspectNativeRuntime = () => {
    const snapshot = queryOpenShellDockerSandboxRuntimeSnapshot(input.sandboxName);
    return snapshot.ok
      ? {
          imageId: snapshot.imageId,
          bookkeepingImageRef: snapshot.bookkeepingImageRef,
          stateError: snapshot.stateError,
          nativeGpuAttachmentState: snapshot.nativeGpuAttachmentState,
        }
      : null;
  };
  return {
    nativeFallbackHasCleanBaseline: baseline?.ok === true && baseline.ids.length === 0,
    inspectNativeRuntime,
    isNativeCreateRoutingFailure: (output: string, sawProgress: boolean): boolean =>
      sandboxGpuCreateAttempt.isNativeGpuCreateRoutingFailure(output, {
        sawProgress,
      }),
    isTrustedNativeRuntimeError: (error: string): boolean =>
      sandboxGpuCreateAttempt.isTrustedNativeGpuRuntimeError(error),
    isNativeReadinessRoutingFailure: (failure: {
      readonly failurePhase: string | null;
      readonly runtimeError: string;
    }): boolean => sandboxGpuCreateAttempt.isNativeGpuReadinessRoutingFailure(failure),
    prepareCompatibilityLaunch: (
      compatibility: ManagedBootstrapRuntimeCompatibilityLaunchInput,
    ) => {
      const runtime = compatibility.runtimeSnapshot;
      const imageId =
        runtime?.imageId ??
        (compatibility.prebuildImageId && isImmutableDockerImageId(compatibility.prebuildImageId)
          ? compatibility.prebuildImageId.toLowerCase()
          : null);
      let registryImageRef = compatibility.currentRegistryImageRef;
      if (
        !registryImageRef &&
        runtime?.bookkeepingImageRef &&
        !isImmutableDockerImageId(runtime.bookkeepingImageRef)
      ) {
        registryImageRef = runtime.bookkeepingImageRef;
      }
      const createArgs = renderCompatibilityFallbackCreateArgs(compatibility.createArgs, {
        imageRef: imageId,
        allowUnbuiltSource: compatibility.allowUnbuiltSource,
        compatibilityPolicyPath: compatibility.compatibilityPolicyPath,
      });
      return {
        createArgv: input.openshellArgv([
          "sandbox",
          "create",
          ...createArgs,
          "--",
          ...compatibility.startupCommand,
        ]),
        registryImageRef,
      };
    },
  };
}

export const DOCKER_MANAGED_BOOTSTRAP_RUNTIME_PROVIDER = Object.freeze({
  driverId: "docker",
  createAdapter: (dependencies = {}) => createDockerManagedBootstrapAdapter(dependencies),
  createReplacementOptions: dockerReplacementOptions,
  createCreateLifecycle: createDockerCreateLifecycle,
  createOnboardRouting: createDockerOnboardRouting,
} satisfies ManagedBootstrapRuntimeProvider);

export const CURRENT_MANAGED_BOOTSTRAP_RUNTIME_PROVIDERS = Object.freeze({
  docker: DOCKER_MANAGED_BOOTSTRAP_RUNTIME_PROVIDER,
} satisfies ManagedBootstrapRuntimeProviderRegistry);

export function resolveCurrentManagedBootstrapRuntimeProvider(
  driverName: string,
): ManagedBootstrapRuntimeProvider {
  return resolveManagedBootstrapRuntimeProvider(
    driverName,
    CURRENT_MANAGED_BOOTSTRAP_RUNTIME_PROVIDERS,
  );
}

/**
 * Older registry rows either omitted the driver or used `vm` for the local
 * Docker-backed OpenShell runtime. Preserve that persisted snapshot-clone
 * contract without registering another managed-bootstrap runtime.
 */
export function resolvePersistedManagedBootstrapRuntimeProvider(
  driverName: string | null | undefined,
): ManagedBootstrapRuntimeProvider {
  return resolveCurrentManagedBootstrapRuntimeProvider(
    driverName === undefined || driverName === null || driverName === "vm" ? "docker" : driverName,
  );
}
