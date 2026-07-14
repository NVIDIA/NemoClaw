// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { findLabeledSandboxContainers } from "../../onboard/docker-driver-sandbox-recovery";
import * as registry from "../../state/registry";
import { stopSandboxChannels } from "../../tunnel/sandbox-gateway-stop";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "./gateway-failure-classifier";

// Lazy adapter accessor, same pattern as docker-driver-sandbox-recovery.ts:
// tests inject `deps.dockerStop` so the lazy require never fires.
type DockerOpResult = { status?: number | null };
type DockerStopFn = (name: string, opts?: Record<string, unknown>) => DockerOpResult;

function loadDockerStop(): DockerStopFn {
  return (require("../../adapters/docker") as { dockerStop: DockerStopFn }).dockerStop;
}

const DOCKER_STOP_TIMEOUT_MS = 30_000;

// Docker `Status` strings for containers that hold no resources: nothing to
// stop. Everything else — `Up`, `Up … (Paused)`, and crash-looping
// `Restarting (N) …` — is stoppable; `docker stop` also disarms an armed
// restart policy, which is exactly how a crash loop is silenced (#6026).
const AT_REST_STATUS_PREFIXES = ["Exited", "Created", "Dead"] as const;

function isAtRest(status: string): boolean {
  return AT_REST_STATUS_PREFIXES.some((prefix) => status.startsWith(prefix));
}

export type SandboxLifecycleResult = {
  exitCode: number;
  message?: string;
};

export interface SandboxStopDeps {
  getSandbox?: typeof registry.getSandbox;
  isDockerRuntimeDown?: typeof isDockerRuntimeDown;
  printDockerRuntimeDownGuidance?: typeof printDockerRuntimeDownGuidance;
  findLabeledSandboxContainers?: typeof findLabeledSandboxContainers;
  stopSandboxChannels?: typeof stopSandboxChannels;
  dockerStop?: DockerStopFn;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function normalizeDriver(driver: unknown): string | null {
  return typeof driver === "string" && driver.trim() ? driver.trim().toLowerCase() : null;
}

/**
 * Refuse lifecycle control for sandboxes we cannot reach through the local
 * Docker daemon. Mirrors the gate `privilegedSandboxExecArgv` applies before
 * direct-container mutation (src/lib/sandbox/privileged-exec.ts).
 */
export function gateDirectDriverLifecycle(
  sandboxName: string,
  action: "stop" | "start",
  getSandbox: typeof registry.getSandbox,
): SandboxLifecycleResult | null {
  const entry = getSandbox(sandboxName);
  if (!entry) {
    return {
      exitCode: 1,
      message:
        `  Sandbox '${sandboxName}' is not registered. ` +
        `Run '${CLI_NAME} list' to see registered sandboxes.`,
    };
  }
  const driver = normalizeDriver(entry.openshellDriver);
  if (driver !== null && driver !== "docker" && driver !== "vm") {
    return {
      exitCode: 1,
      message:
        `  '${CLI_NAME} ${sandboxName} ${action}' controls the local Docker container ` +
        `directly and is unavailable for driver '${driver}'.`,
    };
  }
  return null;
}

/**
 * Fail fast with the shared #4428 outage guidance when the Docker daemon is
 * unreachable. Without this preflight an empty `docker ps` result is
 * indistinguishable from "no containers", and stop/start would misreport a
 * daemon outage as a removed container and steer the user toward `rebuild` —
 * exactly the guidance printDockerRuntimeDownGuidance exists to prevent.
 */
export function gateDockerRuntimeUp(
  sandboxName: string,
  retryCommand: "stop" | "start",
  deps: Pick<SandboxStopDeps, "isDockerRuntimeDown" | "printDockerRuntimeDownGuidance">,
): SandboxLifecycleResult | null {
  if (!(deps.isDockerRuntimeDown ?? isDockerRuntimeDown)(sandboxName)) return null;
  (deps.printDockerRuntimeDownGuidance ?? printDockerRuntimeDownGuidance)(sandboxName, {
    retryCommand,
  });
  return { exitCode: 1 };
}

/**
 * Stop a sandbox's Docker container while preserving every piece of state
 * destroy would remove: the workspace volume, registry entry, OpenShell
 * sandbox record, credentials, and images all stay in place (#6026).
 *
 * The shared host gateway, tunnel, and any NIM inference container are
 * gateway-scoped and serve other sandboxes — deliberately untouched.
 */
export function stopSandbox(
  sandboxName: string,
  deps: SandboxStopDeps = {},
): SandboxLifecycleResult {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;

  const gate = gateDirectDriverLifecycle(
    sandboxName,
    "stop",
    deps.getSandbox ?? registry.getSandbox,
  );
  if (gate) return gate;

  const runtimeGate = gateDockerRuntimeUp(sandboxName, "stop", deps);
  if (runtimeGate) return runtimeGate;

  const containers = (deps.findLabeledSandboxContainers ?? findLabeledSandboxContainers)(
    sandboxName,
  );
  if (containers.length === 0) {
    return {
      exitCode: 1,
      message:
        `  No Docker container found for sandbox '${sandboxName}'. ` +
        `If the container was removed, run '${CLI_NAME} ${sandboxName} rebuild' to recreate it.`,
    };
  }

  const stoppable = containers.filter((container) => !isAtRest(container.status));
  if (stoppable.length === 0) {
    log(`  Sandbox '${sandboxName}' is already stopped.`);
    log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
    return { exitCode: 0 };
  }

  // Graceful in-sandbox gateway shutdown first, so channels disconnect
  // cleanly instead of dying with the container's SIGTERM. Best-effort:
  // a stop must still free resources when the gateway is unreachable.
  // Agent-managed gateways (e.g. Hermes) are supervised inside the sandbox
  // and shut down with the container's stop signal instead.
  try {
    (deps.stopSandboxChannels ?? stopSandboxChannels)(sandboxName, {
      info: (message) => log(`  ${message}`),
      warn: (message) => warn(`  ${message}`),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`  Warning: could not stop in-sandbox channels gracefully: ${detail}`);
  }

  // Attempt every stoppable container even if one fails: a sandbox can have
  // more than one labeled container (e.g. a gpu-backup sibling), and aborting
  // on the first failure would leave the rest running — the opposite of what
  // stop is for. Collect failures and report them together.
  const dockerStop = deps.dockerStop ?? ((name, opts) => loadDockerStop()(name, opts));
  const failures: string[] = [];
  for (const container of stoppable) {
    log(`  Stopping container '${container.name}'…`);
    const result = dockerStop(container.name, {
      ignoreError: true,
      timeout: DOCKER_STOP_TIMEOUT_MS,
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

  log(`  Sandbox '${sandboxName}' stopped. Workspace state is preserved.`);
  log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
  return { exitCode: 0 };
}
