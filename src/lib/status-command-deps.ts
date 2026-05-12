// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0


import { spawnSync } from "node:child_process";

import { getLiveGatewayInference } from "./inference/live";
import type { MessagingBridgeHealth, ShowStatusCommandDeps } from "./inventory";
import { backfillMessagingChannels, findAllOverlaps } from "./messaging-conflict";
import type { CaptureOpenshellResult } from "./adapters/openshell/client";
import { captureOpenshellCommand, stripAnsi } from "./adapters/openshell/client";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import * as registry from "./state/registry";
import { resolveOpenshell } from "./adapters/openshell/resolve";
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

function isMissingProviderOutput(output: string): boolean {
  const normalized = stripAnsi(output).toLowerCase();
  return [
    /\bno such provider\b/,
    /\bno provider named\b/,
    /\bunknown provider\b/,
    /\bprovider\b[\s\S]{0,120}\bnot found\b/,
    /\bnot found\b[\s\S]{0,120}\bprovider\b/,
    /\bprovider\b[\s\S]{0,120}\bdoes not exist\b/,
  ].some((pattern) => pattern.test(normalized));
}

function makeConflictProbe(rootDir: string) {
  // Upfront liveness check so we can distinguish "provider not attached" from
  // "gateway unreachable". Provider probes also classify only explicit missing
  // provider responses as absent so status remains non-destructive under
  // transient transport, auth, or timeout failures.
  let gatewayAlive: boolean | null = null;
  const isGatewayAlive = (): boolean => {
    if (gatewayAlive === null) {
      const result = captureOpenshell(rootDir, ["sandbox", "list"], {
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      });
      gatewayAlive = result.status === 0;
    }
    return gatewayAlive;
  };
  return {
    providerExists: (name: string) => {
      if (!isGatewayAlive()) return "error" as const;
      const result = captureOpenshell(rootDir, ["provider", "get", name], {
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      });
      if (result.status === 0) return "present" as const;
      return isMissingProviderOutput(result.output) ? ("absent" as const) : ("error" as const);
    },
  };
}

function backfillAndFindOverlaps(rootDir: string) {
  // Non-critical path: status must remain usable even if the gateway probe or
  // registry write throws, so any failure yields an empty overlap list.
  try {
    backfillMessagingChannels(registry, makeConflictProbe(rootDir));
    return findAllOverlaps(registry);
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

export function buildStatusCommandDeps(rootDir: string): ShowStatusCommandDeps {
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
    checkMessagingBridgeHealth: (sandboxName, channels) =>
      checkMessagingBridgeHealth(rootDir, sandboxName, channels),
    backfillAndFindOverlaps: () => backfillAndFindOverlaps(rootDir),
    readGatewayLog: (sandboxName) => readGatewayLog(rootDir, sandboxName),
    log: console.log,
  };
}
