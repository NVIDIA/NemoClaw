// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createUninstallSandboxLifecycle,
  createUninstallSandboxObserver,
  type RunResult,
} from "../../adapters/uninstall/commands";
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
  sleep?(milliseconds: number): void;
  warn(message: string): void;
}

export async function deleteSelectedGatewaySandbox(
  runtime: UninstallRuntimeCommands,
  gatewayName: string,
  sandboxName: string,
): Promise<boolean> {
  const result = await createUninstallSandboxLifecycle(runtime.run, runtime.env).deleteSandbox({
    sandboxName,
    target: { kind: "named", gatewayName },
  });
  if (result.kind === "absent") {
    runtime.warn(sandboxDeleteAbsentMessage(sandboxName));
    return true;
  }
  if (result.kind === "failed" && !result.ambiguous) {
    runtime.warn(sandboxDeleteFailureMessage(sandboxName));
    return false;
  }
  const observer = createUninstallSandboxObserver(runtime.run, runtime.env);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const observed = await observer.listSandboxes({
      target: { kind: "named", gatewayName },
    });
    if (observed.ok && !observed.value.sandboxes.some((sandbox) => sandbox.name === sandboxName)) {
      runtime.log(`Deleted OpenShell sandbox '${sandboxName}'`);
      return true;
    }
    if (attempt < 4) runtime.sleep?.(200);
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
