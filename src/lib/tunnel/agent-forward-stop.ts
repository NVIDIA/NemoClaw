// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { resolveOpenshell } from "../adapters/openshell/resolve";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import * as agentRuntime from "../agent/runtime";
import { waitUntil } from "../core/wait";
import {
  bestEffortForwardStopForSandbox,
  type ForwardListRunner,
  type ForwardStopRunner,
} from "../onboard/forward-cleanup";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import * as registry from "../state/registry";
import { defaultProbePortFree } from "./gateway-port-confirmation";

type Reporter = (message: string) => void;

type AgentWithForwards = {
  displayName?: string;
  forward_ports?: unknown;
};

type SandboxWithDashboardPort = {
  agent?: string | null;
  dashboardPort?: unknown;
  gatewayName?: string | null;
  gatewayPort?: number | null;
};

type StopAgentForwardPortsDeps = {
  getRegisteredAgent?: (sandbox: SandboxWithDashboardPort | null) => AgentWithForwards | null;
  getAgentDisplayName?: (agent: AgentWithForwards | null) => string;
  getSandbox?: (sandboxName: string) => SandboxWithDashboardPort | null;
  resolveOpenshell?: () => string | null;
  runOpenshell?: ForwardStopRunner;
  runCaptureOpenshell?: ForwardListRunner;
  confirmPortReleased?: (port: number) => boolean;
  info?: Reporter;
  warn?: Reporter;
};

const FORWARD_RELEASE_TIMEOUT_MS = 5000;
const FORWARD_RELEASE_POLL_MS = 250;
const SAFE_SANDBOX_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function confirmForwardPortReleased(port: number): boolean {
  const now = Date.now;
  return waitUntil(() => defaultProbePortFree(port), {
    deadlineMs: now() + FORWARD_RELEASE_TIMEOUT_MS,
    maxAttempts: 20,
    initialIntervalMs: FORWARD_RELEASE_POLL_MS,
    maxIntervalMs: FORWARD_RELEASE_POLL_MS,
    backoffFactor: 1,
    now,
  });
}

function getAgentForwardPorts(agent: AgentWithForwards, dashboardPort: unknown): number[] {
  const ports = new Set<number>();
  // The gateway establishes dashboardPort at runtime even when it is not manifest-declared.
  const candidates = [
    ...(Array.isArray(agent.forward_ports) ? agent.forward_ports : []),
    dashboardPort,
  ];
  for (const rawPort of candidates) {
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && /^\d+$/.test(rawPort.trim())
          ? Number(rawPort.trim())
          : NaN;
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      ports.add(port);
    }
  }
  return [...ports];
}

function makeRunOpenshell(openshell: string): ForwardStopRunner {
  return (args, opts) => {
    const result = spawnSync(openshell, args, {
      encoding: "utf-8",
      stdio: opts.suppressOutput ? "ignore" : "inherit",
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (!opts.ignoreError && result.status !== 0) {
      throw new Error(`openshell ${args.join(" ")} failed`);
    }
    return result;
  };
}

function makeRunCaptureOpenshell(openshell: string): ForwardListRunner {
  return (args, opts) => {
    const result = spawnSync(openshell, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout,
    });
    if (result.status !== 0) {
      throw new Error(`openshell ${args.join(" ")} failed`);
    }
    return result.stdout || "";
  };
}

export function stopAgentForwardPortsForStop(
  sandboxName: string | undefined,
  deps: StopAgentForwardPortsDeps = {},
): void {
  if (!sandboxName) return;

  const warn = deps.warn ?? (() => {});
  if (!SAFE_SANDBOX_NAME_RE.test(sandboxName) || sandboxName.includes("..")) {
    warn(`Invalid sandbox name: ${JSON.stringify(sandboxName)} - skipping host forward cleanup.`);
    return;
  }

  const info = deps.info ?? (() => {});
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  let sandbox: SandboxWithDashboardPort | null;
  try {
    sandbox = getSandbox(sandboxName);
  } catch (error) {
    warn(
      `Could not read the sandbox registry for '${sandboxName}': ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "Skipping agent host port forward cleanup.",
    );
    return;
  }
  if (!sandbox) {
    warn(
      `Could not resolve sandbox '${sandboxName}' - cannot safely stop agent host port forwards.`,
    );
    return;
  }

  const getRegisteredAgent = deps.getRegisteredAgent ?? agentRuntime.getRegisteredAgent;
  const agent = getRegisteredAgent(sandbox);
  if (sandbox.agent && sandbox.agent !== "openclaw" && !agent) {
    warn(
      `Could not resolve registered agent '${sandbox.agent}' for sandbox '${sandboxName}'; ` +
        "skipping agent host port forward cleanup.",
    );
    return;
  }
  if (!agent) return;

  const displayName = deps.getAgentDisplayName
    ? deps.getAgentDisplayName(agent)
    : agentRuntime.getAgentDisplayName(
        agent as Parameters<typeof agentRuntime.getAgentDisplayName>[0],
      );
  let gatewayName: string;
  try {
    gatewayName = resolveSandboxGatewayName(sandbox);
  } catch (error) {
    warn(
      `Could not resolve the OpenShell gateway for sandbox '${sandboxName}': ` +
        `${(error as Error).message ?? String(error)}. ` +
        `Skipping ${displayName} host port forward cleanup.`,
    );
    return;
  }

  const ports = getAgentForwardPorts(agent, sandbox.dashboardPort);
  if (ports.length === 0) return;

  const openshell = (deps.resolveOpenshell ?? resolveOpenshell)();
  if (!openshell) {
    warn(`openshell not found - cannot stop ${displayName} host port forwards.`);
    return;
  }

  const runOpenshell = deps.runOpenshell ?? makeRunOpenshell(openshell);
  const runCaptureOpenshell = deps.runCaptureOpenshell ?? makeRunCaptureOpenshell(openshell);
  const scopedRunOpenshell: ForwardStopRunner = (args, opts) =>
    runOpenshell([...args, "--gateway", gatewayName], opts);
  const scopedRunCaptureOpenshell: ForwardListRunner = (args, opts) =>
    runCaptureOpenshell([...args, "--gateway", gatewayName], opts);
  const confirmPortReleased = deps.confirmPortReleased ?? confirmForwardPortReleased;

  for (const port of ports) {
    const result = bestEffortForwardStopForSandbox(
      scopedRunOpenshell,
      scopedRunCaptureOpenshell,
      port,
      sandboxName,
    );
    if (result === "owned-other") {
      warn(
        `Keeping ${displayName} host port forward ${String(port)}; it belongs to another sandbox.`,
      );
      continue;
    }
    if (result === "list-failed") {
      warn(
        `Could not enumerate OpenShell forwards; skipping ${displayName} host port forward ${String(
          port,
        )} cleanup.`,
      );
      continue;
    }

    if (!confirmPortReleased(port)) {
      warn(
        `Could not confirm ${displayName} host port forward ${String(port)} was released ` +
          `within ${String(FORWARD_RELEASE_TIMEOUT_MS / 1000)} seconds; ` +
          "the listener may still be running.",
      );
    } else if (result === "stopped") {
      info(
        `Stopped ${displayName} host port forward ${String(port)} for sandbox '${sandboxName}'.`,
      );
    }
  }
}
