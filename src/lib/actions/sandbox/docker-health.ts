// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerContainerInspectFormat } from "../../adapters/docker/inspect";
import { dockerCapture } from "../../adapters/docker/run";
import * as registry from "../../state/registry";
import { resolveSandboxContainerOwner } from "./sandbox-container-owner";

export type DockerHealthState =
  | "healthy"
  | "unhealthy"
  | "starting"
  | "none"
  | "unknown";

export interface SandboxDockerHealth {
  state: DockerHealthState;
  containerName: string | null;
}

interface ResolveDeps {
  getSandbox: (name: string) => registry.SandboxEntry | null;
  listSandboxNames: () => string[];
  dockerPsNames: () => string;
  dockerInspectHealth: (containerName: string) => string;
}

const defaultDeps: ResolveDeps = {
  getSandbox: (name) => registry.getSandbox(name),
  listSandboxNames: () => registry.listSandboxes().sandboxes.map((entry) => entry.name),
  dockerPsNames: () =>
    dockerCapture(["ps", "--format", "{{.Names}}"], { ignoreError: true }),
  dockerInspectHealth: (containerName) =>
    dockerContainerInspectFormat(
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
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
  return resolveSandboxContainerOwner(
    deps.dockerPsNames(),
    sandboxName,
    deps.listSandboxNames(),
  );
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
