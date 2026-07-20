// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type SandboxExecRequest,
  type SandboxExecResult,
  validateOpenShellExecRequest,
} from "../adapters/openshell/sandbox-control";
import { selectOpenShellSandboxControlForMutation } from "../adapters/openshell/sandbox-control-routing";
import * as agentRuntime from "../agent/runtime";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import { assertNoOpenShellGatewayEndpointOverride } from "../openshell-gateway-endpoint-guard";
import * as registry from "../state/registry";
import { GATEWAY_STOP_SCRIPT } from "./gateway-stop-script";

type Reporter = (message: string) => void;

export type SandboxGatewayStopDeps = {
  getSandbox?: typeof registry.getSandbox;
  getRegisteredAgent?: typeof agentRuntime.getRegisteredAgent;
  getAgentDisplayName?: typeof agentRuntime.getAgentDisplayName;
  hasGatewayRuntime?: typeof agentRuntime.hasGatewayRuntime;
  assertNoGatewayEndpointOverride?: typeof assertNoOpenShellGatewayEndpointOverride;
  selectControl?: typeof selectOpenShellSandboxControlForMutation;
  info?: Reporter;
  warn?: Reporter;
};

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const GATEWAY_STOP_TIMEOUT_MS = 20_000;
const GATEWAY_STOP_MAX_OUTPUT_BYTES = 64 * 1024;

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
export async function stopSandboxChannels(
  sandboxName: string,
  deps: SandboxGatewayStopDeps = {},
): Promise<void> {
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
  if (!sandbox) {
    warn(`Sandbox '${validatedSandboxName}' is not registered; skipping in-sandbox gateway stop.`);
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
  const request: SandboxExecRequest = {
    sandboxName: validatedSandboxName,
    command: ["sh", "-s"],
    stdin: GATEWAY_STOP_SCRIPT,
    timeoutMs: GATEWAY_STOP_TIMEOUT_MS,
    maxOutputBytes: GATEWAY_STOP_MAX_OUTPUT_BYTES,
  };
  const validationError = validateOpenShellExecRequest(request);
  info(`Stopping in-sandbox ${gatewayLabel} (sandbox: ${validatedSandboxName})...`);
  try {
    if (validationError) throw validationError;
    (deps.assertNoGatewayEndpointOverride ?? assertNoOpenShellGatewayEndpointOverride)();
    // Select once and never replay: a shutdown may commit before a transport
    // failure is observable, so retrying through another path is unsafe.
    const selected = (deps.selectControl ?? selectOpenShellSandboxControlForMutation)(gatewayName);
    try {
      const result = await selected.control.exec(request);
      reportStopResult(result, gatewayLabel, info, warn);
    } finally {
      selected.close();
    }
  } catch (error) {
    warn(
      `Could not stop ${gatewayLabel} inside sandbox: ${error instanceof Error ? error.message : String(error)}. ` +
        "The sandbox may be unreachable or the gateway may still be running.",
    );
  }
}

function reportStopResult(
  result: SandboxExecResult,
  gatewayLabel: string,
  info: Reporter,
  warn: Reporter,
): void {
  if (!result.error && !result.signal && result.status === 0) {
    info(`${gatewayLabel} stopped inside sandbox.`);
    return;
  }
  if (!result.error && !result.signal && result.status === 1) {
    info(`${gatewayLabel} was not running inside sandbox.`);
    return;
  }

  const details = [
    result.error?.message,
    result.signal ? `signal ${result.signal}` : undefined,
    result.stderr,
    result.stdout,
  ]
    .filter((text): text is string => typeof text === "string" && Boolean(text.trim()))
    .map((text) => text.trim())
    .join(" ");
  warn(
    `Could not stop ${gatewayLabel} inside sandbox (exit ${String(result.status ?? "unknown")}).` +
      " The sandbox may be unreachable or the gateway may still be running." +
      (details ? ` Details: ${details}` : ""),
  );
}
