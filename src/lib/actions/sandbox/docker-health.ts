// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerContainerInspectFormat } from "../../adapters/docker/inspect";
import { dockerCapture } from "../../adapters/docker/run";
import * as registry from "../../state/registry";

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
  // OpenShell names sandbox containers either as `openshell-<sandbox>`
  // (no suffix) or `openshell-<sandbox>-<id>` where <id> is a runtime
  // identifier appended by openshell. Two ambiguities to avoid:
  //
  //   1. A sandbox name can be a prefix of another sandbox name
  //      (`my` vs `my-assistant`).
  //   2. Even with a hyphen-free suffix, a sandbox name can be a prefix
  //      of another sandbox name whose own suffix is hyphen-free
  //      (`my-assistant` vs `my-assistant-prod`).
  //
  // To disambiguate, resolve each candidate to the LONGEST registered
  // sandbox name it could belong to. We only accept a candidate when
  // that resolved owner is the sandbox we are looking up. This also
  // gives the right answer for the `openshell-<sandbox>` exact form.
  const ourPrefix = `openshell-${sandboxName}-`;
  const ourExact = `openshell-${sandboxName}`;
  const knownSandboxes = new Set(deps.listSandboxNames());
  knownSandboxes.add(sandboxName);
  const candidates = deps
    .dockerPsNames()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line === ourExact || line.startsWith(ourPrefix));
  // Prefer the exact-name container before considering suffixed ones.
  // Without this short-circuit, a suffixed `openshell-<name>-<id>` whose
  // <id> is a docker runtime suffix (not a registered sandbox name) would
  // resolve to our sandbox via the longest-match heuristic and beat the
  // co-existing exact `openshell-<name>` if it appeared earlier in
  // `docker ps`.
  if (candidates.includes(ourExact)) return ourExact;
  for (const candidate of candidates) {
    const stripped = candidate.replace(/^openshell-/, "");
    // Find the longest known sandbox whose container name pattern
    // matches this candidate. Longest-first defeats prefix collisions.
    const owner = [...knownSandboxes]
      .filter(
        (name) => stripped === name || stripped.startsWith(`${name}-`),
      )
      .sort((a, b) => b.length - a.length)[0];
    if (owner === sandboxName) return candidate;
  }
  return null;
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
