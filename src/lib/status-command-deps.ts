// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { CaptureOpenshellResult } from "./adapters/openshell/client";
import { captureOpenshellCommand } from "./adapters/openshell/client";
import { resolveOpenshell } from "./adapters/openshell/resolve";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import { getNamedGatewayLifecycleState } from "./gateway-runtime-action";
import { getLiveGatewayInference } from "./inference/live";
import type { GatewayHealth, MessagingBridgeHealth, ShowStatusCommandDeps } from "./inventory";
import { detectAllSlackSocketModeGatewayOverlaps, findAllOverlaps } from "./messaging/applier";
import * as registry from "./state/registry";
import { createSystemDeps, parseSshProcesses } from "./state/sandbox-session";
import { getServiceStatuses, showStatus as showServiceStatus } from "./tunnel/services";

function captureOpenshell(
  rootDir: string,
  args: string[],
  opts: { timeout?: number } = {},
): CaptureOpenshellResult {
  const openshell = resolveOpenshell();
  if (!openshell) {
    return { status: 1, output: "" };
  }
  return captureOpenshellCommand(openshell, args, {
    cwd: rootDir,
    ignoreError: true,
    timeout: opts.timeout,
  });
}

function checkMessagingBridgeHealth(
  rootDir: string,
  sandboxName: string,
  channels: string[],
): MessagingBridgeHealth[] {
  // Only Telegram currently emits a recognizable conflict signature in the
  // gateway log. Discord/Slack have similar single-consumer constraints but
  // log differently; we can extend the regex when those patterns are known.
  if (!Array.isArray(channels) || !channels.includes("telegram")) return [];
  const openshell = resolveOpenshell();
  if (!openshell) return [];
  const script =
    'tail -n 200 /tmp/gateway.log 2>/dev/null | grep -cE "getUpdates conflict|409[[:space:]:]+Conflict" || true';
  try {
    const result = spawnSync(
      openshell,
      ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-c", script],
      { cwd: rootDir, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const count = Number.parseInt((result.stdout || "").trim(), 10);
    if (!Number.isFinite(count) || count === 0) return [];
    return [{ channel: "telegram", conflicts: count }];
  } catch {
    return [];
  }
}

function findMessagingOverlaps() {
  // Non-critical path: status must remain usable even if overlap detection
  // throws, so any failure yields an empty overlap list.
  try {
    // Report both conflict axes independently and without deduping. They are
    // distinct, both-true facts: a shared messaging credential conflicts on any
    // gateway (the gateway-independent, more actionable signal), while two Slack
    // sandboxes on one gateway conflict even with distinct tokens (#4953). A
    // pair that hits both genuinely has two problems, so surfacing both avoids
    // masking the credential warning behind the gateway one.
    const credentialOverlaps = findAllOverlaps(registry);
    const slackGatewayOverlaps = detectAllSlackSocketModeGatewayOverlaps(
      registry.listSandboxes().sandboxes,
    );
    return [
      ...credentialOverlaps,
      ...slackGatewayOverlaps.map((o) => ({
        channel: "slack",
        sandboxes: o.sandboxes,
        reason: "slack-socket-mode-gateway" as const,
      })),
    ];
  } catch {
    return [];
  }
}

function readGatewayLog(rootDir: string, sandboxName: string): string | null {
  const openshell = resolveOpenshell();
  if (!openshell) return null;
  try {
    const result = spawnSync(
      openshell,
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--",
        "sh",
        "-c",
        "tail -n 10 /tmp/gateway.log 2>/dev/null",
      ],
      { cwd: rootDir, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = (result.stdout || "").trim();
    return output || null;
  } catch {
    return null;
  }
}

function probeGatewayHealth(): GatewayHealth {
  try {
    const lifecycle = getNamedGatewayLifecycleState();
    if (lifecycle.state === "healthy_named") {
      return { healthy: true, state: lifecycle.state };
    }
    const reasonByState: Record<string, string> = {
      named_unreachable: "host port held or container not running",
      named_unhealthy: "named gateway present but not Connected",
      connected_other: `connected to '${lifecycle.activeGateway ?? "unknown"}', not 'nemoclaw'`,
      missing_named: "named gateway not configured",
    };
    return {
      healthy: false,
      state: lifecycle.state,
      reason: reasonByState[lifecycle.state],
    };
  } catch {
    // A transient probe failure must not mask a real gateway problem, but
    // we also can't claim it's unhealthy when we genuinely couldn't tell.
    // Report it as a soft degraded state so the user still sees a hint.
    return { healthy: false, state: "probe_error", reason: "could not reach OpenShell CLI" };
  }
}

export function buildStatusCommandDeps(rootDir: string): ShowStatusCommandDeps {
  const opsBin = resolveOpenshell();
  const sessionDeps = opsBin ? createSystemDeps(opsBin) : null;
  // Cache the SSH process probe once per command invocation — avoids
  // spawning ps per sandbox row. #2604; mirrors buildListCommandDeps.
  let cachedSshOutput: string | null | undefined;
  const getCachedSshOutput = (): string | null => {
    if (cachedSshOutput === undefined && sessionDeps) {
      try {
        cachedSshOutput = sessionDeps.getSshProcesses();
      } catch {
        cachedSshOutput = null;
      }
    }
    return cachedSshOutput ?? null;
  };

  return {
    listSandboxes: () => registry.listSandboxes(),
    getLiveInference: () =>
      getLiveGatewayInference(
        (args, opts) =>
          captureOpenshell(rootDir, args, {
            timeout: opts?.timeout,
          }),
        { timeout: OPENSHELL_PROBE_TIMEOUT_MS },
      ).inference,
    showServiceStatus,
    getServiceStatuses,
    getGatewayHealth: probeGatewayHealth,
    getActiveSessionCount: sessionDeps
      ? (name) => {
          try {
            const sshOutput = getCachedSshOutput();
            if (sshOutput === null) return null;
            return parseSshProcesses(sshOutput, name).length;
          } catch {
            return null;
          }
        }
      : undefined,
    checkMessagingBridgeHealth: (sandboxName, channels) =>
      checkMessagingBridgeHealth(rootDir, sandboxName, channels),
    findMessagingOverlaps,
    readGatewayLog: (sandboxName) => readGatewayLog(rootDir, sandboxName),
    log: console.log,
  };
}
