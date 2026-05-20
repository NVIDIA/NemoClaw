// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerExecFileSync } from "../docker/exec";
import { dockerCapture } from "../docker/run";
import * as registry from "../../state/registry";

export const K3S_CONTAINER = "openshell-cluster-nemoclaw";

export interface PrivilegedSandboxExecArgvOptions {
  stdin?: boolean;
  user?: string;
}

export interface PrivilegedSandboxExecOptions extends PrivilegedSandboxExecArgvOptions {
  input?: string | Buffer;
  timeout?: number;
}

export function selectDockerDriverSandboxContainer(
  sandboxName: string,
  openshellDriver: string | null | undefined,
  containerNames: string,
  knownSandboxNames: readonly string[] = [],
): string | null {
  if (openshellDriver !== "docker") return null;
  const prefix = `openshell-${sandboxName}-`;
  const exact = `openshell-${sandboxName}`;
  const trimmed = containerNames
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.length > 0);

  const exactMatch = trimmed.find((name) => name === exact);
  if (exactMatch) return exactMatch;

  // The prefix `openshell-<sandboxName>-` alone can collide with other
  // sandboxes whose names share that prefix (e.g. sandbox `demo` vs.
  // sandbox `demo-prod` → `openshell-demo-prod` would otherwise be
  // accepted as a container for `demo`). Exclude any candidate that
  // exact-matches a different registered sandbox so brew/shields/config's
  // privileged exec channel can't be misrouted across sandboxes.
  const otherExactContainers = new Set(
    knownSandboxNames
      .filter((name) => name !== sandboxName)
      .map((name) => `openshell-${name}`),
  );
  const knownSandboxSet = new Set(knownSandboxNames);
  for (const candidate of trimmed) {
    if (!candidate.startsWith(prefix)) continue;
    if (otherExactContainers.has(candidate)) continue;
    const candidateSandbox = candidate.slice("openshell-".length);
    if (candidateSandbox !== sandboxName && knownSandboxSet.has(candidateSandbox)) continue;
    return candidate;
  }
  return null;
}

export function resolveDockerDriverSandboxContainer(sandboxName: string): string | null {
  let openshellDriver: string | null | undefined;
  try {
    openshellDriver = registry.getSandbox?.(sandboxName)?.openshellDriver;
  } catch {
    return null;
  }
  if (openshellDriver !== "docker") return null;
  const output = dockerCapture(["ps", "--format", "{{.Names}}"], { ignoreError: true });
  let knownSandboxNames: string[] = [];
  try {
    knownSandboxNames = registry
      .listSandboxes?.()
      .sandboxes.map((entry) => entry.name) ?? [];
  } catch {
    knownSandboxNames = [];
  }
  return selectDockerDriverSandboxContainer(
    sandboxName,
    openshellDriver,
    output,
    knownSandboxNames,
  );
}

function withUserPrefix(cmd: readonly string[], user: string): string[] {
  if (user === "root") return [...cmd];
  return ["runuser", "-u", user, "--", ...cmd];
}

export function kubectlExecArgv(
  sandboxName: string,
  cmd: readonly string[],
  options: PrivilegedSandboxExecArgvOptions = {},
): string[] {
  const { stdin = false, user = "root" } = options;
  return [
    "exec",
    ...(stdin ? ["-i"] : []),
    K3S_CONTAINER,
    "kubectl",
    "exec",
    "-n",
    "openshell",
    sandboxName,
    "-c",
    "agent",
    ...(stdin ? ["-i"] : []),
    "--",
    ...withUserPrefix(cmd, user),
  ];
}

export function privilegedSandboxExecArgv(
  sandboxName: string,
  cmd: readonly string[],
  options: PrivilegedSandboxExecArgvOptions = {},
): string[] {
  const { stdin = false, user = "root" } = options;
  const dockerDriverContainer = resolveDockerDriverSandboxContainer(sandboxName);
  if (dockerDriverContainer) {
    return ["exec", ...(stdin ? ["-i"] : []), "--user", user, dockerDriverContainer, ...cmd];
  }
  return kubectlExecArgv(sandboxName, cmd, { stdin, user });
}

export function privilegedSandboxExec(
  sandboxName: string,
  cmd: readonly string[],
  options: PrivilegedSandboxExecOptions = {},
): string {
  const { input, timeout = 30000, user, stdin: stdinFlag } = options;
  const hasInput = input !== undefined;
  const argv = privilegedSandboxExecArgv(sandboxName, cmd, {
    stdin: stdinFlag ?? hasInput,
    user,
  });
  return dockerExecFileSync(argv, {
    input,
    stdio: hasInput ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    timeout,
  });
}
