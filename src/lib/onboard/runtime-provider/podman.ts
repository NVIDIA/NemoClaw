// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PodmanBoundContainerEngine, PodmanContainerEngine } from "../../adapters/podman";
import { validatePodmanSandboxGpuPreflight } from "../sandbox-gpu-preflight";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderManagedImageBootstrapSurface,
  type RuntimeProviderCleanupInput,
  type RuntimeProviderLifecycleInput,
  type RuntimeProviderLifecycleResult,
  type RuntimeProviderMutationOperation,
  type RuntimeProviderWorkloadProfile,
} from "./contract";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceRouteAuthorityStore,
} from "./host-local-inference";
import {
  createFilePersistedEngineAuthorityStore,
  type PersistedEngineAuthorityStore,
} from "./persisted-engine-authority";
import {
  createPodmanHostLocalInferenceOperation,
  type PodmanExternalInferenceNetworkAuthority,
  type PodmanHostLocalInferenceOperationOptions,
  type PodmanInferenceFailureEvidence,
  type PodmanPublishedResumeTiming,
  type PodmanInferenceRedactor,
} from "./podman-host-local-inference";
import type {
  PodmanInferenceAuthorityReceipt,
  PodmanInferenceQualificationOptions,
} from "./podman-preflight";
import {
  PODMAN_LIFECYCLE_MUTATION_TIMEOUT_MS,
  recoverPodmanSandbox,
  startPodmanSandbox,
  stopPodmanSandbox,
} from "./podman-lifecycle";
import { createPodmanPrivilegedSandboxControl } from "./podman-privileged-sandbox-control";
import {
  inspectPodmanHost,
  type PodmanHostPreflightOptions,
  qualifyPodmanHost,
} from "./podman-preflight";
import {
  createCurrentPodmanOperationEngine,
  capturePodmanDestroyIdentity,
  capturePodmanDestroyIdentityByName,
  createFilePodmanRouteAuthorityStore,
  createPodmanRuntimeProviderSnapshotSurface,
  type NativePodmanGatewayHostPreparationDeps,
  planOwnedPodmanWorkloadCleanup,
  prepareNativePodmanGatewayHostRuntime,
  removeOwnedPodmanWorkload,
  resolveNativePodmanSocketPath,
} from "./podman-runtime-surfaces";
import { resolvePodmanStateRoot } from "./podman-state-root";

export interface PodmanRuntimeProviderEngines {
  readonly hostDoctor: PodmanContainerEngine;
  readonly gatewayInspection?: PodmanBoundContainerEngine;
  readonly hostLocalInference?: PodmanContainerEngine;
  readonly managedBootstrap?: PodmanBoundContainerEngine;
  readonly sandboxLifecycle: PodmanContainerEngine;
  readonly workloadCleanup?: PodmanBoundContainerEngine;
}

export interface PodmanHostLocalInferenceOptions {
  readonly authorityStore: PersistedEngineAuthorityStore;
  readonly routeAuthorityStore: HostLocalInferenceRouteAuthorityStore;
  readonly onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void;
  readonly redactSensitive: PodmanInferenceRedactor;
  readonly externalNetwork?: PodmanExternalInferenceNetworkAuthority;
  readonly authority?: PodmanInferenceAuthorityReceipt;
  readonly authorityQualification?: PodmanInferenceQualificationOptions;
  readonly hermesPortablePublishedEngineAuthority?: PodmanHostLocalInferenceOperationOptions["hermesPortablePublishedEngineAuthority"];
  readonly hermesPortablePublishedRecoveryOperation?: {
    readonly operation: HostLocalInferenceOperation;
    readonly environment: NodeJS.ProcessEnv;
  };
  readonly publishedResumeTiming?: PodmanPublishedResumeTiming;
}

export interface PodmanRuntimeProviderOptions {
  readonly engines: PodmanRuntimeProviderEngines;
  readonly environment?: NodeJS.ProcessEnv;
  readonly gatewaySocketPath?: string;
  readonly gatewayHostPreparation?: NativePodmanGatewayHostPreparationDeps;
  readonly hostLocalInference?: PodmanHostLocalInferenceOptions;
  readonly preflight?: PodmanHostPreflightOptions;
}

const QUALIFIED_MANAGED_WORKLOAD_PROFILE = {
  support: {
    exactDigestReferences: true,
    platforms: MANAGED_IMAGE_PLATFORMS,
    startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
    capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
  },
  hostArchitectures: ["amd64", "arm64"],
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: false,
} as const satisfies RuntimeProviderWorkloadProfile;

function acceptsManagedWorkloadReceipt(
  receipt: RuntimeProviderCleanupInput["sandbox"]["workload"],
): boolean {
  if (receipt?.kind !== "managed-image" || receipt.platform === undefined) return false;
  const support = QUALIFIED_MANAGED_WORKLOAD_PROFILE.support;
  return (
    support.platforms.includes(receipt.platform) &&
    support.capabilityContractVersions.includes(receipt.capabilityContractVersion) &&
    support.startupProfileContractVersions.includes(receipt.startupProfileContractVersion)
  );
}

export const PODMAN_READ_ONLY_HOST_MOUNT_UNSUPPORTED_REASON =
  "Read-only host mounts are not qualified for the Podman runtime provider.";

function unsupported(providerId: string, reason: string) {
  return { providerId, supported: false as const, reason };
}

function createLazyPodmanManagedBootstrapSurface(
  engine: PodmanBoundContainerEngine,
): RuntimeProviderManagedImageBootstrapSurface {
  const surface = (): RuntimeProviderManagedImageBootstrapSurface => {
    const { createPodmanManagedBootstrapSurface } =
      require("../managed-bootstrap/podman-runtime") as typeof import("../managed-bootstrap/podman-runtime");
    return createPodmanManagedBootstrapSurface(engine);
  };
  return Object.freeze({
    providerId: "podman",
    supported: true,
    bootstrapKind: "managed-image",
    createAuthorityStore: (
      input: Parameters<RuntimeProviderManagedImageBootstrapSurface["createAuthorityStore"]>[0],
    ) => surface().createAuthorityStore(input),
    createLifecycle: (
      input: Parameters<RuntimeProviderManagedImageBootstrapSurface["createLifecycle"]>[0],
    ) => surface().createLifecycle(input),
    createOnboardRouting: (
      input: Parameters<RuntimeProviderManagedImageBootstrapSurface["createOnboardRouting"]>[0],
    ) => surface().createOnboardRouting(input),
  });
}

function requireEngine(
  engine: PodmanContainerEngine,
  operation:
    | "host-doctor"
    | "gateway-inspection"
    | "host-local-inference"
    | "managed-bootstrap"
    | "sandbox-lifecycle"
    | "workload-cleanup",
): void {
  if (engine.engineId !== "podman" || engine.operation !== operation) {
    throw new Error(`Podman provider requires a '${operation}' Podman engine.`);
  }
}

function preflightLifecycle(
  input: RuntimeProviderLifecycleInput,
  engine: PodmanContainerEngine,
  options: PodmanHostPreflightOptions,
): RuntimeProviderLifecycleResult | null {
  try {
    qualifyPodmanHost(engine, options);
    return null;
  } catch (error) {
    return {
      exitCode: 1,
      message: `  ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Construct the Podman provider from explicitly scoped operation authorities. */
export function createPodmanRuntimeProviderBundle(
  options: PodmanRuntimeProviderOptions,
): RuntimeProviderBundle {
  const providerId = "podman";
  const {
    hostDoctor,
    gatewayInspection,
    hostLocalInference: inferenceEngine,
    managedBootstrap,
    sandboxLifecycle,
    workloadCleanup,
  } = options.engines;
  const inferenceOptions = options.hostLocalInference;
  const publishedRecoveryOperation = inferenceOptions?.hermesPortablePublishedRecoveryOperation;
  const containerEngineOperations = new Map([
    ["host-doctor", hostDoctor],
    ...(gatewayInspection ? ([["gateway-inspection", gatewayInspection]] as const) : []),
    ...(inferenceEngine ? ([["host-local-inference", inferenceEngine]] as const) : []),
    ["sandbox-lifecycle", sandboxLifecycle],
    ...(workloadCleanup ? ([["workload-cleanup", workloadCleanup]] as const) : []),
  ] as const);
  requireEngine(hostDoctor, "host-doctor");
  requireEngine(sandboxLifecycle, "sandbox-lifecycle");
  const providerEndpointAuthority = hostDoctor.endpointAuthorityId;
  if (providerEndpointAuthority !== sandboxLifecycle.endpointAuthorityId) {
    throw new Error("Podman provider engines must bind the same endpoint authority.");
  }
  if ((inferenceEngine === undefined) !== (inferenceOptions === undefined)) {
    throw new Error(
      "Podman provider requires its host-local inference engine and stores together.",
    );
  }
  if (inferenceEngine !== undefined) {
    requireEngine(inferenceEngine, "host-local-inference");
    if (inferenceEngine.endpointAuthorityId !== providerEndpointAuthority) {
      throw new Error("Podman provider engines must bind the same endpoint authority.");
    }
  }
  if (
    publishedRecoveryOperation &&
    (!inferenceOptions?.hermesPortablePublishedEngineAuthority ||
      publishedRecoveryOperation.operation.providerId !== providerId ||
      publishedRecoveryOperation.operation.engine.operation !== "host-local-inference" ||
      publishedRecoveryOperation.operation.engine.engineId !== inferenceEngine?.engineId ||
      !publishedRecoveryOperation.operation.assertTransactionCurrent)
  ) {
    throw new Error("Podman published recovery operation authority is incomplete.");
  }
  for (const [engine, operation] of [
    [gatewayInspection, "gateway-inspection"],
    [managedBootstrap, "managed-bootstrap"],
    [workloadCleanup, "workload-cleanup"],
  ] as const) {
    if (!engine) continue;
    requireEngine(engine, operation);
    if (engine.endpointAuthorityId !== providerEndpointAuthority) {
      throw new Error("Podman provider engines must bind the same endpoint authority.");
    }
  }
  const preflight = options.preflight ?? {};
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const deferred = "This operation is intentionally deferred to a later Podman slice.";

  return {
    identity: {
      contractVersion: RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
      id: providerId,
      displayName: "Podman",
    },
    plan: { providerId, supported: true, gatewayLauncher: "nemoclaw" },
    capabilities: {
      providerId,
      supported: true,
      hostLocalInference: inferenceEngine !== undefined,
      directLifecycle: true,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: workloadCleanup !== undefined,
      readOnlyHostMounts: {
        supported: false,
        reason: PODMAN_READ_ONLY_HOST_MOUNT_UNSUPPORTED_REASON,
      },
    },
    preflightDoctor: {
      providerId,
      supported: true,
      inspectHost: () => inspectPodmanHost(hostDoctor, preflight),
      validateSandboxGpu: (config, exitProcess) =>
        validatePodmanSandboxGpuPreflight(config, {}, exitProcess),
      preflightLifecycle: (_action, input) => preflightLifecycle(input, hostDoctor, preflight),
    },
    gateway: {
      providerId,
      supported: true,
      launcher: "nemoclaw",
      inspectLegacyContainer: false,
      prepareHostRuntime: (input) => {
        if (
          options.gatewaySocketPath !== undefined &&
          input.socketPath !== undefined &&
          resolveNativePodmanSocketPath(input.environment, input.socketPath) !==
            options.gatewaySocketPath
        ) {
          throw new Error("Native Podman gateway socket differs from its bundle authority.");
        }
        return prepareNativePodmanGatewayHostRuntime(
          {
            ...input,
            socketPath: options.gatewaySocketPath ?? input.socketPath,
          },
          gatewayInspection,
          options.gatewayHostPreparation,
        );
      },
    },
    workload: {
      providerId,
      supported: true,
      profile: QUALIFIED_MANAGED_WORKLOAD_PROFILE,
      managedStateMountDriverId: "podman",
      acceptsReceipt: acceptsManagedWorkloadReceipt,
    },
    hostLocalInference:
      inferenceEngine !== undefined && inferenceOptions !== undefined
        ? {
            providerId,
            supported: true,
            services: ["ollama", "nim", "vllm"],
            createOperation: ({ env, acceleration }) => {
              if (publishedRecoveryOperation) {
                if (
                  env !== publishedRecoveryOperation.environment ||
                  acceleration !== "nvidia-gpu"
                ) {
                  throw new Error("Podman published recovery operation input changed.");
                }
                publishedRecoveryOperation.operation.assertTransactionCurrent!();
                return publishedRecoveryOperation.operation;
              }
              return createPodmanHostLocalInferenceOperation({
                engine: inferenceEngine,
                env,
                acceleration,
                authorityStore: inferenceOptions.authorityStore,
                routeAuthorityStore: inferenceOptions.routeAuthorityStore,
                onFailureEvidence: inferenceOptions.onFailureEvidence,
                redactSensitive: inferenceOptions.redactSensitive,
                ...(inferenceOptions.externalNetwork
                  ? { externalNetwork: inferenceOptions.externalNetwork }
                  : {}),
                ...(inferenceOptions.authority ? { authority: inferenceOptions.authority } : {}),
                ...(inferenceOptions.authorityQualification
                  ? { authorityQualification: inferenceOptions.authorityQualification }
                  : {}),
                ...(inferenceOptions.hermesPortablePublishedEngineAuthority
                  ? {
                      hermesPortablePublishedEngineAuthority:
                        inferenceOptions.hermesPortablePublishedEngineAuthority,
                    }
                  : {}),
                ...(inferenceOptions.publishedResumeTiming
                  ? { publishedResumeTiming: inferenceOptions.publishedResumeTiming }
                  : {}),
              });
            },
          }
        : unsupported(
            providerId,
            "Podman host-local inference remains disabled without injected candidate authority.",
          ),
    lifecycle: {
      providerId,
      supported: true,
      channelStopTransport: "openshell",
      containerMutationTimeoutMs: PODMAN_LIFECYCLE_MUTATION_TIMEOUT_MS,
      privilegedSandboxControl: createPodmanPrivilegedSandboxControl(
        sandboxLifecycle,
        workloadCleanup,
      ),
      start: (input) => startPodmanSandbox(input, sandboxLifecycle),
      verifyStarted: (input, verifyGateway) => verifyGateway(input.sandboxName),
      stop: (input, hooks) => stopPodmanSandbox(input, hooks, sandboxLifecycle),
    },
    mutationAuthority: {
      providerId,
      supported: true,
      operations: ["start", "stop"],
    },
    bootstrap:
      managedBootstrap === undefined
        ? unsupported(providerId, deferred)
        : createLazyPodmanManagedBootstrapSurface(managedBootstrap),
    snapshot:
      gatewayInspection === undefined
        ? unsupported(providerId, deferred)
        : createPodmanRuntimeProviderSnapshotSurface(gatewayInspection),
    recovery: {
      providerId,
      supported: true,
      recover: (sandbox) =>
        recoverPodmanSandbox(
          {
            environment,
            log: () => undefined,
            sandbox,
            sandboxName: sandbox.name,
          },
          sandboxLifecycle,
        ),
    },
    cleanup:
      workloadCleanup === undefined
        ? unsupported(providerId, deferred)
        : {
            providerId,
            supported: true,
            ...(gatewayInspection
              ? {
                  captureDestroyIdentity: (input: RuntimeProviderCleanupInput) =>
                    capturePodmanDestroyIdentity(input, gatewayInspection),
                  captureDestroyIdentityByName: (sandboxName: string) =>
                    capturePodmanDestroyIdentityByName(sandboxName, gatewayInspection),
                }
              : {}),
            prepareDestroy: (_input, operations) => operations.detachProviders(),
            planOwnedWorkloadCleanup: planOwnedPodmanWorkloadCleanup,
            removeOwnedWorkload: (input) => removeOwnedPodmanWorkload(input, workloadCleanup),
          },
    containerEngine: {
      providerId,
      supported: true,
      identities: [
        {
          operation: "host-doctor",
          engineId: hostDoctor.engineId,
          displayName: hostDoctor.displayName,
        },
        ...(gatewayInspection
          ? [
              {
                operation: "gateway-inspection" as const,
                engineId: gatewayInspection.engineId,
                displayName: gatewayInspection.displayName,
              },
            ]
          : []),
        ...(inferenceEngine
          ? [
              {
                operation: "host-local-inference" as const,
                engineId: inferenceEngine.engineId,
                displayName: inferenceEngine.displayName,
              },
            ]
          : []),
        {
          operation: "sandbox-lifecycle",
          engineId: sandboxLifecycle.engineId,
          displayName: sandboxLifecycle.displayName,
        },
        ...(workloadCleanup
          ? [
              {
                operation: "workload-cleanup" as const,
                engineId: workloadCleanup.engineId,
                displayName: workloadCleanup.displayName,
              },
            ]
          : []),
      ],
      capture: (operation, args, timeoutMs) => {
        const engine = containerEngineOperations.get(operation);
        if (!engine) {
          throw new Error(`Podman provider does not register the '${operation}' engine operation.`);
        }
        return engine.capture(args, timeoutMs);
      },
    },
  };
}

function redactPodmanFailure(environment: NodeJS.ProcessEnv, value: string): string {
  let redacted = value;
  for (const key of ["NGC_API_KEY", "NIM_NGC_API_KEY"] as const) {
    const secret = environment[key];
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function createLazyPersistedEngineAuthorityStore(stateRoot: string): PersistedEngineAuthorityStore {
  let store: PersistedEngineAuthorityStore | null = null;
  const resolve = () => (store ??= createFilePersistedEngineAuthorityStore(stateRoot));
  return Object.freeze({
    load: (operation: Parameters<PersistedEngineAuthorityStore["load"]>[0]) =>
      resolve().load(operation),
    record: (authority: Parameters<PersistedEngineAuthorityStore["record"]>[0]) =>
      resolve().record(authority),
  });
}

/** Production Podman bundle selected only at the managed registration boundary. */
export function createCurrentPodmanRuntimeProviderBundle(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeProviderBundle {
  const stateRoot = resolvePodmanStateRoot(environment.HOME);
  const engines = {
    hostDoctor: createCurrentPodmanOperationEngine("host-doctor", environment),
    gatewayInspection: createCurrentPodmanOperationEngine("gateway-inspection", environment),
    hostLocalInference: createCurrentPodmanOperationEngine("host-local-inference", environment),
    managedBootstrap: createCurrentPodmanOperationEngine("managed-bootstrap", environment),
    sandboxLifecycle: createCurrentPodmanOperationEngine("sandbox-lifecycle", environment),
    workloadCleanup: createCurrentPodmanOperationEngine("workload-cleanup", environment),
  } as const;
  const bundle = createPodmanRuntimeProviderBundle({
    engines,
    environment,
    gatewaySocketPath: resolveNativePodmanSocketPath(environment),
    gatewayHostPreparation: {},
    hostLocalInference: {
      authorityStore: createLazyPersistedEngineAuthorityStore(stateRoot),
      routeAuthorityStore: createFilePodmanRouteAuthorityStore(stateRoot),
      onFailureEvidence: (evidence) => {
        console.error(
          redactPodmanFailure(environment, `Podman ${evidence.phase}: ${evidence.message}`),
        );
      },
      redactSensitive: (value) => redactPodmanFailure(environment, value),
    },
  });
  return Object.freeze({
    ...bundle,
    mutationAuthority: Object.freeze({
      providerId: "podman",
      supported: true,
      operations: Object.freeze([
        "registration",
        "start",
        "stop",
        "inference-set",
        "rebuild",
        "clone",
        "provider-cleanup",
        "destroy",
        "workload-cleanup",
      ] satisfies readonly RuntimeProviderMutationOperation[]),
    }),
  });
}
