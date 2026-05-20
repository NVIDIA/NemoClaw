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

export const OPENSHELL_SANDBOX_NAME_LABEL = "openshell.ai/sandbox-name";

/**
 * Resolve a Docker-driver container by exact name only. The container that
 * OpenShell labels with `openshell.ai/sandbox-name=<name>` lives under the
 * canonical name `openshell-<name>`. Name-prefix inference is not safe — a
 * container named `openshell-<name>-<sandbox-id>` shares the prefix of
 * sandbox `<name>` even when it belongs to sandbox `<name>-<something>`.
 * The label-aware live path in `resolveDockerDriverSandboxContainer` handles
 * the version of OpenShell that tags containers; this helper exists for
 * tests and for the compat path where no labelled match was found.
 */
export function selectDockerDriverSandboxContainer(
  sandboxName: string,
  openshellDriver: string | null | undefined,
  containerNames: string,
): string | null {
  if (openshellDriver !== "docker") return null;
  const exact = `openshell-${sandboxName}`;
  const match = containerNames
    .split("\n")
    .map((line) => line.trim())
    .find((name) => name === exact);
  return match ?? null;
}

/**
 * Pick the canonical container for `sandboxName` from a label-filtered
 * `docker ps` output. When several containers share the label (e.g. helper
 * containers), prefer the canonical `openshell-<name>`; otherwise the first
 * one.
 */
export function selectLabelledSandboxContainer(
  sandboxName: string,
  containerNames: string,
): string | null {
  const trimmed = containerNames
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (trimmed.length === 0) return null;
  const exact = `openshell-${sandboxName}`;
  return trimmed.find((name) => name === exact) ?? trimmed[0] ?? null;
}

export function resolveDockerDriverSandboxContainer(sandboxName: string): string | null {
  let openshellDriver: string | null | undefined;
  try {
    openshellDriver = registry.getSandbox?.(sandboxName)?.openshellDriver;
  } catch {
    return null;
  }
  if (openshellDriver !== "docker") return null;

  const labelled = dockerCapture(
    [
      "ps",
      "--filter",
      `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--format",
      "{{.Names}}",
    ],
    { ignoreError: true },
  );
  const labelMatch = selectLabelledSandboxContainer(sandboxName, labelled);
  if (labelMatch) return labelMatch;

  // Fallback: older OpenShell sandboxes (pre-label) only get the exact
  // canonical name. We deliberately do not fall back to a name-prefix
  // match because the OpenShell Docker driver names containers
  // `openshell-<sandbox-name>-<sandbox-id>`, and that suffix can encode
  // another sandbox's name (sandbox `demo-prod` lives under
  // `openshell-demo-prod-<id>`, which would otherwise be accepted as a
  // container for sandbox `demo`).
  const output = dockerCapture(["ps", "--format", "{{.Names}}"], { ignoreError: true });
  return selectDockerDriverSandboxContainer(sandboxName, openshellDriver, output);
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
    // Don't use docker's `--user` flag for non-root targets — it switches
    // UID but inherits HOME from the calling shell, which causes tools
    // like Homebrew to write to /root/.cache and trip EACCES. `runuser`
    // (already used on the kubectl path) sets HOME to the target user's
    // home, so we get a clean per-user environment.
    return [
      "exec",
      ...(stdin ? ["-i"] : []),
      dockerDriverContainer,
      ...withUserPrefix(cmd, user),
    ];
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
