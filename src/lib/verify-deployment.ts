// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-deployment verification — confirms the full delivery chain is
 * operational before printing "YOUR AGENT IS LIVE". All deps injected
 * for testability.
 *
 * Probes:
 *   1. Gateway reachable (HTTP /health returns 200 or 401)
 *   2. Gateway version retrieval
 *   3. Dashboard port reachable from the host (port forward working)
 *   4. Inference route working (sandbox can reach inference.local)
 *   5. Messaging bridges healthy (if configured)
 *
 * Fixes #2342 — users no longer see "AGENT IS LIVE" followed by
 * "Health Offline" in the dashboard.
 */

import type { DashboardDeliveryChain } from "./dashboard-contract";

// ── Types ────────────────────────────────────────────────────────────

export type AccessMethod = "localhost" | "proxy" | "ssh-tunnel";

export interface DeploymentVerification {
  gatewayReachable: boolean;
  gatewayVersion: string | null;
  inferenceRouteWorking: boolean;
  dashboardReachable: boolean;
  messagingBridgesHealthy: boolean;
  accessMethod: AccessMethod;
}

export interface DeploymentDiagnostic {
  link: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint: string;
}

export interface VerifyDeploymentResult {
  healthy: boolean;
  verification: DeploymentVerification;
  diagnostics: DeploymentDiagnostic[];
}

export interface VerifyDeploymentDeps {
  /** Execute a command inside the sandbox via SSH. Returns null if sandbox unreachable. */
  executeSandboxCommand: (name: string, script: string) => { status: number; stdout: string; stderr: string } | null;

  /** Probe an HTTP endpoint on the host. Returns the HTTP status code or 0 on failure. */
  probeHostPort: (port: number, path: string) => number;

  /** List active port forwards. Returns raw output from `openshell forward list`. */
  captureForwardList: () => string | null;

  /** Get the list of configured messaging channels for a sandbox. */
  getMessagingChannels: (name: string) => string[];

  /** Check if a messaging bridge is polling (provider exists in gateway). */
  providerExistsInGateway: (providerName: string) => boolean;
}

// HTTP status codes that indicate the gateway process is alive.
// 401 = device auth is enabled but the gateway is running.
const GATEWAY_ALIVE_CODES = new Set([200, 401]);

// ── Core verification ────────────────────────────────────────────────

/**
 * Probe the gateway /health endpoint inside the sandbox.
 * Uses HTTP status code extraction (not curl -sf) so 401 counts as alive.
 */
function verifyGatewayInSandbox(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
): { reachable: boolean; httpCode: number; detail: string } {
  const script =
    `curl -so /dev/null -w '%{http_code}' --max-time 3 ` +
    `http://127.0.0.1:${chain.port}${chain.healthEndpoint} 2>/dev/null || echo 000`;
  const result = deps.executeSandboxCommand(sandboxName, script);
  if (!result) {
    return { reachable: false, httpCode: 0, detail: "sandbox unreachable (SSH failed)" };
  }
  const code = parseInt(result.stdout.trim(), 10) || 0;
  if (GATEWAY_ALIVE_CODES.has(code)) {
    return { reachable: true, httpCode: code, detail: `HTTP ${code}` };
  }
  return { reachable: false, httpCode: code, detail: `HTTP ${code} (gateway not responding)` };
}

/**
 * Retrieve the gateway version from inside the sandbox.
 */
function fetchGatewayVersion(
  sandboxName: string,
  deps: VerifyDeploymentDeps,
): string | null {
  const script = `openclaw --version 2>/dev/null | awk '{print $2}' || echo ''`;
  const result = deps.executeSandboxCommand(sandboxName, script);
  if (!result || !result.stdout.trim()) return null;
  const version = result.stdout.trim();
  return version && version !== "" ? version : null;
}

/**
 * Probe the inference route from inside the sandbox.
 * Sends a minimal request to inference.local to verify the proxy is working.
 */
function verifyInferenceRoute(
  sandboxName: string,
  deps: VerifyDeploymentDeps,
): { working: boolean; detail: string } {
  // Just check that inference.local resolves and the proxy responds.
  // We don't send a real completion request — just hit /v1/models to confirm routing.
  const script =
    `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time 5 ` +
    `https://inference.local/v1/models 2>/dev/null || echo 000); echo $HTTP_CODE`;
  const result = deps.executeSandboxCommand(sandboxName, script);
  if (!result) {
    return { working: false, detail: "sandbox unreachable" };
  }
  const code = parseInt(result.stdout.trim(), 10) || 0;
  // Any HTTP response (even 401/403) means the proxy is routing.
  // 000 means DNS failed or connection refused.
  if (code > 0) {
    return { working: true, detail: `inference.local responded HTTP ${code}` };
  }
  return { working: false, detail: "inference.local unreachable (DNS or proxy not running)" };
}

/**
 * Verify the dashboard port is reachable from the host (port forward working).
 */
function verifyDashboardFromHost(
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
): { reachable: boolean; detail: string } {
  const code = deps.probeHostPort(chain.port, chain.healthEndpoint);
  if (GATEWAY_ALIVE_CODES.has(code)) {
    return { reachable: true, detail: `host probe HTTP ${code}` };
  }
  if (code > 0) {
    return { reachable: false, detail: `host probe HTTP ${code} (unexpected)` };
  }
  return { reachable: false, detail: "port forward not working (connection refused)" };
}

/**
 * Detect the access method based on the chain configuration.
 */
function detectAccessMethod(chain: DashboardDeliveryChain): AccessMethod {
  if (chain.bindAddress === "0.0.0.0") return "proxy";
  if (chain.accessUrl.includes("127.0.0.1") || chain.accessUrl.includes("localhost")) return "localhost";
  return "ssh-tunnel";
}

/**
 * Verify messaging bridge health for all configured channels.
 */
function verifyMessagingBridges(
  sandboxName: string,
  deps: VerifyDeploymentDeps,
): { healthy: boolean; detail: string } {
  const channels = deps.getMessagingChannels(sandboxName);
  if (channels.length === 0) {
    return { healthy: true, detail: "no messaging channels configured" };
  }
  const missing: string[] = [];
  for (const channel of channels) {
    if (!deps.providerExistsInGateway(channel)) {
      missing.push(channel);
    }
  }
  if (missing.length > 0) {
    return { healthy: false, detail: `missing providers: ${missing.join(", ")}` };
  }
  return { healthy: true, detail: `${channels.length} channel(s) attached` };
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Run full post-deployment verification. Call this between
 * ensureDashboardForward() and printDashboard() in onboard.ts.
 *
 * Returns a structured result with pass/fail for each link and
 * actionable diagnostics on failure.
 */
export function verifyDeployment(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
): VerifyDeploymentResult {
  const diagnostics: DeploymentDiagnostic[] = [];

  // 1. Gateway reachable inside sandbox
  const gateway = verifyGatewayInSandbox(sandboxName, chain, deps);
  diagnostics.push({
    link: "gateway",
    status: gateway.reachable ? "ok" : "fail",
    detail: gateway.detail,
    hint: gateway.reachable
      ? ""
      : "The gateway process may have crashed during startup. Check /tmp/gateway.log inside the sandbox.",
  });

  // 2. Gateway version (cosmetic — not a health signal)
  const gatewayVersion = gateway.reachable ? fetchGatewayVersion(sandboxName, deps) : null;

  // 3. Dashboard reachable from host (port forward)
  const dashboard = verifyDashboardFromHost(chain, deps);
  diagnostics.push({
    link: "dashboard",
    status: dashboard.reachable ? "ok" : "fail",
    detail: dashboard.detail,
    hint: dashboard.reachable
      ? ""
      : `Port forward on ${chain.port} is not working. Run: openshell forward start ${chain.forwardTarget} ${sandboxName}`,
  });

  // 4. Inference route
  const inference = verifyInferenceRoute(sandboxName, deps);
  diagnostics.push({
    link: "inference",
    status: inference.working ? "ok" : "warn",
    detail: inference.detail,
    hint: inference.working
      ? ""
      : "The inference proxy may not be ready yet. Try: nemoclaw <sandbox> status (it may take a few seconds after creation).",
  });

  // 5. Messaging bridges
  const messaging = verifyMessagingBridges(sandboxName, deps);
  if (!messaging.healthy) {
    diagnostics.push({
      link: "messaging",
      status: "warn",
      detail: messaging.detail,
      hint: "Some messaging providers are not attached to the gateway. Re-run onboard with the relevant channels enabled.",
    });
  }

  const accessMethod = detectAccessMethod(chain);

  const verification: DeploymentVerification = {
    gatewayReachable: gateway.reachable,
    gatewayVersion,
    inferenceRouteWorking: inference.working,
    dashboardReachable: dashboard.reachable,
    messagingBridgesHealthy: messaging.healthy,
    accessMethod,
  };

  // Healthy = gateway reachable AND dashboard reachable from host.
  // Inference and messaging are warn-level (non-blocking).
  const healthy = gateway.reachable && dashboard.reachable;

  return { healthy, verification, diagnostics };
}

// ── Formatting helpers ───────────────────────────────────────────────

/**
 * Format deployment verification diagnostics for terminal output.
 * Used by onboard.ts to print actionable messages on verification failure.
 */
export function formatVerificationDiagnostics(result: VerifyDeploymentResult): string[] {
  const lines: string[] = [];
  const G = "\x1b[32m";
  const Y = "\x1b[33m";
  const R = "\x1b[31m";
  const D = "\x1b[2m";
  const RESET = "\x1b[0m";

  if (result.healthy) {
    lines.push(`  ${G}✓${RESET} Deployment verified — gateway and dashboard are healthy.`);
    if (result.verification.gatewayVersion) {
      lines.push(`    OpenClaw version: ${result.verification.gatewayVersion}`);
    }
    return lines;
  }

  lines.push(`  ${Y}⚠${RESET} Deployment verification found issues:`);
  lines.push("");
  for (const d of result.diagnostics) {
    if (d.status === "ok") continue;
    const icon = d.status === "fail" ? `${R}✗${RESET}` : `${Y}!${RESET}`;
    lines.push(`  ${icon} ${d.link}: ${d.detail}`);
    if (d.hint) {
      lines.push(`    ${D}${d.hint}${RESET}`);
    }
  }
  lines.push("");
  lines.push(`  ${D}The sandbox was created successfully but may not be fully functional.${RESET}`);
  lines.push(`  ${D}Run: nemoclaw <sandbox> status  — to re-check after a few seconds.${RESET}`);
  return lines;
}
