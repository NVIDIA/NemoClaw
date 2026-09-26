// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";

import {
  createUninstallSandboxLifecycle,
  createUninstallSandboxObserver,
  type RunResult,
} from "../../adapters/uninstall/commands";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { OPENSHELL_DEFAULT_WORKSPACE } from "../../adapters/openshell/sandbox-ssh-host";
import {
  OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE,
  sandboxDeleteAbsentMessage,
  sandboxDeleteFailureMessage,
} from "../../domain/uninstall/messaging";
import { isOllamaAuthProxyCommandLine } from "../../inference/ollama/process";
import { isModelRouterCommandLineForPort } from "../../onboard/model-router-process";
import { MANAGED_STARTUP_RECEIPT_VOLUME_PREFIX } from "../../onboard/managed-startup/docker-receipt-transfer";
import {
  dockerDriverGatewayLocalTlsAuthorityIsConfigured,
  resolveCompleteDockerDriverGatewayLocalTlsDir,
} from "../../onboard/docker-driver-gateway-local-tls";

interface UninstallRuntimeCommands {
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  run(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): RunResult;
  sleep?(milliseconds: number): void;
  warn(message: string): void;
}

interface ForceFreshDockerCleanupRuntime {
  env: NodeJS.ProcessEnv;
  error(message: string): void;
  log(message: string): void;
  runDocker(args: string[], options?: SpawnSyncOptions): RunResult;
}

const MANAGED_STARTUP_RECEIPT_VOLUME_PATTERN = new RegExp(
  `^${MANAGED_STARTUP_RECEIPT_VOLUME_PREFIX}-[0-9a-f]{32}$`,
  "u",
);
const BULK_DELETE_MAX_OBSERVATIONS = 5;
const BULK_DELETE_REQUIRED_EMPTY_OBSERVATIONS = 2;

export function selectedGatewayCleanupRuntimeSelection(
  gatewayName: string,
  gatewayStateDir: string,
): OpenShellRuntimeSelection | null {
  const localTlsDir = resolveCompleteDockerDriverGatewayLocalTlsDir(gatewayStateDir);
  if (!localTlsDir && dockerDriverGatewayLocalTlsAuthorityIsConfigured(gatewayStateDir))
    return null;
  return {
    gatewayName,
    workspace: OPENSHELL_DEFAULT_WORKSPACE,
    ...(localTlsDir ? { localTlsDir } : {}),
  };
}

function nonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function forceFreshReceiptVolumeMatches(runtime: ForceFreshDockerCleanupRuntime): string[] | null {
  const inventory = runtime.runDocker(["volume", "ls", "--format", "{{.Name}}"], {
    env: runtime.env,
  });
  if (inventory.status !== 0) {
    runtime.error(
      "Could not inventory managed-startup receipt volumes during force-fresh cleanup.",
    );
    return null;
  }
  return nonEmptyLines(inventory.stdout).filter((name) =>
    MANAGED_STARTUP_RECEIPT_VOLUME_PATTERN.test(name),
  );
}

export function removeForceFreshReceiptVolumes(runtime: ForceFreshDockerCleanupRuntime): boolean {
  const volumes = forceFreshReceiptVolumeMatches(runtime);
  if (volumes === null) return false;
  const [unverified] = volumes;
  if (unverified) {
    runtime.error(
      `Preserved managed-startup receipt volume '${unverified}' because its Docker name and mutable label are not trusted ownership proof.`,
    );
    return false;
  }
  return true;
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

export async function deleteAllSelectedGatewaySandboxes(
  runtime: UninstallRuntimeCommands,
  runtimeSelection: OpenShellRuntimeSelection | null,
): Promise<boolean> {
  if (!runtimeSelection) {
    runtime.warn(
      "OpenShell selected-gateway cleanup authority is incomplete; preserving its state for retry.",
    );
    return false;
  }
  const result = await createUninstallSandboxLifecycle(runtime.run, runtime.env).deleteAllSandboxes(
    { target: { kind: "selected" }, runtimeSelection },
  );
  if (
    result.kind === "failed" &&
    result.error.kind === "command" &&
    result.error.reason === "invalid_request"
  ) {
    runtime.warn("OpenShell rejected the selected-gateway sandbox cleanup request.");
    return false;
  }

  const observer = createUninstallSandboxObserver(runtime.run, runtime.env, runtimeSelection);
  let consecutiveEmptyObservations = 0;
  let lastObservationError: string | null = null;
  for (let attempt = 0; attempt < BULK_DELETE_MAX_OBSERVATIONS; attempt += 1) {
    const observed = await observer.listSandboxes({ target: { kind: "selected" } });
    lastObservationError = observed.ok ? null : observed.error.message;
    consecutiveEmptyObservations =
      observed.ok && observed.value.sandboxes.length === 0 ? consecutiveEmptyObservations + 1 : 0;
    if (consecutiveEmptyObservations >= BULK_DELETE_REQUIRED_EMPTY_OBSERVATIONS) {
      if (result.kind === "accepted") runtime.log("Deleted all OpenShell sandboxes");
      else runtime.warn(OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE);
      return true;
    }
    if (attempt < BULK_DELETE_MAX_OBSERVATIONS - 1) runtime.sleep?.(200);
  }
  runtime.warn(
    lastObservationError
      ? `OpenShell sandbox cleanup was incomplete because inventory could not be verified: ${lastObservationError} Preserving its state for retry.`
      : "OpenShell sandbox cleanup was incomplete; preserving its state for retry.",
  );
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
