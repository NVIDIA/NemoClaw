// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureHostCommand } from "../../actions/sandbox/doctor-host-command";
import { dockerCapture, dockerRun } from "../../adapters/docker/run";
import {
  DEFAULT_GATEWAY_BIND_ADDRESS,
  getGatewayConnectHost,
  parseGatewayBindAddress,
} from "../../core/gateway-address";
import {
  isDockerRuntimeDown,
  printDockerRuntimeDownGuidance,
} from "../../actions/sandbox/gateway-failure-classifier";
import { parseDockerDaemonObservation } from "../../domain/docker-host";
import { cliName } from "../branding";
import {
  findLabeledSandboxContainers,
  recoverDockerDriverSandbox,
} from "../docker-driver-sandbox-recovery";
import { createDockerManagedBootstrapSurface } from "../managed-bootstrap/docker-runtime";
import {
  DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
  parseDockerNetworkIpamEntries,
  resolveDockerDriverNetworkName,
} from "../experimental/docker-network-authority";
import {
  hasPortableAgentSandboxLifecycleReceipt,
  recoverPortableAgentSandboxLifecycle,
  stopPortableAgentSandboxLifecycle,
} from "../experimental/portable-agent-lifecycle";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
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
  type RuntimeProviderDoctorCheck,
  type RuntimeProviderLifecycleInput,
  type RuntimeProviderLifecycleResult,
  type RuntimeProviderLifecycleStopHooks,
  type RuntimeProviderLifecycleStopOutcome,
  type RuntimeProviderWorkloadCleanupPlan,
  type RuntimeProviderWorkloadCleanupResult,
  type RuntimeProviderWorkloadProfile,
} from "./contract";
import { createDockerLlamaCppHostLocalOperation } from "./docker-llama-cpp-operation";
import { createDockerStateMutationSurface } from "./docker-state-mutation";
import { createDockerPrivilegedSandboxControl } from "./docker-privileged-sandbox-control";
import { createDockerRuntimeProviderSnapshotSurface } from "./snapshot";

type DockerOpResult = { status?: number | null };
type DockerStop = (name: string, options?: Record<string, unknown>) => DockerOpResult;
type DockerUnpause = (name: string, options?: Record<string, unknown>) => DockerOpResult;
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
  readonly findLabeledSandboxContainers: typeof findLabeledSandboxContainers;
  readonly hasPortableLifecycleReceipt: typeof hasPortableAgentSandboxLifecycleReceipt;
  readonly isRuntimeDown: typeof isDockerRuntimeDown;
  readonly printRuntimeDownGuidance: typeof printDockerRuntimeDownGuidance;
  readonly recoverSandbox: typeof recoverDockerDriverSandbox;
  readonly recoverPortableSandbox: typeof recoverPortableAgentSandboxLifecycle;
  readonly queryRuntimeSnapshot: typeof queryOpenShellDockerSandboxRuntimeSnapshot;
  readonly removeImage: DockerRemoveImage;
  readonly stopContainer: DockerStop;
  readonly stopPortableSandbox: typeof stopPortableAgentSandboxLifecycle;
  readonly unpauseContainer: DockerUnpause;
  readonly withLifecycleLockSync: typeof withMcpLifecycleLockSync;
}

const DOCKER_OPERATION_TIMEOUT_MS = 30_000;
const AT_REST_STATUS_PREFIXES = ["Exited", "Created", "Dead"] as const;

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

function runDockerGatewayCommand(args: readonly string[], timeoutMs: number) {
  const result = dockerRun([...args], {
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

function loadDockerStop(): DockerStop {
  return (require("../../adapters/docker") as { dockerStop: DockerStop }).dockerStop;
}

function loadDockerUnpause(): DockerUnpause {
  return (require("../../adapters/docker") as { dockerUnpause: DockerUnpause }).dockerUnpause;
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
    findLabeledSandboxContainers:
      overrides.findLabeledSandboxContainers ?? findLabeledSandboxContainers,
    hasPortableLifecycleReceipt:
      overrides.hasPortableLifecycleReceipt ?? hasPortableAgentSandboxLifecycleReceipt,
    isRuntimeDown: overrides.isRuntimeDown ?? isDockerRuntimeDown,
    printRuntimeDownGuidance: overrides.printRuntimeDownGuidance ?? printDockerRuntimeDownGuidance,
    recoverSandbox: overrides.recoverSandbox ?? recoverDockerDriverSandbox,
    recoverPortableSandbox:
      overrides.recoverPortableSandbox ?? recoverPortableAgentSandboxLifecycle,
    queryRuntimeSnapshot:
      overrides.queryRuntimeSnapshot ?? queryOpenShellDockerSandboxRuntimeSnapshot,
    removeImage:
      overrides.removeImage ??
      ((reference, options) => loadDockerRemoveImage()(reference, options)),
    stopContainer: overrides.stopContainer ?? ((name, options) => loadDockerStop()(name, options)),
    stopPortableSandbox: overrides.stopPortableSandbox ?? stopPortableAgentSandboxLifecycle,
    unpauseContainer:
      overrides.unpauseContainer ?? ((name, options) => loadDockerUnpause()(name, options)),
    withLifecycleLockSync: overrides.withLifecycleLockSync ?? withMcpLifecycleLockSync,
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

function dockerLifecyclePreflight(
  action: "start" | "stop",
  input: RuntimeProviderLifecycleInput,
  deps: DockerRuntimeProviderDependencies,
): RuntimeProviderLifecycleResult | null {
  try {
    if (deps.hasPortableLifecycleReceipt(input.sandboxName, input.environment)) return null;
  } catch (error) {
    return {
      exitCode: 1,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!deps.isRuntimeDown(input.sandboxName)) return null;
  deps.printRuntimeDownGuidance(input.sandboxName, { retryCommand: action });
  return { exitCode: 1 };
}

function isPausedStatus(status: string): boolean {
  return status.startsWith("Up") && status.endsWith("(Paused)");
}

function isAtRestStatus(status: string): boolean {
  return AT_REST_STATUS_PREFIXES.some((prefix) => status.startsWith(prefix));
}

function startDockerSandbox(
  input: RuntimeProviderLifecycleInput,
  deps: DockerRuntimeProviderDependencies,
): RuntimeProviderLifecycleResult {
  return deps.withLifecycleLockSync(input.sandboxName, () =>
    startDockerSandboxUnlocked(input, deps),
  );
}

function startDockerSandboxUnlocked(
  input: RuntimeProviderLifecycleInput,
  deps: DockerRuntimeProviderDependencies,
): RuntimeProviderLifecycleResult {
  try {
    const portable = deps.recoverPortableSandbox(
      input.sandboxName,
      {
        agent: input.sandbox.agent,
        gatewayName: input.sandbox.gatewayName ?? "nemoclaw",
        lifecycleGeneration: input.sandbox.lifecycleGeneration,
        openshellDriver: input.sandbox.openshellDriver,
        provider: input.sandbox.provider,
      },
      {
        env: input.environment,
        log: input.log,
        readRegistry: (sandboxName) => (sandboxName === input.sandboxName ? input.sandbox : null),
      },
    );
    if (portable.kind !== "not-installed") {
      return input.sandbox.agent === "hermes"
        ? ({ exitCode: 0, hermesPortableVerified: true } as RuntimeProviderLifecycleResult & {
            readonly hermesPortableVerified: true;
          })
        : { exitCode: 0 };
    }
  } catch (error) {
    return { exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
  const containers = deps.findLabeledSandboxContainers(input.sandboxName);
  const paused = containers.find((container) => isPausedStatus(container.status));
  if (paused) {
    const result = deps.unpauseContainer(paused.name, {
      ignoreError: true,
      timeout: DOCKER_OPERATION_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      return {
        exitCode: 1,
        message: `  docker unpause ${paused.name} failed (exit ${result.status ?? "unknown"}).`,
      };
    }
    input.log(`  Container '${paused.name}' unpaused.`);
    return { exitCode: 0 };
  }

  // Docker health is an image-level signal, not the lifecycle authority for
  // `start`. Once the container is running, verifyStarted performs the
  // provider-owned OpenShell, managed gateway, and host-forward recovery.
  // Waiting for Docker health here can prevent that repair from running.
  const recovery = deps.recoverSandbox(input.sandboxName, {
    readiness: "runtime-running",
  });
  if (!recovery.recovered) {
    return {
      exitCode: 1,
      message:
        `  Could not start sandbox '${input.sandboxName}': ${recovery.detail ?? "unknown failure"}. ` +
        `If the container was removed, run '${cliName()} ${input.sandboxName} rebuild' to recreate it.`,
    };
  }
  if (recovery.via === "started-running-original") {
    input.log(`  Sandbox '${input.sandboxName}' is already running.`);
  } else {
    input.log(`  Container '${recovery.containerName ?? input.sandboxName}' started.`);
  }
  return { exitCode: 0 };
}

function stopDockerSandbox(
  input: RuntimeProviderLifecycleInput,
  hooks: RuntimeProviderLifecycleStopHooks,
  deps: DockerRuntimeProviderDependencies,
): RuntimeProviderLifecycleStopOutcome {
  return deps.withLifecycleLockSync(input.sandboxName, () =>
    stopDockerSandboxUnlocked(input, hooks, deps),
  );
}

function stopDockerSandboxUnlocked(
  input: RuntimeProviderLifecycleInput,
  hooks: RuntimeProviderLifecycleStopHooks,
  deps: DockerRuntimeProviderDependencies,
): RuntimeProviderLifecycleStopOutcome {
  try {
    const portable = deps.stopPortableSandbox(
      input.sandboxName,
      {
        agent: input.sandbox.agent,
        gatewayName: input.sandbox.gatewayName ?? "nemoclaw",
        lifecycleGeneration: input.sandbox.lifecycleGeneration,
        openshellDriver: input.sandbox.openshellDriver,
        provider: input.sandbox.provider,
      },
      hooks.beforeStop,
      {
        env: input.environment,
        log: input.log,
        readRegistry: (sandboxName) => (sandboxName === input.sandboxName ? input.sandbox : null),
      },
    );
    if (portable.kind === "already-stopped") {
      const registryHermes = input.sandbox.agent === "hermes";
      const portableHermes = portable.portableAgent === "hermes";
      if (registryHermes !== portableHermes) {
        throw new Error("Portable stop authority disagrees with the registered sandbox agent");
      }
      return portableHermes
        ? ({
            exitCode: 0,
            state: "already-stopped",
            hermesPortableVerified: true,
          } as RuntimeProviderLifecycleStopOutcome & { readonly hermesPortableVerified: true })
        : { exitCode: 0, state: "already-stopped" };
    }
    if (portable.kind === "stopped") {
      const registryHermes = input.sandbox.agent === "hermes";
      const portableHermes = portable.portableAgent === "hermes";
      if (registryHermes !== portableHermes) {
        throw new Error("Portable stop authority disagrees with the registered sandbox agent");
      }
      return portableHermes
        ? ({
            exitCode: 0,
            state: "stopped",
            hermesPortableVerified: true,
          } as RuntimeProviderLifecycleStopOutcome & { readonly hermesPortableVerified: true })
        : { exitCode: 0, state: "stopped" };
    }
  } catch (error) {
    return { exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
  const containers = deps.findLabeledSandboxContainers(input.sandboxName);
  if (containers.length === 0) {
    return {
      exitCode: 1,
      message:
        `  No Docker container found for sandbox '${input.sandboxName}'. ` +
        `If the container was removed, run '${cliName()} ${input.sandboxName} rebuild' to recreate it.`,
    };
  }

  const stoppable = containers.filter((container) => !isAtRestStatus(container.status));
  if (stoppable.length === 0) return { exitCode: 0, state: "already-stopped" };

  hooks.beforeStop();
  const failures: string[] = [];
  for (const container of stoppable) {
    input.log(`  Stopping container '${container.name}'…`);
    const result = deps.stopContainer(container.name, {
      ignoreError: true,
      timeout: DOCKER_OPERATION_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      failures.push(`${container.name} (exit ${result.status ?? "unknown"})`);
    }
  }
  if (failures.length > 0) {
    return {
      exitCode: 1,
      message: `  docker stop failed for: ${failures.join(", ")}.`,
    };
  }
  return { exitCode: 0, state: "stopped" };
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
      directLifecycle: true,
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
      preflightLifecycle: (action, input) => dockerLifecyclePreflight(action, input, deps),
    },
    gateway: {
      providerId,
      supported: true,
      launcher: "nemoclaw",
      inspectLegacyContainer: false,
      prepareHostRuntime: (input) => {
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
      },
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
      start: (input) => startDockerSandbox(input, deps),
      verifyStarted: (input, verifyGateway) => verifyGateway(input.sandboxName),
      stop: (input, hooks) => stopDockerSandbox(input, hooks, deps),
    },
    mutationAuthority: {
      providerId,
      supported: true,
      operations: [
        "registration",
        "start",
        "stop",
        "inference-set",
        "rebuild",
        "clone",
        "provider-cleanup",
        "destroy",
        "workload-cleanup",
      ],
    },
    stateMutation: createDockerStateMutationSurface(),
    bootstrap: createDockerManagedBootstrapSurface(providerId),
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
      directLifecycle: false,
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
    stateMutation: unsupported(providerId, futureReason),
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
