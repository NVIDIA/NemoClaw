// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  createUninstallSandboxLifecycle,
  createUninstallSandboxObserver,
  type RunResult,
} from "../../adapters/uninstall/commands";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { OPENSHELL_DEFAULT_WORKSPACE } from "../../adapters/openshell/sandbox-ssh-host";
import {
  sandboxDeleteAbsentMessage,
  sandboxDeleteFailureMessage,
} from "../../domain/uninstall/messaging";
import { isOllamaAuthProxyCommandLine } from "../../inference/ollama/process";
import { isModelRouterCommandLineForPort } from "../../onboard/model-router-process";
import { MANAGED_STARTUP_RECEIPT_VOLUME_PREFIX } from "../../onboard/managed-startup/docker-receipt-transfer";
import { resolveLegacyModelRouterPort } from "../../core/model-router-port";
import {
  dockerDriverGatewayLocalTlsAuthorityIsConfigured,
  resolveCompleteDockerDriverGatewayLocalTlsDir,
} from "../../onboard/docker-driver-gateway-local-tls";

interface RecordedModelRouter {
  pid: number | null;
  port: number | null;
  expected: boolean;
  readFailed?: true;
}

export function readOnboardSessionModelRouter(stateDir: string): RecordedModelRouter {
  const sessionFile = path.join(stateDir, "onboard-session.json");
  try {
    const raw = fs.readFileSync(sessionFile, "utf-8");
    const data = JSON.parse(raw) as {
      provider?: unknown;
      endpointUrl?: unknown;
      routerCredentialHash?: unknown;
      routerPid?: unknown;
      routerPort?: unknown;
    };
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("The onboarding session must be an object");
    }
    if (data.routerPort === null && data.routerPid === null && data.routerCredentialHash === null) {
      return { pid: null, port: null, expected: false };
    }
    const pid =
      typeof data.routerPid === "number" && Number.isInteger(data.routerPid) && data.routerPid > 0
        ? data.routerPid
        : null;
    const port =
      typeof data.routerPort === "number" &&
      Number.isInteger(data.routerPort) &&
      data.routerPort > 0 &&
      data.routerPort <= 65535
        ? data.routerPort
        : data.routerPort == null
          ? resolveLegacyModelRouterPort(data)
          : null;
    return {
      pid,
      port,
      expected:
        data.provider === "nvidia-router" ||
        pid !== null ||
        typeof data.routerCredentialHash === "string",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { pid: null, port: null, expected: true, readFailed: true };
    }
  }
  return { pid: null, port: null, expected: false };
}

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
  if (result.kind !== "accepted") {
    runtime.warn(
      result.error.kind === "command" && result.error.reason === "invalid_request"
        ? "OpenShell rejected the selected-gateway sandbox cleanup request."
        : "OpenShell sandbox cleanup was not accepted; preserving its state for retry.",
    );
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
      runtime.log("Deleted all OpenShell sandboxes");
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
