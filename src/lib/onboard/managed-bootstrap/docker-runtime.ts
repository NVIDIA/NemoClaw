// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerImageInspect } from "../../adapters/docker/inspect";
import { dockerPullWithProgressWatchdog } from "../../adapters/docker/pull";
import { hasZeroDockerExitStatus } from "../docker-command-result";
import { createDockerGpuDiagnosticRedactor } from "../docker-gpu-diagnostic-redaction";
import { detectTegraDeviceGroupGids } from "../docker-gpu-jetson-groups";
import { buildDockerGpuMode, selectDockerGpuPatchMode } from "../docker-gpu-patch-mode";
import type { DockerGpuPatchMode, DockerGpuPatchModeAttempt } from "../docker-gpu-patch-types";
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
import type { RuntimeProviderManagedImageBootstrapSurface } from "../runtime-provider/contract";
import * as sandboxGpuCreateAttempt from "../sandbox-gpu-create-attempt";
import {
  activateManagedBootstrapSequence,
  finalizeManagedBootstrapSequence,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  prepareManagedBootstrapSequence,
  recoverManagedBootstrapTransactions,
} from "./adapter";
import { createDockerManagedBootstrapAdapter } from "./docker";
import { createDockerManagedBootstrapAuthorityStore } from "./docker-authority-store";
import type {
  ManagedBootstrapRuntimeCompatibilityLaunchInput,
  ManagedBootstrapRuntimeCreateLaunchResult,
  ManagedBootstrapRuntimeCreateLifecycle,
  ManagedBootstrapRuntimeCreateLifecycleInput,
  ManagedBootstrapRuntimeOnboardRoutingInput,
} from "./runtime-create";
import { createManagedBootstrapTerminalFinalizer } from "./runtime-create";

const MANAGED_BOOTSTRAP_IMAGE_INSPECT_TIMEOUT_MS = 30_000;
const MANAGED_BOOTSTRAP_IMAGE_PULL_MAX_TIMEOUT_MS = 30 * 60 * 1000;

function dockerReplacementOptions(
  mode: DockerGpuPatchMode,
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
) {
  const backend = input.sandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic";
  return {
    values: {
      gpuModeArgs: [...mode.args],
      gpuModeDevice: mode.device,
      gpuModeKind: mode.kind,
      gpuModeLabel: mode.label,
      requiredUlimits: input.requiredLimits.map(
        (limit) => `${limit.name}=${limit.soft}:${limit.hard}`,
      ),
      extraGroupGids:
        backend === "jetson" && input.route === "compatibility" ? detectTegraDeviceGroupGids() : [],
    },
  };
}

function managedBootstrapImageReference(
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
): string {
  return `${input.image.repository}@${input.image.manifestDigest}`;
}

async function prepareDockerManagedBootstrapGpuProbeImage(image: string): Promise<void> {
  const inspected = dockerImageInspect(image, {
    ignoreError: true,
    suppressOutput: true,
    timeout: MANAGED_BOOTSTRAP_IMAGE_INSPECT_TIMEOUT_MS,
  });
  if (hasZeroDockerExitStatus(inspected)) return;

  console.log("  Pulling managed sandbox image before Docker GPU mode selection...");
  const pulled = await dockerPullWithProgressWatchdog(image, {
    maxTimeoutMs: MANAGED_BOOTSTRAP_IMAGE_PULL_MAX_TIMEOUT_MS,
  });
  if (pulled.status === 0 && !pulled.timedOut && !pulled.error) return;

  const reason = pulled.timedOut
    ? pulled.timeoutKind === "stall"
      ? "stalled without progress"
      : "exceeded the 30-minute safety limit"
    : pulled.error
      ? `could not start (${pulled.error.message})`
      : `exited with status ${String(pulled.status)}`;
  throw new Error(`Docker managed sandbox image pull failed before GPU mode selection: ${reason}.`);
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
      image: managedBootstrapImageReference(input),
      device: input.sandboxGpuConfig.sandboxGpuDevice,
      backend,
      dockerDesktopWsl,
      ...(dockerDesktopWsl ? { pullPolicy: "never" as const } : {}),
    },
    input.dependencies,
  );
  if (selection.mode) return selection.mode;
  const message =
    backend === "jetson"
      ? "Docker did not accept the Jetson NVIDIA runtime GPU mode for managed bootstrap."
      : "Docker did not accept a compatibility GPU mode for managed bootstrap.";
  throw new Error(`${message}${formatDockerGpuModeFailureDetails(selection.attempts)}`);
}

export function formatDockerGpuModeFailureDetails(
  attempts: readonly DockerGpuPatchModeAttempt[],
): string {
  const redactor = createDockerGpuDiagnosticRedactor();
  const failures = attempts
    .filter((attempt) => !attempt.ok && attempt.error)
    .map(
      (attempt) =>
        `${attempt.mode.label}: ${redactor.redactText(attempt.error ?? "docker create failed").slice(0, 240)}`,
    );
  return failures.length > 0 ? ` Attempts: ${failures.join("; ")}`.slice(0, 1_200) : "";
}

function createDockerLifecycle(
  providerId: string,
  input: ManagedBootstrapRuntimeCreateLifecycleInput,
): ManagedBootstrapRuntimeCreateLifecycle {
  if (input.providerId !== providerId) {
    throw new Error(
      `Managed bootstrap provider '${providerId}' cannot run authority for '${input.providerId}'.`,
    );
  }
  const dockerDesktopWsl =
    input.route === "compatibility" ? isDockerDesktopWslRuntime() : undefined;
  const preselectedMode = dockerDesktopWsl ? null : selectedDockerMode(input, dockerDesktopWsl);
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
            onPatchFailureExit: (_sandboxName: string, error: unknown) =>
              input.onPatchFailure?.(error),
          },
        }
      : {}),
  });
  const adapter =
    input.adapterOverride ??
    createDockerManagedBootstrapAdapter({ ...input.dependencies, stateRoot: input.stateRoot });
  const createPlan = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: input.sandboxName,
    driverId: providerId,
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
  let activatedRuntimeId: string | null = null;

  return {
    launchArgv: input.launchArgv,
    patch,
    inspectNativeRuntime() {
      if (activatedRuntimeId === null) return undefined;
      const snapshot = queryOpenShellDockerSandboxRuntimeSnapshot(
        input.sandboxName,
        {},
        { expectedContainerId: activatedRuntimeId },
      );
      return snapshot.ok
        ? {
            imageId: snapshot.imageId,
            bookkeepingImageRef: snapshot.bookkeepingImageRef,
            stateError: snapshot.stateError,
            nativeGpuAttachmentState: snapshot.nativeGpuAttachmentState,
          }
        : null;
    },
    async recoverUnfinished() {
      return recoverManagedBootstrapTransactions(adapter);
    },
    async prepareNetwork() {
      if (input.route !== "compatibility") return;
      const { enforceDockerGpuPatchPreserveNetwork } =
        await import("../docker-gpu-local-inference");
      await enforceDockerGpuPatchPreserveNetwork(
        input.network.inferenceProvider,
        input.sandboxGpuConfig,
        {
          dockerDriverGateway: input.network.gatewayUsesContainerBridge,
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
      if (
        dockerDesktopWsl &&
        input.route === "compatibility" &&
        input.sandboxGpuConfig.sandboxGpuEnabled
      ) {
        await prepareDockerManagedBootstrapGpuProbeImage(managedBootstrapImageReference(input));
      }
      const mode = preselectedMode ?? selectedDockerMode(input, dockerDesktopWsl);
      const replacementOptions = dockerReplacementOptions(mode, input);
      const launchState: { value?: ManagedBootstrapRuntimeCreateLaunchResult<T> } = {};
      const prepared = await prepareManagedBootstrapSequence(adapter, {
        create: {
          bootstrapIdentity: input.bootstrapIdentity,
          plan: createPlan,
          request: input.request,
          launch: async (launchInput) => {
            const launched = await launch(launchInput);
            launchState.value = launched;
            return launched.receipt;
          },
        },
        request: input.request,
        replacementOptions,
      });
      const activated = await activateManagedBootstrapSequence(adapter, {
        transaction: prepared,
        authorityStore: input.authorityStore,
        timeoutSecs: input.timeoutSecs,
      });
      activatedRuntimeId = activated.replacement.replacementRuntimeId;
      const launched = launchState.value;
      if (!launched) {
        await finalizeManagedBootstrapSequence(adapter, {
          outcome: "rollback",
          transaction: activated,
        });
        throw new Error("Managed bootstrap did not return its OpenShell create receipt.");
      }
      const finalizer = createManagedBootstrapTerminalFinalizer((outcome) =>
        finalizeManagedBootstrapSequence(adapter, {
          outcome,
          transaction: activated,
        }).then(() => undefined),
      );
      patch.attachManagedBootstrapCutover({
        selectedMode: mode,
        failureContext: {
          sandboxName: input.sandboxName,
          oldContainerId: activated.snapshot.runtimeId,
          newContainerId: activated.replacement.replacementRuntimeId,
          backupContainerName: null,
          selectedMode: mode,
        },
        rollback: finalizer.rollback,
        commit: finalizer.commit,
      });
      return launched.value;
    },
  };
}

function createDockerOnboardRouting(input: ManagedBootstrapRuntimeOnboardRoutingInput) {
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
      sandboxGpuCreateAttempt.isNativeGpuCreateRoutingFailure(output, { sawProgress }),
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
          : compatibility.managedImageReference);
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

/** Complete Docker bootstrap surface selected only through a runtime bundle. */
export function createDockerManagedBootstrapSurface(
  providerId = "docker",
): RuntimeProviderManagedImageBootstrapSurface {
  return {
    providerId,
    supported: true,
    bootstrapKind: "managed-image",
    createAuthorityStore: ({ stateRoot }) => createDockerManagedBootstrapAuthorityStore(stateRoot),
    createLifecycle: (input) => createDockerLifecycle(providerId, input),
    createOnboardRouting: createDockerOnboardRouting,
  };
}
