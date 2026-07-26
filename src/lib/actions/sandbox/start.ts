// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import {
  findLabeledSandboxContainers,
  recoverDockerDriverSandbox,
} from "../../onboard/docker-driver-sandbox-recovery";
import * as registry from "../../state/registry";
import {
  gateDirectDriverLifecycle,
  gateDockerRuntimeUp,
  type SandboxLifecycleResult,
  type SandboxStopDeps,
} from "./stop";

// Lazy requires keep the heavy connect module (and the docker adapter's
// transitive imports) out of this module's load path; tests inject
// `deps.probeSandbox` / `deps.dockerUnpause`.
function loadConnectProbe(): (sandboxName: string) => Promise<void> {
  const { connectSandbox } = require("./connect") as {
    connectSandbox: (sandboxName: string, options?: { probeOnly?: boolean }) => Promise<void>;
  };
  return (sandboxName) => connectSandbox(sandboxName, { probeOnly: true });
}

type DockerOpResult = { status?: number | null };
type DockerUnpauseFn = (name: string, opts?: Record<string, unknown>) => DockerOpResult;

function loadDockerUnpause(): DockerUnpauseFn {
  return (require("../../adapters/docker") as { dockerUnpause: DockerUnpauseFn }).dockerUnpause;
}

const DOCKER_UNPAUSE_TIMEOUT_MS = 30_000;

// Paused containers report `Up N minutes (Paused)` from `docker ps`, so the
// recovery classifier counts them as running and would no-op — while
// `docker start` on them fails outright. `docker unpause` is the only verb
// that resumes them (#6026).
function isPausedStatus(status: string): boolean {
  return status.startsWith("Up") && status.endsWith("(Paused)");
}

export interface SandboxStartDeps
  extends Pick<SandboxStopDeps, "isDockerRuntimeDown" | "printDockerRuntimeDownGuidance"> {
  getSandbox?: typeof registry.getSandbox;
  findLabeledSandboxContainers?: typeof findLabeledSandboxContainers;
  recoverDockerDriverSandbox?: typeof recoverDockerDriverSandbox;
  dockerUnpause?: DockerUnpauseFn;
  /** Gateway/forward health probe; defaults to the `recover` action body. */
  probeSandbox?: (sandboxName: string) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Restart a stopped sandbox container and bring its gateway and host
 * forwards back up (#6026). Counterpart to `stopSandbox`.
 *
 * Container restart reuses the #4423 recovery module (handles the stopped
 * original and the gpu-backup-sibling rename) plus a paused-container
 * unpause branch; the health probe reuses the `recover` action body so
 * forwards and the in-sandbox gateway come back exactly as they would after
 * `nemoclaw <name> recover`.
 */
export async function startSandbox(
  sandboxName: string,
  deps: SandboxStartDeps = {},
): Promise<SandboxLifecycleResult> {
  const log = deps.log ?? console.log;

  const gate = gateDirectDriverLifecycle(
    sandboxName,
    "start",
    deps.getSandbox ?? registry.getSandbox,
  );
  if (gate) return gate;

  const runtimeGate = gateDockerRuntimeUp(sandboxName, "start", deps);
  if (runtimeGate) return runtimeGate;

  const containers = (deps.findLabeledSandboxContainers ?? findLabeledSandboxContainers)(
    sandboxName,
  );
  const paused = containers.find((container) => isPausedStatus(container.status));
  if (paused) {
    const dockerUnpause = deps.dockerUnpause ?? ((name, opts) => loadDockerUnpause()(name, opts));
    const result = dockerUnpause(paused.name, {
      ignoreError: true,
      timeout: DOCKER_UNPAUSE_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      return {
        exitCode: 1,
        message: `  docker unpause ${paused.name} failed (exit ${result.status ?? "unknown"}).`,
      };
    }
    log(`  Container '${paused.name}' unpaused.`);
  } else {
    const recovery = (deps.recoverDockerDriverSandbox ?? recoverDockerDriverSandbox)(sandboxName);
    if (!recovery.recovered) {
      return {
        exitCode: 1,
        message:
          `  Could not start sandbox '${sandboxName}': ${recovery.detail ?? "unknown failure"}. ` +
          `If the container was removed, run '${CLI_NAME} ${sandboxName} rebuild' to recreate it.`,
      };
    }

    if (recovery.via === "started-running-original") {
      log(`  Sandbox '${sandboxName}' is already running.`);
    } else {
      log(`  Container '${recovery.containerName ?? sandboxName}' started.`);
    }
  }

  log("  Checking gateway health and host forwards…");
  await (deps.probeSandbox ?? loadConnectProbe())(sandboxName);
  return { exitCode: 0 };
}
