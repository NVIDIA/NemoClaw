// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared resolver and argv builders for privileged host-initiated execs
// (shields up/down, host-side config writes). The same code is consumed by
// `shields/index.ts` and `sandbox/config.ts` so the two callers cannot
// drift on how they pick the target sandbox container.
//
// Drivers that route privileged execs through a k3s cluster container still
// fall through to the legacy `openshell-cluster-<gateway>` kubectl path.
// Drivers that run the sandbox directly on the local Docker engine
// (`docker`, `vm`) get a `docker exec --user root <container> ...` argv so
// callers can bypass the sandbox's Landlock domain without depending on a
// non-existent cluster container. See #4245 for the macOS VM-driver case.

import { dockerCapture } from "../adapters/docker/run";
import * as registry from "../state/registry";

const DIRECT_CONTAINER_DRIVERS: ReadonlySet<string> = new Set(["docker", "vm"]);
const LEGACY_K3S_CONTAINER = "openshell-cluster-nemoclaw";

export interface PrivilegedExecArgvOptions {
  /** Include `-i` so the exec inherits stdin (used by config writes). */
  stdin?: boolean;
}

export function isDirectContainerDriver(
  openshellDriver: string | null | undefined,
): boolean {
  return (
    typeof openshellDriver === "string" &&
    DIRECT_CONTAINER_DRIVERS.has(openshellDriver)
  );
}

/**
 * Pure selector: given the openshell driver and the output of
 * `docker ps --format {{.Names}}`, return the sandbox container we should
 * exec into, or null when the driver is not a direct-container driver or no
 * matching container is present.
 *
 * `knownSandboxNames` is used to disambiguate when a sandbox name is a prefix
 * of another sandbox's name (`my` vs `my-assistant`) so that looking up the
 * shorter name does not steal the longer sandbox's container.
 */
export function selectPrivilegedSandboxContainer(
  sandboxName: string,
  openshellDriver: string | null | undefined,
  containerNames: string,
  knownSandboxNames: readonly string[] = [],
): string | null {
  if (!isDirectContainerDriver(openshellDriver)) return null;

  const ourPrefix = `openshell-${sandboxName}-`;
  const ourExact = `openshell-${sandboxName}`;
  const knownSandboxes = new Set(knownSandboxNames);
  knownSandboxes.add(sandboxName);
  const candidates = containerNames
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line === ourExact || line.startsWith(ourPrefix));

  // Prefer the exact-name container before considering suffixed ones, so a
  // stale `openshell-<name>-<id>` from an earlier OpenShell run cannot win
  // the longest-known-name heuristic over the live exact container.
  if (candidates.includes(ourExact)) return ourExact;

  for (const candidate of candidates) {
    const stripped = candidate.replace(/^openshell-/, "");
    const owner = [...knownSandboxes]
      .filter((name) => stripped === name || stripped.startsWith(`${name}-`))
      .sort((a, b) => b.length - a.length)[0];
    if (owner === sandboxName) return candidate;
  }
  return null;
}

/**
 * Runtime resolver: queries the local registry for the sandbox's openshell
 * driver and known sandbox names, and the local Docker engine for live
 * container names, then defers to the pure selector above.
 *
 * Returns null when the driver is not a direct-container driver, when the
 * registry/Docker lookup fails, or when no matching container is found.
 */
export function resolvePrivilegedSandboxContainer(
  sandboxName: string,
): string | null {
  let openshellDriver: string | null | undefined;
  let knownSandboxNames: string[] = [];
  try {
    openshellDriver = registry.getSandbox(sandboxName)?.openshellDriver;
    if (!isDirectContainerDriver(openshellDriver)) return null;
    try {
      knownSandboxNames = registry
        .listSandboxes()
        .sandboxes.map((entry) => entry.name);
    } catch {
      knownSandboxNames = [];
    }
  } catch {
    return null;
  }
  const output = dockerCapture(["ps", "--format", "{{.Names}}"], {
    ignoreError: true,
  });
  return selectPrivilegedSandboxContainer(
    sandboxName,
    openshellDriver,
    output,
    knownSandboxNames,
  );
}

/** `docker exec --user root <container> [-i] <cmd...>` for direct-container drivers. */
export function buildDirectContainerExecArgv(
  container: string,
  cmd: readonly string[],
  opts: PrivilegedExecArgvOptions = {},
): string[] {
  return [
    "exec",
    ...(opts.stdin ? ["-i"] : []),
    "--user",
    "root",
    container,
    ...cmd,
  ];
}

/**
 * Legacy k3s gateway path:
 *   `docker exec [-i] openshell-cluster-nemoclaw kubectl exec -n openshell <sandbox> -c agent [-i] -- <cmd...>`
 *
 * When `opts.stdin` is true, `-i` is threaded into both the outer `docker exec`
 * and the inner `kubectl exec` so stdin reaches the in-pod process.
 */
export function buildKubectlExecArgv(
  sandboxName: string,
  cmd: readonly string[],
  opts: PrivilegedExecArgvOptions = {},
): string[] {
  const stdinFlag = opts.stdin ? ["-i"] : [];
  return [
    "exec",
    ...stdinFlag,
    LEGACY_K3S_CONTAINER,
    "kubectl",
    "exec",
    "-n",
    "openshell",
    sandboxName,
    "-c",
    "agent",
    ...stdinFlag,
    "--",
    ...cmd,
  ];
}

/**
 * Choose the privileged-exec argv given an already-resolved direct container
 * (or null to force the legacy k3s/kubectl fallback). Kept as a pure helper
 * so shields and host-side config writes both go through the same dispatcher
 * and so the argv is unit-testable without poking at registry/docker.
 */
export function buildPrivilegedExecArgv(
  sandboxName: string,
  cmd: readonly string[],
  directContainer: string | null,
  opts: PrivilegedExecArgvOptions = {},
): string[] {
  if (directContainer) return buildDirectContainerExecArgv(directContainer, cmd, opts);
  return buildKubectlExecArgv(sandboxName, cmd, opts);
}

/** Exposed so callers and tests can reference the legacy gateway container name. */
export const LEGACY_K3S_GATEWAY_CONTAINER = LEGACY_K3S_CONTAINER;
