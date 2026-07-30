// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_NAME_LABEL,
  parsePodmanManagedSandboxInspect,
} from "../../../onboard/compute/podman/sandbox-recreate-spec";
import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  type PodmanSocketAuthority,
} from "../../../onboard/compute/podman/socket-authority";
import {
  findLabeledSandboxContainers,
  recoverDockerDriverSandbox,
} from "../../../onboard/docker-driver-sandbox-recovery";
import type { SandboxEntry } from "../../../state/registry";
import { type CommandCapture, captureHostCommand } from "../doctor-host-command";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "../gateway-failure-classifier";
import { resolveSandboxManagedGatewayStateDirectory } from "../gateway-target";
import { resolvePodmanRuntimeSocket } from "./podman-socket";

const DOCKER_OPERATION_TIMEOUT_MS = 30_000;
const PODMAN_OPERATION_TIMEOUT_MS = 40_000;
const PODMAN_PROBE_TIMEOUT_MS = 5_000;
const PODMAN_STOP_GRACE_SECONDS = 30;
const AT_REST_DOCKER_STATUS_PREFIXES = ["Exited", "Created", "Dead"] as const;
const AT_REST_PODMAN_STATES = new Set(["configured", "created", "dead", "exited", "stopped"]);
const FULL_CONTAINER_ID_RE = /^(?:sha256:)?[0-9a-f]{64}$/iu;

type DockerOpResult = { status?: number | null };
type DockerStopFn = (name: string, opts?: Record<string, unknown>) => DockerOpResult;
type DockerUnpauseFn = (name: string, opts?: Record<string, unknown>) => DockerOpResult;

function loadDockerStop(): DockerStopFn {
  return (require("../../../adapters/docker") as { dockerStop: DockerStopFn }).dockerStop;
}

function loadDockerUnpause(): DockerUnpauseFn {
  return (require("../../../adapters/docker") as { dockerUnpause: DockerUnpauseFn }).dockerUnpause;
}

export type SandboxLifecycleResult = {
  exitCode: number;
  message?: string;
};

export interface SandboxLifecycleRuntimeInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly log: (message: string) => void;
  readonly sandbox: SandboxEntry;
  readonly sandboxName: string;
}

export interface SandboxLifecycleStopHooks {
  /** Called only after a runtime container is proved stoppable and before mutation. */
  readonly beforeStop: () => void;
}

export type SandboxLifecycleStopOutcome = SandboxLifecycleResult & {
  readonly state?: "already-stopped" | "stopped";
};

export interface SandboxLifecycleRuntimeDependencies {
  readonly captureHostCommand: typeof captureHostCommand;
  readonly assertPodmanSocketAuthority: typeof assertPodmanSocketAuthority;
  readonly capturePodmanSocketAuthority: typeof capturePodmanSocketAuthority;
  readonly dockerStop: DockerStopFn;
  readonly dockerUnpause: DockerUnpauseFn;
  readonly findLabeledSandboxContainers: typeof findLabeledSandboxContainers;
  readonly isDockerRuntimeDown: typeof isDockerRuntimeDown;
  readonly printDockerRuntimeDownGuidance: typeof printDockerRuntimeDownGuidance;
  readonly recoverDockerDriverSandbox: typeof recoverDockerDriverSandbox;
  readonly resolvePodmanRuntimeSocket: typeof resolvePodmanRuntimeSocket;
  readonly resolveSandboxManagedGatewayStateDirectory: typeof resolveSandboxManagedGatewayStateDirectory;
}

export interface SandboxLifecycleRuntimeAdapter {
  readonly channelStopTransport: "docker-kubectl-first" | "openshell";
  readonly displayName: string;
  readonly driverName: string;
  preflight(
    action: "start" | "stop",
    input: SandboxLifecycleRuntimeInput,
    deps: SandboxLifecycleRuntimeDependencies,
  ): SandboxLifecycleResult | null;
  start(
    input: SandboxLifecycleRuntimeInput,
    deps: SandboxLifecycleRuntimeDependencies,
  ): SandboxLifecycleResult;
  stop(
    input: SandboxLifecycleRuntimeInput,
    deps: SandboxLifecycleRuntimeDependencies,
    hooks: SandboxLifecycleStopHooks,
  ): SandboxLifecycleStopOutcome;
}

export type SandboxLifecycleRuntimeAdapterRegistry = Readonly<
  Record<string, SandboxLifecycleRuntimeAdapter>
>;

export function resolveSandboxLifecycleRuntimeDependencies(
  overrides: Partial<SandboxLifecycleRuntimeDependencies> = {},
): SandboxLifecycleRuntimeDependencies {
  return {
    assertPodmanSocketAuthority:
      overrides.assertPodmanSocketAuthority ?? assertPodmanSocketAuthority,
    captureHostCommand: overrides.captureHostCommand ?? captureHostCommand,
    capturePodmanSocketAuthority:
      overrides.capturePodmanSocketAuthority ?? capturePodmanSocketAuthority,
    dockerStop: overrides.dockerStop ?? ((name, options) => loadDockerStop()(name, options)),
    dockerUnpause:
      overrides.dockerUnpause ?? ((name, options) => loadDockerUnpause()(name, options)),
    findLabeledSandboxContainers:
      overrides.findLabeledSandboxContainers ?? findLabeledSandboxContainers,
    isDockerRuntimeDown: overrides.isDockerRuntimeDown ?? isDockerRuntimeDown,
    printDockerRuntimeDownGuidance:
      overrides.printDockerRuntimeDownGuidance ?? printDockerRuntimeDownGuidance,
    recoverDockerDriverSandbox: overrides.recoverDockerDriverSandbox ?? recoverDockerDriverSandbox,
    resolvePodmanRuntimeSocket: overrides.resolvePodmanRuntimeSocket ?? resolvePodmanRuntimeSocket,
    resolveSandboxManagedGatewayStateDirectory:
      overrides.resolveSandboxManagedGatewayStateDirectory ??
      resolveSandboxManagedGatewayStateDirectory,
  };
}

function dockerRuntimePreflight(
  action: "start" | "stop",
  input: SandboxLifecycleRuntimeInput,
  deps: SandboxLifecycleRuntimeDependencies,
): SandboxLifecycleResult | null {
  if (!deps.isDockerRuntimeDown(input.sandboxName)) return null;
  deps.printDockerRuntimeDownGuidance(input.sandboxName, { retryCommand: action });
  return { exitCode: 1 };
}

function isPausedDockerStatus(status: string): boolean {
  return status.startsWith("Up") && status.endsWith("(Paused)");
}

function isAtRestDockerStatus(status: string): boolean {
  return AT_REST_DOCKER_STATUS_PREFIXES.some((prefix) => status.startsWith(prefix));
}

const DOCKER_LIFECYCLE_ADAPTER: SandboxLifecycleRuntimeAdapter = {
  channelStopTransport: "docker-kubectl-first",
  displayName: "Docker",
  driverName: "docker",
  preflight: dockerRuntimePreflight,
  start(input, deps) {
    const containers = deps.findLabeledSandboxContainers(input.sandboxName);
    const paused = containers.find((container) => isPausedDockerStatus(container.status));
    if (paused) {
      const result = deps.dockerUnpause(paused.name, {
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

    const recovery = deps.recoverDockerDriverSandbox(input.sandboxName);
    if (!recovery.recovered) {
      return {
        exitCode: 1,
        message:
          `  Could not start sandbox '${input.sandboxName}': ${recovery.detail ?? "unknown failure"}. ` +
          `If the container was removed, run '${CLI_NAME} ${input.sandboxName} rebuild' to recreate it.`,
      };
    }
    if (recovery.via === "started-running-original") {
      input.log(`  Sandbox '${input.sandboxName}' is already running.`);
    } else {
      input.log(`  Container '${recovery.containerName ?? input.sandboxName}' started.`);
    }
    return { exitCode: 0 };
  },
  stop(input, deps, hooks) {
    const containers = deps.findLabeledSandboxContainers(input.sandboxName);
    if (containers.length === 0) {
      return {
        exitCode: 1,
        message:
          `  No Docker container found for sandbox '${input.sandboxName}'. ` +
          `If the container was removed, run '${CLI_NAME} ${input.sandboxName} rebuild' to recreate it.`,
      };
    }

    const stoppable = containers.filter((container) => !isAtRestDockerStatus(container.status));
    if (stoppable.length === 0) return { exitCode: 0, state: "already-stopped" };

    hooks.beforeStop();
    const failures: string[] = [];
    for (const container of stoppable) {
      input.log(`  Stopping container '${container.name}'…`);
      const result = deps.dockerStop(container.name, {
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
  },
};

type PodmanManagedContainer = {
  readonly bin: string;
  readonly containerId: string;
  readonly name: string;
  readonly paused: boolean;
  readonly running: boolean;
  readonly socketAuthority: PodmanSocketAuthority;
  readonly socketPath: string;
  readonly status: string;
};

function podmanCommandDetail(result: CommandCapture): string {
  return (result.stderr || result.stdout || result.error?.message || "unknown failure")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-500);
}

function podmanFailure(operation: string, result: CommandCapture): SandboxLifecycleResult {
  const detail = podmanCommandDetail(result);
  return {
    exitCode: 1,
    message: `  podman ${operation} failed (exit ${String(result.status)})${
      detail ? `: ${detail}` : "."
    }`,
  };
}

function requirePodmanContainerState(
  raw: Readonly<Record<string, unknown>>,
): Pick<PodmanManagedContainer, "paused" | "status"> {
  const value = raw.State;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Podman managed sandbox inspect has no object State.");
  }
  const state = value as Record<string, unknown>;
  const paused = state.Paused;
  if (paused !== undefined && paused !== null && typeof paused !== "boolean") {
    throw new Error("Podman managed sandbox inspect State.Paused must be a boolean.");
  }
  const status = state.Status;
  if (typeof status !== "string" || !status.trim()) {
    throw new Error("Podman managed sandbox inspect State.Status must be a non-empty string.");
  }
  return {
    paused: paused === true,
    status: status.trim().toLowerCase(),
  };
}

function podmanRuntimeIdentity(
  input: SandboxLifecycleRuntimeInput,
  deps: SandboxLifecycleRuntimeDependencies,
): { bin: string; socketAuthority: PodmanSocketAuthority; socketPath: string } {
  const stateDir = deps.resolveSandboxManagedGatewayStateDirectory(
    input.sandbox,
    input.environment,
  );
  const socketPath = deps.resolvePodmanRuntimeSocket(stateDir, input.environment);
  const socketAuthority = deps.capturePodmanSocketAuthority(socketPath);
  if (socketAuthority.socketPath !== socketPath) {
    throw new Error(
      "Managed Podman lifecycle socket authority does not match its runtime binding.",
    );
  }
  deps.assertPodmanSocketAuthority(socketAuthority);
  return {
    bin: input.environment.NEMOCLAW_PODMAN_BIN?.trim() || "podman",
    socketAuthority,
    socketPath,
  };
}

function captureAuthorizedPodmanCommand(
  deps: SandboxLifecycleRuntimeDependencies,
  runtime: Pick<PodmanManagedContainer, "bin" | "socketAuthority" | "socketPath">,
  args: string[],
  timeoutMs: number,
): CommandCapture {
  if (runtime.socketAuthority.socketPath !== runtime.socketPath) {
    throw new Error("Managed Podman lifecycle authority changed its socket path.");
  }
  deps.assertPodmanSocketAuthority(runtime.socketAuthority);
  const result = deps.captureHostCommand(runtime.bin, args, timeoutMs);
  deps.assertPodmanSocketAuthority(runtime.socketAuthority);
  return result;
}

function inspectPodmanManagedSandbox(
  input: SandboxLifecycleRuntimeInput,
  deps: SandboxLifecycleRuntimeDependencies,
): PodmanManagedContainer | SandboxLifecycleResult {
  let runtime: ReturnType<typeof podmanRuntimeIdentity>;
  try {
    runtime = podmanRuntimeIdentity(input, deps);
  } catch (error) {
    return {
      exitCode: 1,
      message: `  Could not resolve the managed Podman runtime: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const socketUrl = `unix://${runtime.socketPath}`;
  let lookup: CommandCapture;
  try {
    lookup = captureAuthorizedPodmanCommand(
      deps,
      runtime,
      [
        "--url",
        socketUrl,
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${PODMAN_MANAGED_LABEL}=true`,
        "--filter",
        `label=${PODMAN_SANDBOX_NAME_LABEL}=${input.sandboxName}`,
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      PODMAN_PROBE_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      exitCode: 1,
      message: `  Refusing Podman lifecycle mutation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (lookup.status !== 0) return podmanFailure("container lookup", lookup);

  let candidates: Array<{ containerId: string; name: string }>;
  try {
    candidates = lookup.stdout
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const columns = line.split("\t");
        if (columns.length !== 2 || !columns[0] || !columns[1]) {
          throw new Error("Podman managed sandbox lookup returned a malformed row.");
        }
        return { containerId: columns[0], name: columns[1] };
      });
  } catch (error) {
    return {
      exitCode: 1,
      message: `  Refusing Podman lifecycle mutation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (candidates.length === 0) {
    return {
      exitCode: 1,
      message:
        `  No Podman container found for sandbox '${input.sandboxName}'. ` +
        `If the container was removed, run '${CLI_NAME} ${input.sandboxName} rebuild' to recreate it.`,
    };
  }
  if (candidates.length !== 1) {
    return {
      exitCode: 1,
      message:
        `  Refusing Podman lifecycle mutation: sandbox '${input.sandboxName}' has ` +
        `${candidates.length} managed containers.`,
    };
  }

  const candidate = candidates[0];
  const expectedName = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${input.sandboxName}`;
  if (
    !candidate ||
    candidate.name !== expectedName ||
    !FULL_CONTAINER_ID_RE.test(candidate.containerId)
  ) {
    return {
      exitCode: 1,
      message: `  Refusing Podman lifecycle mutation: sandbox '${input.sandboxName}' has an unexpected container identity.`,
    };
  }
  let inspect: CommandCapture;
  try {
    inspect = captureAuthorizedPodmanCommand(
      deps,
      runtime,
      ["--url", socketUrl, "container", "inspect", candidate.containerId],
      PODMAN_PROBE_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      exitCode: 1,
      message: `  Refusing Podman lifecycle mutation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (inspect.status !== 0) return podmanFailure("container inspect", inspect);

  try {
    const parsed = parsePodmanManagedSandboxInspect(inspect.stdout, {
      containerId: candidate.containerId,
      name: expectedName,
      sandboxName: input.sandboxName,
    });
    const state = requirePodmanContainerState(parsed.raw);
    return {
      bin: runtime.bin,
      containerId: parsed.containerId,
      name: parsed.name,
      paused: state.paused,
      running: parsed.running,
      socketAuthority: runtime.socketAuthority,
      socketPath: runtime.socketPath,
      status: state.status,
    };
  } catch (error) {
    return {
      exitCode: 1,
      message: `  Refusing Podman lifecycle mutation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function isLifecycleFailure(
  value: PodmanManagedContainer | SandboxLifecycleResult,
): value is SandboxLifecycleResult {
  return Object.hasOwn(value, "exitCode");
}

function runPodmanContainerMutation(
  deps: SandboxLifecycleRuntimeDependencies,
  runtime: Pick<PodmanManagedContainer, "bin" | "socketAuthority" | "socketPath">,
  operation: "start" | "stop" | "unpause",
  containerId: string,
): SandboxLifecycleResult {
  const args = [
    "--url",
    `unix://${runtime.socketPath}`,
    operation,
    ...(operation === "stop" ? ["--time", String(PODMAN_STOP_GRACE_SECONDS)] : []),
    containerId,
  ];
  let result: CommandCapture;
  try {
    result = captureAuthorizedPodmanCommand(deps, runtime, args, PODMAN_OPERATION_TIMEOUT_MS);
  } catch (error) {
    return {
      exitCode: 1,
      message: `  Refusing Podman ${operation}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return result.status === 0 ? { exitCode: 0 } : podmanFailure(operation, result);
}

const PODMAN_LIFECYCLE_ADAPTER: SandboxLifecycleRuntimeAdapter = {
  channelStopTransport: "openshell",
  displayName: "Podman",
  driverName: "podman",
  preflight() {
    return null;
  },
  start(input, deps) {
    const container = inspectPodmanManagedSandbox(input, deps);
    if (isLifecycleFailure(container)) return container;
    if (container.running && !container.paused) {
      input.log(`  Sandbox '${input.sandboxName}' is already running.`);
      return { exitCode: 0 };
    }
    if (!container.paused && !AT_REST_PODMAN_STATES.has(container.status)) {
      return {
        exitCode: 1,
        message:
          `  Refusing Podman start for sandbox '${input.sandboxName}': ` +
          `container state '${container.status}' is not safely restartable.`,
      };
    }
    const operation = container.paused ? "unpause" : "start";
    const result = runPodmanContainerMutation(deps, container, operation, container.containerId);
    if (result.exitCode !== 0) return result;
    input.log(
      `  Container '${container.name}' ${operation === "unpause" ? "unpaused" : "started"}.`,
    );
    return result;
  },
  stop(input, deps, hooks) {
    const container = inspectPodmanManagedSandbox(input, deps);
    if (isLifecycleFailure(container)) return container;
    const stoppable =
      container.running ||
      container.paused ||
      container.status === "restarting" ||
      container.status === "stopping";
    if (!stoppable) {
      if (AT_REST_PODMAN_STATES.has(container.status)) {
        return { exitCode: 0, state: "already-stopped" };
      }
      return {
        exitCode: 1,
        message:
          `  Refusing Podman stop for sandbox '${input.sandboxName}': ` +
          `container state '${container.status}' is not safely stoppable.`,
      };
    }

    hooks.beforeStop();
    input.log(`  Stopping container '${container.name}'…`);
    const result = runPodmanContainerMutation(deps, container, "stop", container.containerId);
    return result.exitCode === 0 ? { ...result, state: "stopped" } : result;
  },
};

export const CURRENT_SANDBOX_LIFECYCLE_RUNTIME_ADAPTERS = {
  docker: DOCKER_LIFECYCLE_ADAPTER,
  podman: PODMAN_LIFECYCLE_ADAPTER,
} as const satisfies SandboxLifecycleRuntimeAdapterRegistry;

/**
 * Resolve persisted runtime identity without letting new drivers inherit an
 * existing runtime's lifecycle behavior. Empty and `vm` entries retain the
 * historical Docker implementation; every named future driver must register
 * an exact adapter.
 */
export function resolveSandboxLifecycleRuntimeAdapter(
  driverName: string | null | undefined,
  adapters: SandboxLifecycleRuntimeAdapterRegistry = CURRENT_SANDBOX_LIFECYCLE_RUNTIME_ADAPTERS,
): SandboxLifecycleRuntimeAdapter | null {
  const normalized = driverName?.trim().toLowerCase();
  const runtimeDriver = !normalized || normalized === "vm" ? "docker" : normalized;
  const adapter = Object.hasOwn(adapters, runtimeDriver) ? adapters[runtimeDriver] : undefined;
  if (!adapter) return null;
  if (adapter.driverName !== runtimeDriver) {
    throw new Error(
      `Sandbox lifecycle runtime adapter '${runtimeDriver}' does not match its registered driver identity.`,
    );
  }
  return adapter;
}
