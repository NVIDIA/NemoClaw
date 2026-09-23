// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureHostCommand } from "../../actions/sandbox/doctor-host-command";
import { dockerCapture, dockerRun } from "../../adapters/docker/run";
import {
  DEFAULT_GATEWAY_BIND_ADDRESS,
  getGatewayConnectHost,
  parseGatewayBindAddress,
} from "../../core/gateway-address";
import { parseDockerDaemonObservation } from "../../domain/docker-host";
import {
  DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
  parseDockerNetworkIpamEntries,
  resolveDockerDriverNetworkName,
} from "../experimental/docker-network-authority";
import { queryOpenShellDockerSandboxRuntimeSnapshot } from "../openshell-docker-sandbox-containers";
import { validateSandboxGpuPreflight } from "../sandbox-gpu-preflight";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
  type RuntimeProviderBundle,
  type RuntimeProviderCleanupInput,
  type RuntimeProviderCommandCapture,
  type RuntimeProviderContainerEngineOperation,
  type RuntimeProviderNvidiaContainerInput,
  type RuntimeProviderOwnedContainerCleanupOptions,
  type RuntimeProviderDoctorCheck,
  type RuntimeProviderWorkloadCleanupPlan,
  type RuntimeProviderWorkloadCleanupResult,
  type RuntimeProviderWorkloadProfile,
} from "./contract";
import { createDockerLlamaCppHostLocalOperation } from "./docker-llama-cpp-operation";
import { createDockerPrivilegedSandboxControl } from "./docker-privileged-sandbox-control";
import { cleanupOwnedContainer, ownedContainerRunArguments } from "./owned-container-resource";
import { createDockerRuntimeProviderSnapshotSurface } from "./snapshot";

type DockerRemoveImage = (
  reference: string,
  options?: { ignoreError?: boolean; timeout?: number },
) => { status: number | null };

export interface DockerRuntimeProviderDependencies {
  readonly captureHostCommand: (
    command: string,
    args: string[],
    timeout?: number,
  ) => RuntimeProviderCommandCapture;
  readonly queryRuntimeSnapshot: typeof queryOpenShellDockerSandboxRuntimeSnapshot;
  readonly removeImage: DockerRemoveImage;
}

const DOCKER_OPERATION_TIMEOUT_MS = 30_000;

function inspectDockerGatewayNetwork(networkName: string) {
  const raw = dockerCapture(
    ["network", "inspect", "--format", DOCKER_NETWORK_IPAM_INSPECT_FORMAT, networkName],
    { ignoreError: true },
  );
  for (const entry of parseDockerNetworkIpamEntries(raw) ?? []) {
    if (entry.gatewayIp && !entry.gatewayIp.includes(":")) return entry;
  }
  return undefined;
}

function dockerGatewayUsesHostGatewayRoute(): boolean {
  if (process.platform !== "linux") return true;
  const info = dockerCapture(
    ["info", "--format", "{{.OperatingSystem}}\n{{range .Labels}}{{.}}\n{{end}}"],
    { ignoreError: true },
  );
  return /Docker Desktop|com\.docker\.desktop\./iu.test(info);
}

function runDockerGatewayCommand(
  args: readonly string[],
  timeoutMs: number,
  options?: { maxOutputBytes: number; environment?: Record<string, string> },
) {
  const result = dockerRun([...args], {
    ...(options
      ? {
          maxBuffer: options.maxOutputBytes,
          killSignal: "SIGKILL" as const,
          env: options.environment,
        }
      : {}),
    timeout: timeoutMs,
    ignoreError: true,
    suppressOutput: true,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    status: result.status ?? null,
    signal: result.signal,
    error: error?.message,
    errorCode: error?.code ?? null,
    timedOut: error?.code === "ETIMEDOUT",
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function ensureDockerGatewayProbeImageCached(image: string) {
  const inspect = runDockerGatewayCommand(["image", "inspect", image], 10_000);
  if (inspect.status === 0) return { ok: true as const, alreadyCached: true };
  if (inspect.status === null || inspect.errorCode) {
    return {
      ok: false as const,
      reason: "inspect_unavailable" as const,
      details: inspect.error ?? String(inspect.stderr ?? "").trim(),
    };
  }
  const pull = runDockerGatewayCommand(["pull", image], 120_000);
  if (pull.status === 0) return { ok: true as const, alreadyCached: false };
  return {
    ok: false as const,
    reason: pull.timedOut ? ("pull_timeout" as const) : ("pull_failed" as const),
    details: pull.error ?? String(pull.stderr ?? "").trim(),
  };
}

function captureDockerContainerEngineOperation(
  deps: DockerRuntimeProviderDependencies,
  supportedOperations: ReadonlySet<RuntimeProviderContainerEngineOperation>,
  operation: RuntimeProviderContainerEngineOperation,
  args: readonly string[],
  timeoutMs?: number,
): RuntimeProviderCommandCapture {
  if (!supportedOperations.has(operation)) {
    throw new Error(`Docker provider does not register the '${operation}' engine operation.`);
  }
  return deps.captureHostCommand("docker", [...args], timeoutMs);
}

function captureDockerNvidiaContainer(
  deps: DockerRuntimeProviderDependencies,
  supportedOperations: ReadonlySet<RuntimeProviderContainerEngineOperation>,
  operation: RuntimeProviderContainerEngineOperation,
  input: RuntimeProviderNvidiaContainerInput,
  timeoutMs?: number,
): RuntimeProviderCommandCapture {
  return captureDockerContainerEngineOperation(
    deps,
    supportedOperations,
    operation,
    [
      "run",
      "--rm",
      ...ownedContainerRunArguments(input.resource),
      "--gpus",
      "all",
      "--entrypoint",
      input.entrypoint,
      input.image,
      ...input.command,
    ],
    timeoutMs,
  );
}

function cleanupDockerNvidiaContainer(
  deps: DockerRuntimeProviderDependencies,
  supportedOperations: ReadonlySet<RuntimeProviderContainerEngineOperation>,
  operation: RuntimeProviderContainerEngineOperation,
  resource: RuntimeProviderNvidiaContainerInput["resource"],
  options: RuntimeProviderOwnedContainerCleanupOptions,
) {
  return cleanupOwnedContainer(
    resource,
    `^/${resource.name}$`,
    (args, timeout) =>
      captureDockerContainerEngineOperation(deps, supportedOperations, operation, args, timeout),
    options,
  );
}

function loadDockerRemoveImage(): DockerRemoveImage {
  return (require("../../adapters/docker") as { dockerRmi: DockerRemoveImage }).dockerRmi;
}

function resolveDependencies(
  overrides: Partial<DockerRuntimeProviderDependencies> = {},
): DockerRuntimeProviderDependencies {
  return {
    captureHostCommand:
      overrides.captureHostCommand ??
      ((command, args, timeout) => captureHostCommand(command, args, timeout)),
    queryRuntimeSnapshot:
      overrides.queryRuntimeSnapshot ?? queryOpenShellDockerSandboxRuntimeSnapshot,
    removeImage:
      overrides.removeImage ??
      ((reference, options) => loadDockerRemoveImage()(reference, options)),
  };
}

function oneLine(value = ""): string {
  return value.replace(/\s+/gu, " ").trim();
}

function inspectDockerHost(deps: DockerRuntimeProviderDependencies): RuntimeProviderDoctorCheck {
  const result = deps.captureHostCommand("docker", ["info", "--format", "{{json .}}"], 8000);
  const observation = parseDockerDaemonObservation(result.stdout);
  const reachable = result.status === 0 && observation.reachable;
  return {
    group: "Host",
    label: "Docker daemon",
    status: reachable ? "ok" : "fail",
    detail: reachable
      ? `server ${observation.serverVersion ?? "unknown"}`
      : oneLine(result.stderr || result.error?.message || "docker info failed"),
    hint: reachable ? undefined : "start Docker and verify your user can access the daemon",
  };
}

function planOwnedDockerWorkloadCleanup(
  input: RuntimeProviderCleanupInput,
): RuntimeProviderWorkloadCleanupPlan {
  const { imageTag, workload } = input.sandbox;
  if (workload?.shared === true) return { action: "retain", reason: "shared-image" };
  if (!imageTag) return { action: "retain", reason: "no-owned-image" };
  if (
    Object.values(MANAGED_IMAGE_REPOSITORIES).some(
      (repository) =>
        imageTag === repository ||
        imageTag.startsWith(`${repository}@`) ||
        imageTag.startsWith(`${repository}:`),
    )
  ) {
    return { action: "retain", reason: "shared-image" };
  }
  if (
    workload?.kind === "legacy-dockerfile" &&
    workload.reference !== null &&
    workload.reference !== imageTag
  ) {
    return { action: "block", reason: "authority-unproven" };
  }
  return { action: "remove", engineDisplayName: "Docker", reference: imageTag };
}

function removeOwnedDockerWorkload(
  input: RuntimeProviderCleanupInput,
  deps: DockerRuntimeProviderDependencies,
): RuntimeProviderWorkloadCleanupResult {
  const plan = planOwnedDockerWorkloadCleanup(input);
  if (plan.action === "retain") return { status: "skipped", reason: plan.reason };
  if (plan.action === "block") {
    return { status: "skipped", reason: "authority-unproven" };
  }
  const result = deps.removeImage(plan.reference, {
    ignoreError: true,
    timeout: DOCKER_OPERATION_TIMEOUT_MS,
  });
  return {
    status: result.status === 0 ? "removed" : "failed",
    engineDisplayName: plan.engineDisplayName,
    reference: plan.reference,
  };
}

const COMPLETE_MANAGED_IMAGE_V1_PROFILE = {
  support: {
    exactDigestReferences: true,
    platforms: MANAGED_IMAGE_PLATFORMS,
    startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
    capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
  },
  hostArchitectures: ["amd64", "arm64"],
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: true,
} as const satisfies RuntimeProviderWorkloadProfile;

function acceptsReceipt(
  profile: RuntimeProviderWorkloadProfile,
  receipt: RuntimeProviderCleanupInput["sandbox"]["workload"],
): boolean {
  if (!receipt) return true;
  if (receipt.kind === "legacy-dockerfile") return profile.legacyDockerfileBuilds;
  if (receipt.kind === "native-artifact") return false;
  if (receipt.platform === undefined) return false;
  return (
    profile.support !== null &&
    profile.support.platforms.includes(receipt.platform) &&
    profile.support.capabilityContractVersions.includes(receipt.capabilityContractVersion) &&
    profile.support.startupProfileContractVersions.includes(receipt.startupProfileContractVersion)
  );
}

function unsupported(providerId: string, reason: string) {
  return { providerId, supported: false as const, reason };
}

export function createDockerRuntimeProviderBundle(
  overrides: Partial<DockerRuntimeProviderDependencies> = {},
): RuntimeProviderBundle {
  const providerId = "docker";
  const deps = resolveDependencies(overrides);
  const containerEngineOperations = new Set<RuntimeProviderContainerEngineOperation>([
    "host-doctor",
    "gateway-inspection",
    "host-local-inference",
    "sandbox-lifecycle",
    "workload-cleanup",
  ]);
  const futureReason = "This operation is intentionally deferred to a later provider slice.";
  const projectGatewayHostRuntime: RuntimeProviderBundle["gateway"]["prepareHostRuntime"] = (
    input,
  ) => {
    const bindAddress = parseGatewayBindAddress(
      "NEMOCLAW_GATEWAY_BIND_ADDRESS",
      DEFAULT_GATEWAY_BIND_ADDRESS,
      input.environment,
    );
    const connectHost = getGatewayConnectHost(bindAddress);
    return {
      providerId,
      openShellDriver: "docker",
      bindAddress,
      grpcHost: connectHost,
      sshGatewayHost: connectHost,
      portCheckHost: bindAddress,
      socketPath: null,
      requiredServerIpSans: [],
      sandboxHostAddress: null,
      usesHostGatewayRoute: false,
      resourceOwnership: {
        label: "openshell.ai/managed-by",
        value: "openshell",
      },
      gatewayConfig: {
        sandboxNamespace: "scoped",
        hostGatewayIp: null,
        includeSupervisorBin: true,
        processOwnership: "scoped-namespace",
      },
      network: {
        sandboxSourceCidrs: () => {
          const network = inspectDockerGatewayNetwork(
            resolveDockerDriverNetworkName(input.environment),
          );
          return network?.subnet ? [network.subnet] : [];
        },
        inspect: inspectDockerGatewayNetwork,
        usesHostGatewayRoute: dockerGatewayUsesHostGatewayRoute,
        run: runDockerGatewayCommand,
        ensureProbeImageCached: ensureDockerGatewayProbeImageCached,
      },
    };
  };
  return {
    identity: {
      contractVersion: RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
      id: providerId,
      displayName: "Docker",
    },
    plan: { providerId, supported: true, gatewayLauncher: "nemoclaw" },
    capabilities: {
      providerId,
      supported: true,
      hostLocalInference: true,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: true,
      readOnlyHostMounts: { supported: true, hostPlatforms: ["linux"] },
    },
    preflightDoctor: {
      providerId,
      supported: true,
      inspectHost: () => inspectDockerHost(deps),
      validateSandboxGpu: (config, exitProcess) =>
        validateSandboxGpuPreflight(config, {}, exitProcess),
      preflightLifecycle: () => null,
    },
    gateway: {
      providerId,
      supported: true,
      launcher: "nemoclaw",
      inspectLegacyContainer: false,
      finalSandboxLiveness: "openshell-and-docker",
      ownsHostReadiness: false,
      observeHostRuntime: projectGatewayHostRuntime,
      prepareHostRuntime: projectGatewayHostRuntime,
    },
    workload: {
      providerId,
      supported: true,
      profile: COMPLETE_MANAGED_IMAGE_V1_PROFILE,
      managedStateMountDriverId: "docker",
      acceptsReceipt: (receipt) => acceptsReceipt(COMPLETE_MANAGED_IMAGE_V1_PROFILE, receipt),
    },
    hostLocalInference: {
      providerId,
      supported: true,
      services: ["llama-cpp"],
      createOperation: ({ env }) => createDockerLlamaCppHostLocalOperation(env),
    },
    lifecycle: {
      providerId,
      supported: true,
      channelStopTransport: "docker-kubectl-first",
      containerMutationTimeoutMs: DOCKER_OPERATION_TIMEOUT_MS,
      privilegedSandboxControl: createDockerPrivilegedSandboxControl(),
    },
    mutationAuthority: {
      providerId,
      supported: true,
      operations: [
        "registration",
        "inference-set",
        "rebuild",
        "clone",
        "provider-cleanup",
        "destroy",
        "workload-cleanup",
      ],
    },
    bootstrap: unsupported(providerId, "OpenShell owns managed-image sandbox creation."),
    snapshot: createDockerRuntimeProviderSnapshotSurface(providerId, {
      captureHostCommand: deps.captureHostCommand,
      queryRuntimeSnapshot: deps.queryRuntimeSnapshot,
    }),
    recovery: unsupported(providerId, futureReason),
    cleanup: {
      providerId,
      supported: true,
      prepareDestroy: (_input, operations) => operations.detachProviders(),
      planOwnedWorkloadCleanup: planOwnedDockerWorkloadCleanup,
      removeOwnedWorkload: (input) => removeOwnedDockerWorkload(input, deps),
    },
    containerEngine: {
      providerId,
      supported: true,
      identities: [
        { operation: "host-doctor", engineId: "docker", displayName: "Docker" },
        { operation: "gateway-inspection", engineId: "docker", displayName: "Docker" },
        { operation: "host-local-inference", engineId: "docker", displayName: "Docker" },
        { operation: "sandbox-lifecycle", engineId: "docker", displayName: "Docker" },
        { operation: "workload-cleanup", engineId: "docker", displayName: "Docker" },
      ],
      capture: (operation, args, timeoutMs) =>
        captureDockerContainerEngineOperation(
          deps,
          containerEngineOperations,
          operation,
          args,
          timeoutMs,
        ),
      nvidiaContainer: {
        capture: (operation, input, timeoutMs) =>
          captureDockerNvidiaContainer(
            deps,
            containerEngineOperations,
            operation,
            input,
            timeoutMs,
          ),
        cleanup: (operation, resource, options) =>
          cleanupDockerNvidiaContainer(
            deps,
            containerEngineOperations,
            operation,
            resource,
            options,
          ),
      },
    },
  };
}

export function createKubernetesRuntimeProviderBundle(
  overrides: Partial<DockerRuntimeProviderDependencies> = {},
): RuntimeProviderBundle {
  const providerId = "kubernetes";
  const deps = resolveDependencies(overrides);
  const containerEngineOperations = new Set<RuntimeProviderContainerEngineOperation>([
    "host-doctor",
    "gateway-inspection",
    "workload-cleanup",
  ]);
  const futureReason = "This operation is intentionally deferred to a later provider slice.";
  const profile = {
    support: null,
    hostArchitectures: [],
    managedImageSelectionPolicy: "prefer-managed",
    legacyDockerfileBuilds: true,
  } as const satisfies RuntimeProviderWorkloadProfile;
  return {
    identity: {
      contractVersion: RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
      id: providerId,
      displayName: "Kubernetes",
    },
    plan: { providerId, supported: true, gatewayLauncher: "openshell" },
    capabilities: {
      providerId,
      supported: true,
      hostLocalInference: false,
      legacyGatewayContainerInspection: true,
      workloadImageCleanup: true,
      readOnlyHostMounts: {
        supported: false,
        reason:
          "Kubernetes hostPath semantics have not passed NemoClaw security and lifecycle qualification.",
      },
    },
    preflightDoctor: {
      providerId,
      supported: true,
      inspectHost: () => inspectDockerHost(deps),
      validateSandboxGpu: (config, exitProcess) =>
        validateSandboxGpuPreflight(config, {}, exitProcess),
      preflightLifecycle: () => null,
    },
    gateway: {
      providerId,
      supported: true,
      launcher: "openshell",
      inspectLegacyContainer: true,
      finalSandboxLiveness: "openshell-and-docker",
      ownsHostReadiness: false,
      observeHostRuntime: () => {
        throw new Error("The Kubernetes provider does not launch a host-managed gateway.");
      },
      prepareHostRuntime: () => {
        throw new Error("The Kubernetes provider does not launch a host-managed gateway.");
      },
    },
    workload: {
      providerId,
      supported: true,
      profile,
      acceptsReceipt: (receipt) => acceptsReceipt(profile, receipt),
    },
    hostLocalInference: unsupported(
      providerId,
      "Kubernetes does not provide the managed llama.cpp host-local-inference lifecycle.",
    ),
    lifecycle: unsupported(
      providerId,
      "Direct local lifecycle control is unavailable for the Kubernetes provider.",
    ),
    mutationAuthority: {
      providerId,
      supported: true,
      operations: [
        "registration",
        "inference-set",
        "rebuild",
        "provider-cleanup",
        "destroy",
        "workload-cleanup",
      ],
    },
    bootstrap: unsupported(providerId, futureReason),
    snapshot: unsupported(providerId, futureReason),
    recovery: unsupported(providerId, futureReason),
    cleanup: {
      providerId,
      supported: true,
      prepareDestroy: (_input, operations) => operations.detachProviders(),
      // The shipped Kubernetes gateway path has always built and retained its
      // per-sandbox image in the host Docker engine. Keep that established
      // engine ownership explicit until a CRI-native provider is registered.
      planOwnedWorkloadCleanup: planOwnedDockerWorkloadCleanup,
      removeOwnedWorkload: (input) => removeOwnedDockerWorkload(input, deps),
    },
    containerEngine: {
      providerId,
      supported: true,
      identities: [
        { operation: "host-doctor", engineId: "docker", displayName: "Docker" },
        { operation: "gateway-inspection", engineId: "docker", displayName: "Docker" },
        { operation: "workload-cleanup", engineId: "docker", displayName: "Docker" },
      ],
      capture: (operation, args, timeoutMs) =>
        captureDockerContainerEngineOperation(
          deps,
          containerEngineOperations,
          operation,
          args,
          timeoutMs,
        ),
    },
  };
}
