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
): string | null {
  if (openshellDriver !== "docker") return null;
  const prefix = `openshell-${sandboxName}-`;
  const exact = `openshell-${sandboxName}`;
  return (
    containerNames
      .split("\n")
      .map((line) => line.trim())
      .find((name) => name === exact || name.startsWith(prefix)) || null
  );
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
