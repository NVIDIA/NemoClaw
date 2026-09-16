// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  buildOpenShellSubprocessEnv,
  resolveOpenshellBinaryOrNull,
} from "../../adapters/openshell/resolve-shared";
import { parseSandboxPhase, sandboxPhaseNeedsLifecycleStart } from "../../state/gateway";
import { ROOT } from "../../state/paths";

export type CommandCapture = {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
};

export function captureHostCommand(
  command: string,
  args: string[],
  timeout = 5000,
  environment: NodeJS.ProcessEnv = process.env,
): CommandCapture {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: environment,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    status: result.status ?? (result.error || result.signal ? 1 : 0),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error,
  };
}

export type OpenShellHostCommandCapture = {
  status: number;
  output: string;
  error?: Error;
};

type OpenShellHostCommandDeps = {
  resolveExecutable?: typeof resolveOpenshellBinaryOrNull;
};

type OpenShellSandboxPhaseDeps = OpenShellHostCommandDeps & {
  captureCommand?: typeof captureOpenShellHostCommand;
};

/** Resolve and capture one bounded OpenShell host lifecycle command. */
export function captureOpenShellHostCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeout: number,
  deps: OpenShellHostCommandDeps = {},
): OpenShellHostCommandCapture {
  const executable = (deps.resolveExecutable ?? resolveOpenshellBinaryOrNull)(environment);
  if (!executable || !path.isAbsolute(executable)) {
    const error = new Error("OpenShell is unavailable");
    return { status: 1, output: error.message, error };
  }
  const result = captureHostCommand(
    executable,
    args,
    timeout,
    buildOpenShellSubprocessEnv(environment),
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`.trim(),
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Read the phase OpenShell reports for one sandbox, or null when the command
 * does not complete. OpenShell owns the sandbox phase, so a caller deciding
 * whether a sandbox still needs a lifecycle start must read it here rather than
 * infer it from the container's runtime status (#11790).
 */
export function readOpenShellSandboxPhase(
  sandboxName: string,
  gatewayName: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
  deps: OpenShellSandboxPhaseDeps = {},
): string | null {
  const probe = (deps.captureCommand ?? captureOpenShellHostCommand)(
    ["sandbox", "get", "-g", gatewayName, sandboxName],
    environment,
    timeout,
    deps,
  );
  if (probe.status !== 0 || probe.error) return null;
  return parseSandboxPhase(probe.output);
}

/** True only when OpenShell reports the phase that requires a lifecycle start. */
export function openShellSandboxNeedsLifecycleStart(
  sandboxName: string,
  gatewayName: string,
  environment: NodeJS.ProcessEnv,
  timeout: number,
  deps: OpenShellSandboxPhaseDeps = {},
): boolean {
  return sandboxPhaseNeedsLifecycleStart(
    readOpenShellSandboxPhase(sandboxName, gatewayName, environment, timeout, deps),
  );
}
