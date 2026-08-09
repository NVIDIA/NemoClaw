// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerContainerInspectFormat } from "../../adapters/docker/inspect";
import { dockerCapture } from "../../adapters/docker/run";
import { findLabeledSandboxContainers } from "../../onboard/docker-driver-sandbox-recovery";
import * as registry from "../../state/registry";
import { resolveSandboxContainerOwner } from "./sandbox-container-owner";

export type DockerHealthState = "healthy" | "unhealthy" | "starting" | "none" | "unknown";

export interface SandboxDockerHealth {
  state: DockerHealthState;
  containerName: string | null;
}

/**
 * Combined Docker runtime view for a docker-driver sandbox container: the
 * HEALTHCHECK signal plus whether the container is paused (`docker pause`).
 * A paused container can surface upstream as `Phase: Error` even though the
 * sandbox is intact, so `status` reads `paused` to print a recovery hint
 * without rewriting the authoritative phase. See #4495.
 */
export interface SandboxDockerRuntime {
  health: DockerHealthState;
  paused: boolean;
  containerName: string | null;
}

interface ResolveDeps {
  getSandbox: (name: string) => registry.SandboxEntry | null;
  listSandboxNames: () => string[];
  dockerPsNames: () => string;
  findLabeledSandboxContainers: typeof findLabeledSandboxContainers;
  dockerInspectHealth: (containerName: string) => string;
  dockerInspectPaused: (containerName: string) => string;
}

const defaultDeps: ResolveDeps = {
  getSandbox: (name) => registry.getSandbox(name),
  listSandboxNames: () => registry.listSandboxes().sandboxes.map((entry) => entry.name),
  dockerPsNames: () => dockerCapture(["ps", "--format", "{{.Names}}"], { ignoreError: true }),
  findLabeledSandboxContainers: (sandboxName) => findLabeledSandboxContainers(sandboxName),
  dockerInspectHealth: (containerName) =>
    dockerContainerInspectFormat(
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
      containerName,
      { ignoreError: true },
    ),
  dockerInspectPaused: (containerName) =>
    dockerContainerInspectFormat(
      "{{if .State}}{{.State.Paused}}{{else}}false{{end}}",
      containerName,
      { ignoreError: true },
    ),
};

function resolveDockerDriverSandboxContainer(
  sandboxName: string,
  deps: ResolveDeps,
): string | null {
  try {
    if (deps.getSandbox(sandboxName)?.openshellDriver !== "docker") {
      return null;
    }
  } catch {
    return null;
  }
  return resolveSandboxContainerOwner(deps.dockerPsNames(), sandboxName, deps.listSandboxNames());
}

function normalizeHealthState(raw: string): DockerHealthState {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "healthy") return "healthy";
  if (trimmed === "unhealthy") return "unhealthy";
  if (trimmed === "starting") return "starting";
  if (trimmed === "none" || trimmed === "") return "none";
  return "unknown";
}

/**
 * Read the Docker `.State.Health.Status` for a sandbox container managed by
 * the docker driver. Returns `state: "none"` when the sandbox is not on the
 * docker driver, or when the inspect call fails for any reason — callers
 * use this to surface the Docker healthcheck signal alongside NemoClaw's
 * own delivery-chain probes. See #3975 for the mismatch this helps explain.
 */
export function getSandboxDockerHealth(
  sandboxName: string,
  depsOverride: Partial<ResolveDeps> = {},
): SandboxDockerHealth {
  const deps: ResolveDeps = { ...defaultDeps, ...depsOverride };
  const containerName = resolveDockerDriverSandboxContainer(sandboxName, deps);
  if (!containerName) return { state: "none", containerName: null };
  let raw = "";
  try {
    raw = deps.dockerInspectHealth(containerName);
  } catch {
    return { state: "unknown", containerName };
  }
  return { state: normalizeHealthState(raw), containerName };
}

function normalizePausedState(raw: string): boolean {
  // `docker inspect --format {{.State.Paused}}` prints `true`/`false`. Treat
  // anything else (empty output, inspect failure surfaced as a string, older
  // engines without the field) as not paused so we never invent a paused hint.
  return raw.trim().toLowerCase() === "true";
}

/**
 * Resolve an OpenShell-labeled docker-driver sandbox container across all states
 * and read both its HEALTHCHECK state and `.State.Paused` flag. Label-scoped
 * discovery matches the ownership boundary enforced by `start`; preferring its
 * running rows preserves paused-container guidance before falling back to an
 * exited container that `start` can recover (#7222). Returns `health: "none",
 * paused: false` when the sandbox is not on the docker driver or no owned
 * container is found. See #4495.
 */
export function getSandboxDockerRuntime(
  sandboxName: string,
  depsOverride: Partial<ResolveDeps> = {},
): SandboxDockerRuntime {
  const deps: ResolveDeps = { ...defaultDeps, ...depsOverride };
  try {
    if (deps.getSandbox(sandboxName)?.openshellDriver !== "docker") {
      return { health: "none", paused: false, containerName: null };
    }
  } catch {
    return { health: "none", paused: false, containerName: null };
  }
  let labeledContainers: ReturnType<typeof findLabeledSandboxContainers>;
  try {
    labeledContainers = deps.findLabeledSandboxContainers(sandboxName);
  } catch {
    return { health: "none", paused: false, containerName: null };
  }
  const runningNames = labeledContainers
    .filter((container) => container.running)
    .map((container) => container.name)
    .join("\n");
  const allNames = labeledContainers.map((container) => container.name).join("\n");
  const containerName =
    resolveDockerDriverSandboxContainer(sandboxName, {
      ...deps,
      dockerPsNames: () => runningNames,
    }) ??
    resolveDockerDriverSandboxContainer(sandboxName, {
      ...deps,
      dockerPsNames: () => allNames,
    });
  if (!containerName) return { health: "none", paused: false, containerName: null };
  let health: DockerHealthState;
  try {
    health = normalizeHealthState(deps.dockerInspectHealth(containerName));
  } catch {
    health = "unknown";
  }
  let paused = false;
  try {
    paused = normalizePausedState(deps.dockerInspectPaused(containerName));
  } catch {
    paused = false;
  }
  return { health, paused, containerName };
}
