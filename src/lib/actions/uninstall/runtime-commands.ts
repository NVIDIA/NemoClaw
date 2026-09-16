// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunResult } from "../../adapters/uninstall/commands";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import {
  sandboxDeleteAbsentMessage,
  sandboxDeleteFailureMessage,
} from "../../domain/uninstall/messaging";
import { isOllamaAuthProxyCommandLine } from "../../inference/ollama/process";
import { isModelRouterCommandLineForPort } from "../../onboard/model-router-process";

interface UninstallRuntimeCommands {
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  run(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): RunResult;
  warn(message: string): void;
}

export function deleteSelectedGatewaySandbox(
  runtime: UninstallRuntimeCommands,
  gatewayName: string,
  sandboxName: string,
): boolean {
  const result = runtime.run("openshell", ["sandbox", "delete", "-g", gatewayName, sandboxName], {
    env: runtime.env,
  });
  if (result.status === 0) {
    runtime.log(`Deleted OpenShell sandbox '${sandboxName}'`);
    return true;
  }
  if (getSandboxDeleteOutcome(result).alreadyGone) {
    runtime.warn(sandboxDeleteAbsentMessage(sandboxName));
    return true;
  }
  runtime.warn(sandboxDeleteFailureMessage(sandboxName));
  return false;
}

export function isOllamaAuthProxyPid(pid: number, runtime: UninstallRuntimeCommands): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "args="], { env: runtime.env });
  return result.status === 0 && isOllamaAuthProxyCommandLine(result.stdout);
}

// `ps -p <pid>` is preferred over `kill(pid, 0)` because the runtime kill
// boundary collapses EPERM (present but unsignalable) and ESRCH (absent).
export function pidExists(pid: number, runtime: UninstallRuntimeCommands): boolean {
  return runtime.run("ps", ["-p", String(pid), "-o", "pid="], { env: runtime.env }).status === 0;
}

export function isModelRouterPid(
  pid: number,
  port: number,
  runtime: UninstallRuntimeCommands,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !pidExists(pid, runtime)) return false;
  const result = runtime.run("ps", ["-p", String(pid), "-o", "args="], { env: runtime.env });
  if (result.status !== 0) return false;
  const args = result.stdout.trim().split(/\s+/).filter(Boolean);
  return isModelRouterCommandLineForPort(args, port);
}
