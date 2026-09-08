// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <name> dashboard-url` -- print the browser-facing dashboard URL.
 * OpenClaw sandboxes still receive an authenticated token fragment, while
 * session-auth agent dashboards can return the plain URL.
 */

import { DASHBOARD_PORT } from "./core/ports";
import { buildSshForwardHintLines } from "./onboard/ssh-forward-hint";
import type { SandboxEntry } from "./state/registry";

type DashboardAuth = "url_token" | "session" | "none";

export interface DashboardUrlCommandDeps {
  /** Pull gateway.auth.token from the sandbox config (host-side helper). */
  fetchToken: (sandboxName: string) => string | null;
  /** Read sandbox metadata such as agent name and recorded dashboard port. */
  getSandbox?: (sandboxName: string) => Pick<SandboxEntry, "agent" | "dashboardPort" | "dashboardBindAddress"> | null;
  /** Resolve the browser-facing dashboard base URL for this host, when known. */
  getAccessUrl?: (port: number) => string | null;
  /** Resolve a registered agent's dashboard auth contract. */
  getAgentDashboardAuth?: (agentName: string) => DashboardAuth | null;
  /** Resolve a registered agent's runtime kind and display name. */
  getAgentRuntimeInfo?: (
    agentName: string,
  ) => { kind: "terminal" | "gateway"; displayName: string } | null;
  /** Optional stdout sink -- defaults to console.log. */
  log?: (message: string) => void;
  /** Optional stderr sink -- defaults to console.error. */
  error?: (message: string) => void;
  /** Environment used to detect an SSH session for the port-forward hint. */
  env?: NodeJS.ProcessEnv;
}

export interface DashboardUrlCommandOptions {
  /** Print only the URL when set (`--quiet` / `-q`). */
  quiet?: boolean;
}

export class DashboardUrlCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n"));
    this.name = "DashboardUrlCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

const SECURITY_WARNING = "Treat this URL like a password -- do not log, share, or commit it.";

function dashboardUrlFail(lines: string | readonly string[], exitCode = 1): never {
  throw new DashboardUrlCommandError(lines, exitCode);
}

/**
 * The bind recorded when this sandbox's dashboard forward was started, or null
 * for rows written before it was recorded. `CHAT_UI_URL` decides the bind at
 * onboard time and is rarely set for later commands, so recomputing it here
 * reports loopback for a dashboard listening on every interface (#10861).
 */
function recordedBindAddress(
  sandbox: Pick<SandboxEntry, "dashboardBindAddress"> | null,
): string | null {
  return sandbox?.dashboardBindAddress || null;
}

function resolveDashboardPort(sandbox: Pick<SandboxEntry, "dashboardPort"> | null): number {
  const port = sandbox?.dashboardPort;
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : DASHBOARD_PORT;
}

export function buildDashboardUrl(
  token: string,
  port = DASHBOARD_PORT,
  baseUrl = `http://127.0.0.1:${port}/`,
): string {
  if (!token) {
    throw new Error("dashboard token is required");
  }
  const normalizedBaseUrl = baseUrl.trim().endsWith("/") ? baseUrl.trim() : `${baseUrl.trim()}/`;
  return `${normalizedBaseUrl}#token=${encodeURIComponent(token)}`;
}

function buildPlainDashboardUrl(
  port = DASHBOARD_PORT,
  baseUrl = `http://127.0.0.1:${port}/`,
): string {
  return baseUrl.trim().endsWith("/") ? baseUrl.trim() : `${baseUrl.trim()}/`;
}

function resolveAgentDashboardAuth(
  agentName: string | null,
  deps: Pick<DashboardUrlCommandDeps, "getAgentDashboardAuth">,
): DashboardAuth | null {
  if (!agentName || agentName === "openclaw") return "url_token";
  if (deps.getAgentDashboardAuth) {
    return deps.getAgentDashboardAuth(agentName);
  }
  try {
    const { loadAgent } = require("./agent/defs") as typeof import("./agent/defs");
    return loadAgent(agentName).dashboard.auth;
  } catch {
    return null;
  }
}

/**
 * Detect a terminal-runtime agent (e.g. LangChain Deep Agents Code), which has
 * no browser dashboard by design. Returns the display name when terminal so the
 * caller can explain the absence instead of failing as if the sandbox were down.
 */
function resolveTerminalRuntime(
  agentName: string | null,
  deps: Pick<DashboardUrlCommandDeps, "getAgentRuntimeInfo">,
): { displayName: string } | null {
  if (!agentName || agentName === "openclaw") return null;
  if (deps.getAgentRuntimeInfo) {
    const info = deps.getAgentRuntimeInfo(agentName);
    return info && info.kind === "terminal" ? { displayName: info.displayName } : null;
  }
  try {
    const defs = require("./agent/defs") as typeof import("./agent/defs");
    const def = defs.loadAgent(agentName);
    if (defs.getAgentRuntimeKind(def) === "terminal") {
      return { displayName: def.displayName ?? agentName };
    }
  } catch {
    // Unresolvable agent -> not a known terminal runtime; fall through.
  }
  return null;
}

export function runDashboardUrlCommand(
  sandboxName: string,
  options: DashboardUrlCommandOptions,
  deps: DashboardUrlCommandDeps,
): void {
  const log = deps.log ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));

  // The printed URL stays the browser-usable one: a wildcard bind is not a
  // browser destination. The recorded bind decides what follows it. A wide
  // bind is disclosed and needs no SSH forward; a loopback bind keeps the
  // forward hint; a row with no record falls back to the access URL alone.
  const printDashboardReach = (
    port: number,
    accessUrl: string | null,
    bindAddress: string | null,
  ): void => {
    if (bindAddress === "0.0.0.0") {
      log(
        `  Bound on all interfaces (0.0.0.0:${String(port)}): reachable from other hosts at this host's address.`,
      );
      return;
    }
    const hint = buildSshForwardHintLines({
      port,
      accessUrl: bindAddress ? `http://${bindAddress}:${String(port)}` : accessUrl,
      env: deps.env,
    });
    if (!hint) return;
    log("");
    for (const line of hint) log(line);
  };

  let sandbox: Pick<SandboxEntry, "agent" | "dashboardPort" | "dashboardBindAddress"> | null = null;
  if (deps.getSandbox) {
    try {
      sandbox = deps.getSandbox(sandboxName);
    } catch {
      sandbox = null;
    }
  }

  const agent = sandbox?.agent ?? null;

  // Terminal-runtime sandboxes (e.g. Deep Agents Code) have no dashboard by
  // design. Say so plainly instead of failing later with a token error that
  // wrongly implies the sandbox is down or misconfigured (#5727).
  const terminal = resolveTerminalRuntime(agent, deps);
  if (terminal) {
    dashboardUrlFail(
      `  Sandbox '${sandboxName}' uses a terminal runtime (${terminal.displayName}) and does not have a dashboard.`,
    );
  }

  const dashboardAuth = resolveAgentDashboardAuth(agent, deps);
  if (agent && agent !== "openclaw" && !dashboardAuth) {
    dashboardUrlFail(
      `  Could not resolve dashboard metadata for agent '${agent}' in sandbox '${sandboxName}'.`,
    );
  }
  if (dashboardAuth === "session" || dashboardAuth === "none") {
    const port = resolveDashboardPort(sandbox);
    const accessUrl = deps.getAccessUrl?.(port) ?? null;
    const url = buildPlainDashboardUrl(port, accessUrl ?? undefined);
    if (options.quiet) {
      log(url);
      return;
    }
    log("  Dashboard URL:");
    log(`  ${url}`);
    printDashboardReach(port, accessUrl, recordedBindAddress(sandbox));
    return;
  }

  let token: string | null;
  try {
    token = deps.fetchToken(sandboxName);
  } catch {
    token = null;
  }

  if (!token) {
    dashboardUrlFail([
      `  Could not retrieve the dashboard auth token for sandbox '${sandboxName}'.`,
      `  Make sure the sandbox is running: nemoclaw ${sandboxName} status`,
    ]);
  }

  const port = resolveDashboardPort(sandbox);
  const accessUrl = deps.getAccessUrl?.(port) ?? null;
  const url = buildDashboardUrl(token, port, accessUrl ?? undefined);
  if (options.quiet) {
    log(url);
    return;
  }

  log("  Dashboard URL:");
  log(`  ${url}`);
  printDashboardReach(port, accessUrl, recordedBindAddress(sandbox));
  error(SECURITY_WARNING);
}
