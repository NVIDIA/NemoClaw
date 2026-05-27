// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDefinition } from "../agent/defs";
import { DASHBOARD_PORT } from "../core/ports";
import { buildChain, buildControlUiUrls } from "../dashboard/contract";
import * as nim from "../inference/nim";
import { runCapture as defaultRunCapture } from "../runner";
import * as dashboardAccess from "./dashboard-access";
import {
  findAvailableDashboardPort,
  getOccupiedPorts,
  isLiveForwardStatus,
} from "./dashboard-port";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import {
  buildDetachedForwardStartSpawn,
  buildForwardStartProgressLogger,
  looksLikeForwardPortConflict,
  runDetachedForwardStartWithPortReleaseRetries,
} from "./forward-start";
import { bestEffortForwardStop, bestEffortForwardStopForSandbox } from "./forward-cleanup";

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;
export const CONTROL_UI_PORT = DASHBOARD_PORT;

type CommandResult = { status: number | null };

export interface OnboardDashboardDeps {
  runOpenshell(args: string[], opts?: Record<string, unknown>): CommandResult;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
  openshellArgv(args: string[]): string[];
  runCapture?: typeof defaultRunCapture;
  cliName(): string;
  agentProductName(): string;
  getProviderLabel(provider: string): string;
  nimStatus?: typeof nim.nimStatus;
  nimStatusByName?: typeof nim.nimStatusByName;
  shouldShowNimLine?: typeof nim.shouldShowNimLine;
  note(message: string): void;
  isWsl(): boolean;
  redact(value: unknown): string;
  sleep(seconds: number): void;
  printAgentDashboardUi(
    sandboxName: string,
    token: string | null,
    agent: AgentDefinition,
    deps: {
      note: (msg: string) => void;
      buildControlUiUrls: (token: string | null, port: number) => string[];
    },
  ): void;
}

export interface OnboardDashboardHelpers {
  buildChain: typeof buildChain;
  buildControlUiUrls: typeof buildControlUiUrls;
  buildOrphanedSandboxRollbackMessage(
    sandboxName: string,
    err: unknown,
    deleteSucceeded: boolean,
  ): string[];
  ensureDashboardForward(
    sandboxName: string,
    chatUiUrl?: string,
    options?: { rollbackSandboxOnFailure?: boolean },
  ): number;
  ensureAgentDashboardForward(
    sandboxName: string,
    agent: { forwardPort?: number | null },
  ): number;
  fetchGatewayAuthTokenFromSandbox(sandboxName: string): string | null;
  getDashboardForwardPort(
    chatUiUrl?: string,
    options?: Parameters<typeof dashboardAccess.getDashboardForwardPort>[1],
  ): string;
  getDashboardForwardTarget(
    chatUiUrl?: string,
    options?: Parameters<typeof dashboardAccess.getDashboardForwardTarget>[1],
  ): string;
  getWslHostAddress(
    options?: Parameters<typeof dashboardAccess.getWslHostAddress>[0],
  ): string | null;
  printDashboard(
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer?: string | null,
    agent?: AgentDefinition | null,
  ): void;
  stopAllDashboardForwards(): void;
}

function findForwardEntry(
  forwardListOutput: string | null | undefined,
  port: string,
): { sandboxName: string; status: string } | null {
  if (!forwardListOutput) return null;
  for (const rawLine of forwardListOutput.split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    if (/^\s*SANDBOX\s/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[2] !== port) continue;
    return {
      sandboxName: parts[0] || "",
      status: (parts[4] || "").toLowerCase(),
    };
  }
  return null;
}

function getRunningForwardPorts(forwardListOutput: string | null | undefined): string[] {
  const ports = new Set<string>();
  if (!forwardListOutput) return [];
  for (const rawLine of forwardListOutput.split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    if (/^\s*SANDBOX\s/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^\d+$/.test(parts[2])) continue;
    const status = (parts[4] || "").toLowerCase();
    if (isLiveForwardStatus(status)) {
      ports.add(parts[2]);
    }
  }
  return [...ports];
}

function findOpenclawJsonPath(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found: string | null = findOpenclawJsonPath(entryPath);
      if (found) return found;
    } else if (entry.name === "openclaw.json") {
      return entryPath;
    }
  }
  return null;
}

function dashboardUrlForDisplay(url: string, deps: OnboardDashboardDeps): string {
  return dashboardAccess.dashboardUrlForDisplay(url, deps.redact);
}

export function createOnboardDashboardHelpers(deps: OnboardDashboardDeps): OnboardDashboardHelpers {
  const runCapture = deps.runCapture ?? defaultRunCapture;

  function getDashboardForwardPort(
    chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
    options: Parameters<typeof dashboardAccess.getDashboardForwardPort>[1] = {},
  ): string {
    return dashboardAccess.getDashboardForwardPort(chatUiUrl, {
      ...options,
      runCapture: options.runCapture || runCapture,
    });
  }

  function getDashboardForwardTarget(
    chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
    options: Parameters<typeof dashboardAccess.getDashboardForwardTarget>[1] = {},
  ): string {
    return dashboardAccess.getDashboardForwardTarget(chatUiUrl, {
      ...options,
      runCapture: options.runCapture || runCapture,
    });
  }

  function getWslHostAddress(
    options: Parameters<typeof dashboardAccess.getWslHostAddress>[0] = {},
  ): string | null {
    return dashboardAccess.getWslHostAddress({ ...options, runCapture: options.runCapture || runCapture });
  }

  function stopAllDashboardForwards(): void {
    const forwardList = deps.runCaptureOpenshell(["forward", "list"], { ignoreError: true });
    for (const port of getRunningForwardPorts(forwardList)) {
      bestEffortForwardStop(deps.runOpenshell, port);
    }
  }

  function buildOrphanedSandboxRollbackMessage(
    sandboxName: string,
    err: unknown,
    deleteSucceeded: boolean,
  ): string[] {
    const lines = [
      "",
      `  Could not allocate a dashboard port for '${sandboxName}'.`,
      `  ${err instanceof Error ? err.message : String(err)}`,
    ];
    if (deleteSucceeded) {
      lines.push("  The orphaned sandbox has been removed — you can safely retry.");
    } else {
      lines.push("  Could not remove the orphaned sandbox. Manual cleanup:");
      lines.push(`    openshell sandbox delete "${sandboxName}"`);
    }
    return lines;
  }

  function rollbackSandboxAndExit(sandboxName: string, err: unknown): never {
    const delResult = deps.runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    for (const line of buildOrphanedSandboxRollbackMessage(
      sandboxName,
      err,
      delResult.status === 0,
    )) {
      console.error(line);
    }
    process.exit(1);
  }

  function ensureDashboardForward(
    sandboxName: string,
    chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`,
    options: { rollbackSandboxOnFailure?: boolean } = {},
  ): number {
    const { rollbackSandboxOnFailure = false } = options;
    const preferredPort = Number(getDashboardForwardPort(chatUiUrl));
    const stopForwardForSandbox = (port: string | number) =>
      bestEffortForwardStopForSandbox(
        deps.runOpenshell,
        (args, opts) => (deps.runCaptureOpenshell(args, opts) ?? "") as string,
        port,
        sandboxName,
      );
    let existingForwards = deps.runCaptureOpenshell(["forward", "list"], { ignoreError: true });
    const preferredEntry = findForwardEntry(existingForwards, String(preferredPort));
    if (
      preferredEntry &&
      (preferredEntry.sandboxName === sandboxName || !isLiveForwardStatus(preferredEntry.status))
    ) {
      stopForwardForSandbox(preferredPort);
      existingForwards = deps.runCaptureOpenshell(["forward", "list"], { ignoreError: true });
    }
    let actualPort: number;
    try {
      actualPort = findAvailableDashboardPort(sandboxName, preferredPort, existingForwards);
    } catch (err) {
      if (!rollbackSandboxOnFailure) throw err;
      rollbackSandboxAndExit(sandboxName, err);
    }

    if (actualPort !== preferredPort) {
      if (rollbackSandboxOnFailure) {
        const err = new Error(
          `Dashboard port ${preferredPort} became host-bound during sandbox build; ` +
            `cannot reallocate to ${actualPort} after the sandbox has been created with ` +
            `CHAT_UI_URL=${preferredPort}. Free the port and re-run \`${deps.cliName()} onboard\`, ` +
            `or pass \`--control-ui-port <N>\` to pick a different dashboard port.`,
        );
        rollbackSandboxAndExit(sandboxName, err);
      }
      console.warn(`  ! Port ${preferredPort} is taken. Using port ${actualPort} instead.`);
    }

    const occupied = getOccupiedPorts(existingForwards);
    for (const [port, owner] of occupied.entries()) {
      if (owner === sandboxName && Number(port) !== actualPort) {
        stopForwardForSandbox(port);
      }
    }

    const parsedUrl = new URL(chatUiUrl.includes("://") ? chatUiUrl : `http://${chatUiUrl}`);
    parsedUrl.port = String(actualPort);
    const actualTarget = getDashboardForwardTarget(parsedUrl.toString());
    stopForwardForSandbox(actualPort);
    const { ok: fwdOk, diagnostic: fwdDiagnostic } = runDetachedForwardStartWithPortReleaseRetries(
      buildDetachedForwardStartSpawn(
        deps.openshellArgv(["forward", "start", "--background", actualTarget, sandboxName]),
      ),
      () =>
        (deps.runCaptureOpenshell(["forward", "list"], { timeout: OPENSHELL_PROBE_TIMEOUT_MS }) ?? "") as string,
      { port: actualPort, sandboxName },
      () => {
        deps.sleep(1);
        stopForwardForSandbox(actualPort);
      },
      { onProgress: buildForwardStartProgressLogger(actualPort) },
    );
    if (!fwdOk) {
      const looksLikePortConflict = looksLikeForwardPortConflict(fwdDiagnostic);
      if (rollbackSandboxOnFailure) {
        const err = new Error(
          looksLikePortConflict
            ? `Failed to start dashboard forward on port ${actualPort} — the host port ` +
                `is held by another process. Free it and run \`${deps.cliName()} onboard\` again, ` +
                `or pass \`--control-ui-port <N>\` to pick a different dashboard port.`
            : `Failed to start dashboard forward on port ${actualPort}: ${fwdDiagnostic.slice(0, 240)}`,
        );
        rollbackSandboxAndExit(sandboxName, err);
      }
      if (looksLikePortConflict) {
        console.warn(
          `! Port ${actualPort} forward did not start — port may be in use by another process.`,
        );
        console.warn(
          `  Check: docker ps --format 'table {{.Names}}\\t{{.Ports}}' | grep ${actualPort}`,
        );
        console.warn(`  Free the port, then reconnect: ${deps.cliName()} ${sandboxName} connect`);
      } else {
        console.warn(`! Port ${actualPort} forward did not start: ${fwdDiagnostic.slice(0, 240)}`);
        console.warn(`  Reconnect after resolving the issue: ${deps.cliName()} ${sandboxName} connect`);
      }
    }
    return actualPort;
  }

  function ensureAgentDashboardForward(
    sandboxName: string,
    agent: { forwardPort?: number | null },
  ): number {
    const agentDashboardPort = agent.forwardPort ?? CONTROL_UI_PORT;
    const agentDashboardUrl = `http://127.0.0.1:${agentDashboardPort}`;
    const actualAgentDashboardPort = ensureDashboardForward(sandboxName, agentDashboardUrl);
    process.env.CHAT_UI_URL = `http://127.0.0.1:${actualAgentDashboardPort}`;
    return actualAgentDashboardPort;
  }

  function fetchGatewayAuthTokenFromSandbox(sandboxName: string): string | null {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-token-"));
    try {
      const destDir = `${tmpDir}${path.sep}`;
      const result = deps.runOpenshell(
        ["sandbox", "download", sandboxName, "/sandbox/.openclaw/openclaw.json", destDir],
        { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
      );
      if (result.status !== 0) return null;
      const jsonPath = findOpenclawJsonPath(tmpDir);
      if (!jsonPath) return null;
      const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const token = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
      return typeof token === "string" && token.length > 0 ? token : null;
    } catch {
      return null;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  function printDashboard(
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer: string | null = null,
    agent: AgentDefinition | null = null,
  ): void {
    const nimStatus = deps.nimStatus ?? nim.nimStatus;
    const nimStatusByName = deps.nimStatusByName ?? nim.nimStatusByName;
    const shouldShowNimLine = deps.shouldShowNimLine ?? nim.shouldShowNimLine;
    const nimStat = nimContainer ? nimStatusByName(nimContainer) : nimStatus(sandboxName);
    const showNim = shouldShowNimLine(nimContainer, nimStat.running);
    const nimLabel = nimStat.running ? "running" : "not running";
    const providerLabel = deps.getProviderLabel(provider);
    const token = fetchGatewayAuthTokenFromSandbox(sandboxName);
    const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
    const chain = buildChain({
      chatUiUrl,
      isWsl: deps.isWsl(),
      wslHostAddress: getWslHostAddress(),
    });
    const dashboardBaseUrl = `${chain.accessUrl.replace(/\/$/, "")}/`;
    const dashboardUrl = dashboardUrlForDisplay(
      dashboardAccess.buildAuthenticatedDashboardUrl(dashboardBaseUrl, token),
      deps,
    );

    console.log("");
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  ${deps.agentProductName()} is ready`);
    console.log("");
    console.log(`  Sandbox:  ${sandboxName}`);
    console.log(`  Model:    ${model} (${providerLabel})`);
    if (showNim) {
      console.log(`  NIM:      ${nimLabel}`);
    }
    console.log("");
    if (agent) {
      console.log("  Access");
      console.log("");
      deps.printAgentDashboardUi(sandboxName, token, agent, {
        note: deps.note,
        buildControlUiUrls: (tokenValue: string | null, port: number) => {
          return buildControlUiUrls(tokenValue, port, chain.accessUrl);
        },
      });
      console.log("");
      console.log("  Terminal:");
      console.log(`    ${deps.cliName()} ${sandboxName} connect`);
    } else if (token) {
      console.log("  Start chatting");
      console.log("");
      console.log("    Browser:");
      console.log(`      ${dashboardUrl}`);
      console.log("");
      console.log("    Terminal:");
      console.log(`      ${deps.cliName()} ${sandboxName} connect`);
      console.log("      then run: openclaw tui");
      console.log("");
      console.log("  Authenticated dashboard URL, if needed:");
      console.log(`    ${deps.cliName()} ${sandboxName} dashboard-url --quiet`);
    } else {
      deps.note("  Could not read gateway token from the sandbox (download failed).");
      console.log("  Start chatting");
      console.log("");
      console.log("    Browser:");
      console.log(`      ${dashboardUrl}`);
      console.log("");
      console.log("    Terminal:");
      console.log(`      ${deps.cliName()} ${sandboxName} connect`);
      console.log("      then run: openclaw tui");
    }
    console.log("");
    console.log("  Manage later");
    console.log("");
    console.log(`    Status:      ${deps.cliName()} ${sandboxName} status`);
    console.log(`    Logs:        ${deps.cliName()} ${sandboxName} logs --follow`);
    console.log(
      `    Model:       ${deps.cliName()} inference set --model <model> --provider <provider> --sandbox ${sandboxName}`,
    );
    console.log(`    Policies:    ${deps.cliName()} ${sandboxName} policy-add`);
    console.log(`    Credentials: ${deps.cliName()} credentials reset <KEY> && ${deps.cliName()} onboard`);
    console.log(`  ${"─".repeat(50)}`);
    console.log("");
  }

  return {
    buildChain,
    buildControlUiUrls,
    buildOrphanedSandboxRollbackMessage,
    ensureDashboardForward,
    ensureAgentDashboardForward,
    fetchGatewayAuthTokenFromSandbox,
    getDashboardForwardPort,
    getDashboardForwardTarget,
    getWslHostAddress,
    printDashboard,
    stopAllDashboardForwards,
  };
}
