// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";

import { dockerSpawnSync } from "../adapters/docker";
import { getGatewayClusterContainerName } from "../adapters/openshell/gateway-drift";
import { resolveOpenshell } from "../adapters/openshell/resolve";
import * as agentRuntime from "../agent/runtime";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import * as registry from "../state/registry";
import { GATEWAY_STOP_SCRIPT } from "./gateway-stop-script";

type Reporter = (message: string) => void;
type StopAttemptResult = ReturnType<typeof spawnSync>;
type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export type SandboxGatewayStopDeps = {
  getSandbox?: typeof registry.getSandbox;
  getRegisteredAgent?: typeof agentRuntime.getRegisteredAgent;
  getAgentDisplayName?: typeof agentRuntime.getAgentDisplayName;
  hasGatewayRuntime?: typeof agentRuntime.hasGatewayRuntime;
  resolveOpenshell?: typeof resolveOpenshell;
  runDocker?: typeof dockerSpawnSync;
  runProcess?: ProcessRunner;
  info?: Reporter;
  warn?: Reporter;
};

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function defaultInfo(message: string): void {
  console.log(`[services] ${message}`);
}

function defaultWarn(message: string): void {
  console.log(`[services] ${message}`);
}

function validateSandboxName(name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`Invalid sandbox name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Stop only a proven OpenClaw gateway; supervised agents remain owned by their sandbox. */
export function stopSandboxChannels(sandboxName: string, deps: SandboxGatewayStopDeps = {}): void {
  const info = deps.info ?? defaultInfo;
  const warn = deps.warn ?? defaultWarn;
  const validatedSandboxName = validateSandboxName(sandboxName);
  let sandbox: ReturnType<typeof registry.getSandbox>;
  try {
    sandbox = (deps.getSandbox ?? registry.getSandbox)(validatedSandboxName);
  } catch (error) {
    warn(
      `Could not read the sandbox registry for '${validatedSandboxName}': ` +
        `${(error as Error).message ?? String(error)}. Skipping in-sandbox gateway stop.`,
    );
    return;
  }
  const agent = (deps.getRegisteredAgent ?? agentRuntime.getRegisteredAgent)(sandbox);

  if (sandbox?.agent && sandbox.agent !== "openclaw" && !agent) {
    warn(
      `Could not resolve registered agent '${sandbox.agent}' for sandbox ` +
        `'${validatedSandboxName}'; skipping in-sandbox gateway stop.`,
    );
    return;
  }
  if (!(deps.hasGatewayRuntime ?? agentRuntime.hasGatewayRuntime)(agent)) {
    const agentDisplayName = (deps.getAgentDisplayName ?? agentRuntime.getAgentDisplayName)(agent);
    info(`${agentDisplayName} has no gateway runtime; skipping in-sandbox gateway stop.`);
    return;
  }

  const agentDisplayName = (deps.getAgentDisplayName ?? agentRuntime.getAgentDisplayName)(agent);
  if (agent) {
    info(
      `${agentDisplayName} gateway is managed by the sandbox; ` +
        "leaving it running while host forwards stop.",
    );
    return;
  }

  let gatewayName: string;
  try {
    gatewayName = resolveSandboxGatewayName(sandbox);
  } catch (error) {
    warn(
      `Could not resolve the OpenShell gateway for sandbox '${validatedSandboxName}': ` +
        `${(error as Error).message ?? String(error)}. Skipping in-sandbox gateway stop.`,
    );
    return;
  }

  const gatewayLabel = `${agentDisplayName} gateway`;
  info(`Stopping in-sandbox ${gatewayLabel} (sandbox: ${validatedSandboxName})...`);

  const privilegedResult = stopSandboxChannelsViaKubectl(
    validatedSandboxName,
    gatewayName,
    GATEWAY_STOP_SCRIPT,
    deps.runDocker ?? dockerSpawnSync,
  );
  if (reportStopResult(privilegedResult, gatewayLabel, info, warn)) return;

  const openshell = (deps.resolveOpenshell ?? resolveOpenshell)();
  if (!openshell) {
    warn(`openshell not found — cannot stop ${gatewayLabel} inside sandbox.`);
    return;
  }

  const fallbackResult = (deps.runProcess ?? spawnSync)(
    openshell,
    ["sandbox", "exec", "--name", validatedSandboxName, "--gateway", gatewayName, "--", "sh", "-s"],
    {
      encoding: "utf-8",
      input: GATEWAY_STOP_SCRIPT,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20000,
    },
  );
  reportStopResult(fallbackResult, gatewayLabel, info, warn);
}

function isSandboxPodName(line: string, sandboxName: string): boolean {
  if (!line.startsWith("pod/")) return false;
  const podName = line.slice("pod/".length);
  if (podName === sandboxName) return true;
  const prefix = `${sandboxName}-`;
  if (!podName.startsWith(prefix)) return false;
  const generatedSuffix = podName.slice(prefix.length);
  return /^[a-z0-9]+$/.test(generatedSuffix);
}

function stopSandboxChannelsViaKubectl(
  sandboxName: string,
  gatewayName: string,
  gatewayStopScript: string,
  runDocker: typeof dockerSpawnSync,
): StopAttemptResult | null {
  const gatewayContainer = getGatewayClusterContainerName(gatewayName);
  const podsResult = runDocker(
    ["exec", gatewayContainer, "kubectl", "get", "pods", "-n", "openshell", "-o", "name"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
  );
  if (podsResult.status !== 0 || !podsResult.stdout) return null;

  const podOutput =
    typeof podsResult.stdout === "string" ? podsResult.stdout : podsResult.stdout.toString();
  const pod = podOutput
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .find((line: string) => isSandboxPodName(line, sandboxName));
  if (!pod) return null;

  return runDocker(
    [
      "exec",
      gatewayContainer,
      "kubectl",
      "exec",
      "-n",
      "openshell",
      "-c",
      "agent",
      pod,
      "--",
      "sh",
      "-lc",
      gatewayStopScript,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 },
  );
}

function reportStopResult(
  result: StopAttemptResult | null,
  gatewayLabel: string,
  info: Reporter,
  warn: Reporter,
): boolean {
  if (!result) return false;

  if (result.status === 0) {
    info(`${gatewayLabel} stopped inside sandbox.`);
    return true;
  }
  if (result.status === 1) {
    info(`${gatewayLabel} was not running inside sandbox.`);
    return true;
  }

  const details = [result.stderr, result.stdout]
    .map((text) => (typeof text === "string" ? text : text?.toString()))
    .filter((text): text is string => Boolean(text?.trim()))
    .map((text) => text.trim())
    .join(" ");
  warn(
    `Could not stop ${gatewayLabel} inside sandbox (exit ${String(result.status ?? "unknown")}).` +
      " The sandbox may be unreachable or the gateway may still be running." +
      (details ? ` Details: ${details}` : ""),
  );
  return true;
}
