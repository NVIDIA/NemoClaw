// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { isPolicyAuthorityRefusalError } from "../adapters/openshell/policy-authority";
import type { AgentDefinition } from "../agent/defs";
import { getInteractiveAgentCommand } from "../agent/gateway-restart-scripts";
import { DASHBOARD_PORT } from "../core/ports";
import { buildChain, buildControlUiUrls, buildFallbackControlUiUrls } from "../dashboard/contract";
import * as nim from "../inference/nim";
import { runCapture as defaultRunCapture } from "../runner";
import {
  ensureAgentDashboardForward as ensureAgentDashboardForwardForAgent,
  replaceUrlPort,
  resolveVerifyAgentApiPort,
} from "./agent-dashboard-forward";
import { ensureAgentFixedForward as ensureFixedAgentForward } from "./agent-fixed-forward";
import { fetchAgentWebAuthTokenFromSandbox as fetchAgentWebAuthToken } from "./agent-web-auth-token";
import * as dashboardAccess from "./dashboard-access";
import {
  createSandboxForwardStopper,
  type DashboardForwardOptions,
  normalizeDashboardForwardOptions,
} from "./dashboard-forward-control";
import {
  findAvailableDashboardPort,
  getOccupiedPorts,
  getPersistedDashboardPort,
  getRegistryOccupiedDashboardPorts,
  isPortBoundOnHost,
  isLiveForwardStatus,
  type ListSandboxesFn,
} from "./dashboard-port";
import {
  bestEffortForwardStop,
  bestEffortForwardStopForSandbox,
  waitForStoppedForwardPortRelease,
} from "./forward-cleanup";
import {
  buildDetachedForwardStartSpawn,
  buildForwardStartProgressLogger,
  looksLikeForwardPortConflict,
  runDetachedForwardStartWithRetries,
} from "./forward-start";
import {
  ensureMessagingHostForwardForSandbox,
  resolveMessagingHostForwardForSandbox,
} from "./messaging-host-forward";
import { buildSshForwardHintLines } from "./ssh-forward-hint";

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
  /** Environment used to detect an SSH session for the port-forward hint. */
  env?: NodeJS.ProcessEnv;
  // Sandbox-registry lookup used by `ensureDashboardForward` for the
  // cross-gateway dashboard port view. Tests inject a stub so the allocator
  // never reads the runner's real `~/.nemoclaw/sandboxes.json`; production
  // callers leave it unset and the helper falls back to the live registry.
  listSandboxes?: ListSandboxesFn;
  /** Host-listener probe injected by forward release race tests. */
  isPortBoundOnHost?: typeof isPortBoundOnHost;
  /** Sandbox lookup used to resolve the per-sandbox Hermes API port. */
  getSandbox?(name: string): { hermesApiPort?: number | null } | null | undefined;
  printAgentDashboardUi(
    sandboxName: string,
    token: string | null,
    agent: AgentDefinition,
    deps: {
      note: (msg: string) => void;
      buildControlUiUrls: (token: string | null, port: number) => string[];
      effectiveDashboardPort?: number;
    },
  ): void;
}

/** Agent fields the deployment-verification chain reads. */
export type VerifyChainAgent = {
  name?: string;
  dashboard?: { healthPath?: string } | null;
  healthProbe?: { url?: string; port?: number } | null;
};

export interface OnboardDashboardHelpers {
  buildChain: typeof buildChain;
  buildAgentVerifyChain(
    chatUiUrl: string,
    sandboxName: string,
    agent: VerifyChainAgent | null | undefined,
  ): ReturnType<typeof buildChain>;
  buildControlUiUrls: typeof buildControlUiUrls;
  buildOrphanedSandboxRollbackMessage(
    sandboxName: string,
    err: unknown,
    gatewayName?: string,
  ): string[];
  ensureDashboardForward(
    sandboxName: string,
    chatUiUrl?: string,
    options?: DashboardForwardOptions,
  ): number;
  ensureAgentDashboardForward(
    sandboxName: string,
    agent: { forwardPort?: number | null; forward_ports?: number[] | null },
    options?: {
      beforeForwardPort?: (port: number) => Promise<void> | void;
      revalidatePolicyAuthority?: (operation: string) => void;
    },
  ): Promise<number>;
  ensureFinalizationDashboardForward(
    sandboxName: string,
    revalidatePolicyAuthority?: (operation: string) => void,
  ): number;
  ensureFinalizationAgentDashboardForward(
    sandboxName: string,
    agent: { name: string; forwardPort?: number | null; forward_ports?: number[] | null } | null,
    revalidatePolicyAuthority?: (operation: string) => void,
    portReservation?: {
      releaseBeforeForward(agentName: string, port: number): Promise<void> | void;
    },
  ): Promise<number> | number;
  ensureAgentFixedForward(
    sandboxName: string,
    port: number,
    label: string,
    revalidatePolicyAuthority?: (operation: string) => void,
  ): boolean;
  fetchGatewayAuthTokenFromSandbox(sandboxName: string): string | null;
  fetchAgentWebAuthTokenFromSandbox(sandboxName: string, agent: AgentDefinition): string | null;
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
    ready?: boolean,
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

function printWslFallback(fallbackDashboardUrls: string[], indent: string): void {
  if (fallbackDashboardUrls.length === 0) return;
  console.log("");
  console.log(`${indent}Browser (WSL fallback, if 127.0.0.1 is unreachable from Windows):`);
  for (const fallbackUrl of fallbackDashboardUrls) {
    console.log(`${indent}  ${fallbackUrl}`);
  }
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
    return dashboardAccess.getWslHostAddress({
      ...options,
      runCapture: options.runCapture || runCapture,
    });
  }

  /**
   * Build the delivery chain deployment verification probes for `sandboxName`.
   *
   * Resolves the agent's OpenAI-compatible API port for this sandbox rather
   * than the agent manifest default, so verification probes the port this
   * sandbox actually publishes on the host (#9290).
   */
  function buildAgentVerifyChain(
    chatUiUrl: string,
    sandboxName: string,
    agent: VerifyChainAgent | null | undefined,
  ): ReturnType<typeof buildChain> {
    // Resolve WSL once: `buildChain` and the host-address lookup must agree, or
    // the chain can claim WSL while dropping the fallback URL that pairs with it.
    const isWsl = deps.isWsl();
    return buildChain({
      chatUiUrl,
      isWsl,
      wslHostAddress: getWslHostAddress({ isWsl }),
      dashboardHealthEndpoint: agent?.dashboard?.healthPath,
      gatewayPort: resolveVerifyAgentApiPort(sandboxName, agent, {
        getSandbox: deps.getSandbox,
      }),
      gatewayHealthEndpoint: agent?.healthProbe?.url,
    });
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
    gatewayName?: string,
  ): string[] {
    const owningGateway = gatewayName?.trim();
    const lines = [
      "",
      `  Could not allocate a dashboard port for '${sandboxName}'.`,
      `  ${err instanceof Error ? err.message : String(err)}`,
      "  NemoClaw left the sandbox running because OpenShell deletion targets a mutable name.",
    ];
    if (owningGateway) {
      lines.push(
        "  Verify the sandbox identity, then clean up manually:",
        `    openshell sandbox delete -g ${JSON.stringify(owningGateway)} ${JSON.stringify(sandboxName)}`,
      );
    } else {
      lines.push("  The owning OpenShell gateway is unknown. Do not delete a same-name sandbox.");
    }
    return lines;
  }

  function rollbackSandboxAndExit(sandboxName: string, err: unknown, gatewayName?: string): never {
    for (const line of buildOrphanedSandboxRollbackMessage(sandboxName, err, gatewayName)) {
      console.error(line);
    }
    process.exit(1);
  }

  function ensureDashboardForward(
    sandboxName: string,
    chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`,
    options: DashboardForwardOptions = {},
  ): number {
    chatUiUrl ||= `http://127.0.0.1:${CONTROL_UI_PORT}`;
    const { rollbackSandboxOnFailure, preservedPorts, allowPortReallocation } =
      normalizeDashboardForwardOptions(options);
    const { revalidatePolicyAuthority } = options;
    const messagingForward = resolveMessagingHostForwardForSandbox(sandboxName);
    if (messagingForward) preservedPorts.add(String(messagingForward.port));
    const preferredPort = Number(getDashboardForwardPort(chatUiUrl));
    const makeStopForwardForSandbox = () =>
      createSandboxForwardStopper({
        runOpenshell: deps.runOpenshell,
        runCaptureOpenshell: deps.runCaptureOpenshell,
        sandboxName,
        revalidatePolicyAuthority,
      });
    const stopForwardForSandbox = makeStopForwardForSandbox();
    let existingForwards = deps.runCaptureOpenshell(["forward", "list"], { ignoreError: true });
    const preferredEntry = findForwardEntry(existingForwards, String(preferredPort));
    if (
      preferredEntry &&
      (preferredEntry.sandboxName === sandboxName || !isLiveForwardStatus(preferredEntry.status))
    ) {
      const stopResult = stopForwardForSandbox(preferredPort);
      if (
        preferredEntry.sandboxName === sandboxName &&
        (stopResult === "stopped" || stopResult === "no-entry")
      ) {
        // OpenShell can remove forward metadata before the SSH listener exits.
        // Do not classify that retiring listener as a foreign fixed-port
        // conflict; use the same bounded five-second release window as runtime
        // forward recovery.
        waitForStoppedForwardPortRelease(
          preferredPort,
          deps.isPortBoundOnHost ?? isPortBoundOnHost,
          { sleep: (milliseconds) => deps.sleep(milliseconds / 1_000) },
        );
      }
      existingForwards = deps.runCaptureOpenshell(["forward", "list"], { ignoreError: true });
    }
    let actualPort: number;
    try {
      actualPort = findAvailableDashboardPort(
        sandboxName,
        preferredPort,
        existingForwards,
        deps.isPortBoundOnHost ?? isPortBoundOnHost,
        getRegistryOccupiedDashboardPorts(sandboxName, deps.listSandboxes),
      );
    } catch (err) {
      if (!rollbackSandboxOnFailure) throw err;
      rollbackSandboxAndExit(sandboxName, err, options.gatewayName);
    }

    if (actualPort !== preferredPort) {
      if (!allowPortReallocation) {
        throw new Error(
          `Port ${preferredPort} is not available for '${sandboxName}' and cannot be reallocated.`,
        );
      }
      if (rollbackSandboxOnFailure) {
        const err = new Error(
          `Dashboard port ${preferredPort} became host-bound during sandbox build; ` +
            `cannot reallocate to ${actualPort} after the sandbox has been created with ` +
            `CHAT_UI_URL=${preferredPort}. Free the port and re-run \`${deps.cliName()} onboard\`, ` +
            `or pass \`--control-ui-port <N>\` to pick a different dashboard port.`,
        );
        rollbackSandboxAndExit(sandboxName, err, options.gatewayName);
      }
      console.warn(`  ! Port ${preferredPort} is taken. Using port ${actualPort} instead.`);
    }

    const occupied = getOccupiedPorts(existingForwards);
    for (const [port, owner] of occupied.entries()) {
      if (owner === sandboxName && Number(port) !== actualPort && !preservedPorts.has(port)) {
        stopForwardForSandbox(port);
      }
    }

    const parsedUrl = new URL(chatUiUrl.includes("://") ? chatUiUrl : `http://${chatUiUrl}`);
    parsedUrl.port = String(actualPort);
    const actualTarget = getDashboardForwardTarget(parsedUrl.toString());
    stopForwardForSandbox(actualPort);
    const startDashboardForward = buildDetachedForwardStartSpawn(
      deps.openshellArgv(["forward", "start", "--background", actualTarget, sandboxName]),
    );
    const { ok: fwdOk, diagnostic: fwdDiagnostic } = runDetachedForwardStartWithRetries(
      (stdio) => {
        revalidatePolicyAuthority?.(
          `start dashboard forward ${String(actualPort)} for sandbox '${sandboxName}'`,
        );
        return startDashboardForward(stdio);
      },
      () => deps.runCaptureOpenshell(["forward", "list"], { timeout: OPENSHELL_PROBE_TIMEOUT_MS }),
      { port: actualPort, sandboxName },
      () => {
        deps.sleep(1);
        // The setup stopper intentionally de-duplicates ports. A port-conflict
        // retry needs a fresh sandbox-scoped stopper so it can preserve the
        // established conflict-recovery behavior despite that one-shot guard.
        makeStopForwardForSandbox()(actualPort);
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
        rollbackSandboxAndExit(sandboxName, err, options.gatewayName);
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
        console.warn(
          `  Reconnect after resolving the issue: ${deps.cliName()} ${sandboxName} connect`,
        );
      }
    }
    if (fwdOk) options.onForwardStarted?.(actualPort);
    if (fwdOk && rollbackSandboxOnFailure) {
      ensureMessagingHostForwardForSandbox({
        sandboxName,
        ensureForward: (name, port, label) =>
          ensureFixedAgentForward(deps, name, port, label, revalidatePolicyAuthority),
        note: deps.note,
        rollbackOnFailure: {
          runOpenshell: deps.runOpenshell,
          buildRollbackMessage: (name, error) =>
            buildOrphanedSandboxRollbackMessage(name, error, options.gatewayName),
          cliName: deps.cliName,
          forwardPortsToStop: [actualPort],
          beforeMutation: revalidatePolicyAuthority,
        },
      });
    }
    return actualPort;
  }

  /**
   * Reconcile the dashboard forward for the agent-less OpenClaw finalization
   * branch. The resume path skips sandbox creation, so `CHAT_UI_URL` does not
   * carry the port the in-sandbox gateway listens on; the registry entry
   * persisted by onboarding is the only record of that port. The forward and
   * the in-sandbox gateway must share one port number (`openshell forward`
   * binds the same port on both sides), so when the persisted port cannot be
   * forwarded this throws instead of reallocating: the resumed gateway only
   * listens on the persisted port, and a forward on any other port serves
   * nothing. Post-verify builds its probe chain and Browser URL from
   * `CHAT_UI_URL`, so after the forward starts this writes the bound port to
   * `CHAT_UI_URL`. (#8970)
   */
  function ensureFinalizationDashboardForward(
    sandboxName: string,
    revalidatePolicyAuthority?: (operation: string) => void,
  ): number {
    const envUrl = process.env.CHAT_UI_URL;
    const persistedPort = envUrl
      ? null
      : getPersistedDashboardPort(sandboxName, deps.listSandboxes);
    const requestedUrl =
      envUrl || (persistedPort === null ? undefined : `http://127.0.0.1:${String(persistedPort)}`);
    let startedPort: number | null = null;
    try {
      const actualPort = ensureDashboardForward(sandboxName, requestedUrl, {
        ...(persistedPort === null ? {} : { allowPortReallocation: false }),
        ...(revalidatePolicyAuthority ? { revalidatePolicyAuthority } : {}),
        onForwardStarted: (port) => {
          startedPort = port;
        },
      });
      revalidatePolicyAuthority?.(`publish the dashboard URL for sandbox '${sandboxName}'`);
      process.env.CHAT_UI_URL = replaceUrlPort(
        requestedUrl || `http://127.0.0.1:${String(actualPort)}`,
        actualPort,
      );
      return actualPort;
    } catch (error) {
      if (isPolicyAuthorityRefusalError(error) && startedPort !== null) {
        try {
          bestEffortForwardStopForSandbox(
            deps.runOpenshell,
            (args, options) => deps.runCaptureOpenshell(args, options),
            startedPort,
            sandboxName,
          );
        } catch {
          // Compensation is best effort and must not replace the typed refusal.
        }
      }
      throw error;
    }
  }

  function ensureAgentDashboardForward(
    sandboxName: string,
    agent: { forwardPort?: number | null; forward_ports?: number[] | null },
    options: {
      beforeForwardPort?: (port: number) => Promise<void> | void;
      revalidatePolicyAuthority?: (operation: string) => void;
    } = {},
  ): Promise<number> {
    const chatUiUrl = process.env.CHAT_UI_URL;
    return ensureAgentDashboardForwardForAgent({
      sandboxName,
      agent,
      ensureDashboardForward,
      chatUiUrl,
      controlUiPort: chatUiUrl ? Number(getDashboardForwardPort(chatUiUrl)) : undefined,
      beforeForwardPort: options.beforeForwardPort,
      revalidatePolicyAuthority: options.revalidatePolicyAuthority,
      compensateDashboardForward: (port) => {
        bestEffortForwardStopForSandbox(
          deps.runOpenshell,
          (args, captureOptions) => deps.runCaptureOpenshell(args, captureOptions),
          port,
          sandboxName,
        );
      },
    });
  }

  function ensureFinalizationAgentDashboardForward(
    sandboxName: string,
    agent: { name: string; forwardPort?: number | null; forward_ports?: number[] | null } | null,
    revalidatePolicyAuthority?: (operation: string) => void,
    portReservation?: {
      releaseBeforeForward(agentName: string, port: number): Promise<void> | void;
    },
  ): Promise<number> | number {
    return agent
      ? ensureAgentDashboardForward(sandboxName, agent, {
          revalidatePolicyAuthority,
          beforeForwardPort: portReservation
            ? (port) => portReservation.releaseBeforeForward(agent.name, port)
            : undefined,
        })
      : ensureFinalizationDashboardForward(sandboxName, revalidatePolicyAuthority);
  }

  function ensureAgentFixedForward(
    sandboxName: string,
    port: number,
    label: string,
    revalidatePolicyAuthority?: (operation: string) => void,
  ): boolean {
    return ensureFixedAgentForward(deps, sandboxName, port, label, revalidatePolicyAuthority);
  }

  /**
   * Read a bearer_token agent's web-auth token (e.g. Hermes' API_SERVER_KEY)
   * from its in-sandbox .env. The .env is 0640 root:sandbox and the gateway
   * group can read it, so we grep it via `sandbox exec` as the sandbox user
   * rather than `sandbox download` (which may not have read access). Prints
   * only the value, never the key name, and returns null when the agent has
   * no bearer token or the value is absent.
   */
  function fetchAgentWebAuthTokenFromSandbox(
    sandboxName: string,
    agent: AgentDefinition,
  ): string | null {
    return fetchAgentWebAuthToken(deps.runCaptureOpenshell, sandboxName, agent);
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

  /**
   * Print the terminal handoff for a ready sandbox. `launch` runs the same
   * preflight as `connect` and then starts the agent (#6006), so it leads. The
   * `connect` path stays documented for anyone who wants a sandbox shell, and
   * the command it tells the user to run comes from the agent manifest rather
   * than a hardcoded `openclaw tui`.
   */
  function printTerminalHandoff(
    indent: string,
    sandboxName: string,
    agent: AgentDefinition | null,
  ): void {
    console.log(`${indent}Terminal:`);
    console.log(`${indent}  ${deps.cliName()} launch ${sandboxName}`);
    console.log("");
    console.log(`${indent}  Or open a sandbox shell first:`);
    console.log(`${indent}    ${deps.cliName()} ${sandboxName} connect`);
    console.log(`${indent}    then run: ${getInteractiveAgentCommand(agent, agent?.name)}`);
  }

  function printDashboard(
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer: string | null = null,
    agent: AgentDefinition | null = null,
    ready = true,
  ): void {
    const nimStatus = deps.nimStatus ?? nim.nimStatus;
    const nimStatusByName = deps.nimStatusByName ?? nim.nimStatusByName;
    const shouldShowNimLine = deps.shouldShowNimLine ?? nim.shouldShowNimLine;
    const nimStat = nimContainer ? nimStatusByName(nimContainer) : nimStatus(sandboxName);
    const showNim = shouldShowNimLine(nimContainer, nimStat.running);
    const nimLabel = nimStat.running ? "running" : "not running";
    const providerLabel = deps.getProviderLabel(provider);
    const token =
      !agent || agent.dashboard.auth === "url_token"
        ? fetchGatewayAuthTokenFromSandbox(sandboxName)
        : null;
    const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
    const chain = buildChain({
      chatUiUrl,
      isWsl: deps.isWsl(),
      wslHostAddress: getWslHostAddress({ isWsl: deps.isWsl(), runCapture: deps.runCapture }),
    });
    const dashboardBaseUrl = `${chain.accessUrl.replace(/\/$/, "")}/`;
    const dashboardUrl = dashboardUrlForDisplay(
      dashboardAccess.buildAuthenticatedDashboardUrl(dashboardBaseUrl, token),
      deps,
    );
    const fallbackDashboardUrls = chain.fallbackUrls.map((fallback) =>
      dashboardUrlForDisplay(
        dashboardAccess.buildAuthenticatedDashboardUrl(`${fallback.replace(/\/$/, "")}/`, token),
        deps,
      ),
    );

    console.log("");
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  ${deps.agentProductName()} is ${ready ? "ready" : "not ready"}`);
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
        effectiveDashboardPort: chain.port,
        buildControlUiUrls: (tokenValue: string | null, port: number) => {
          const primary = buildControlUiUrls(tokenValue, port);
          const alternates = buildFallbackControlUiUrls(tokenValue, port, [
            chain.accessUrl,
            ...chain.fallbackUrls,
          ]);
          return [...new Set([...primary, ...alternates])];
        },
      });
      console.log("");
      printTerminalHandoff("  ", sandboxName, agent);
    } else if (token) {
      console.log("  Start chatting");
      console.log("");
      console.log("    Browser:");
      console.log(`      ${dashboardUrl}`);
      printWslFallback(fallbackDashboardUrls, "    ");
      console.log("");
      printTerminalHandoff("    ", sandboxName, agent);
      console.log("");
      console.log("  Authenticated dashboard URL, if needed:");
      console.log(`    ${deps.cliName()} ${sandboxName} dashboard-url --quiet`);
    } else {
      deps.note("  Could not read gateway token from the sandbox (download failed).");
      console.log("  Start chatting");
      console.log("");
      console.log("    Browser:");
      console.log(`      ${dashboardUrl}`);
      printWslFallback(fallbackDashboardUrls, "    ");
      console.log("");
      printTerminalHandoff("    ", sandboxName, agent);
    }
    const sshForwardHint = buildSshForwardHintLines({
      port: chain.port,
      accessUrl: chain.accessUrl,
      env: deps.env,
    });
    if (sshForwardHint) {
      console.log("");
      for (const line of sshForwardHint) {
        console.log(line);
      }
    }
    console.log("");
    console.log("  Manage later");
    console.log("");
    console.log(`    Status:      ${deps.cliName()} ${sandboxName} status`);
    console.log(`    Logs:        ${deps.cliName()} ${sandboxName} logs --follow`);
    console.log(
      `    Model:       ${deps.cliName()} inference set --model <model> --provider <provider> --sandbox ${sandboxName}`,
    );
    console.log(`    Policies:    ${deps.cliName()} ${sandboxName} policy add`);
    console.log(
      `    Credentials: ${deps.cliName()} credentials reset <KEY> && ${deps.cliName()} onboard`,
    );
    console.log(`  ${"─".repeat(50)}`);
    console.log("");
  }

  return {
    buildChain,
    buildAgentVerifyChain,
    buildControlUiUrls,
    buildOrphanedSandboxRollbackMessage,
    ensureDashboardForward,
    ensureAgentDashboardForward,
    ensureFinalizationAgentDashboardForward,
    ensureFinalizationDashboardForward,
    ensureAgentFixedForward,
    fetchGatewayAuthTokenFromSandbox,
    fetchAgentWebAuthTokenFromSandbox,
    getDashboardForwardPort,
    getDashboardForwardTarget,
    getWslHostAddress,
    printDashboard,
    stopAllDashboardForwards,
  };
}
