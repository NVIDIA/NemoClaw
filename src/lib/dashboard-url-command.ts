// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <name> dashboard-url` -- print the browser-facing dashboard URL.
 * OpenClaw sandboxes still receive an authenticated token fragment, while
 * session-auth agent dashboards can return the plain URL.
 */

import { DASHBOARD_PORT } from "./core/ports";
import type { SandboxEntry } from "./state/registry";

type DashboardAuth = "url_token" | "session" | "none";

export interface DashboardUrlCommandDeps {
  /** Pull gateway.auth.token from the sandbox config (host-side helper). */
  fetchToken: (sandboxName: string) => string | null;
  /** Read sandbox metadata such as agent name and recorded dashboard port. */
  getSandbox?: (sandboxName: string) => Pick<SandboxEntry, "agent" | "dashboardPort"> | null;
  /** Resolve the browser-facing dashboard base URL for this host, when known. */
  getAccessUrl?: (port: number) => string | null;
  /** Resolve a registered agent's dashboard auth contract. */
  getAgentDashboardAuth?: (agentName: string) => DashboardAuth | null;
  /** Optional stdout sink -- defaults to console.log. */
  log?: (message: string) => void;
  /** Optional stderr sink -- defaults to console.error. */
  error?: (message: string) => void;
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

const SECURITY_WARNING =
  "Treat this URL like a password -- do not log, share, or commit it.";

function dashboardUrlFail(lines: string | readonly string[], exitCode = 1): never {
  throw new DashboardUrlCommandError(lines, exitCode);
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

export function runDashboardUrlCommand(
  sandboxName: string,
  options: DashboardUrlCommandOptions,
  deps: DashboardUrlCommandDeps,
): void {
  const log = deps.log ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));

  let sandbox: Pick<SandboxEntry, "agent" | "dashboardPort"> | null = null;
  if (deps.getSandbox) {
    try {
      sandbox = deps.getSandbox(sandboxName);
    } catch {
      sandbox = null;
    }
  }

  const agent = sandbox?.agent ?? null;
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
  error(SECURITY_WARNING);
}
