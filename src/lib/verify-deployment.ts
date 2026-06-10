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

import type { DashboardDeliveryChain } from "./dashboard/contract";
import { compareChannelSets, type RuntimeChannelStatus } from "./channel-runtime-status";
import { getMessagingProviderNamesForChannel } from "./onboard/messaging-reuse";

// ── Types ────────────────────────────────────────────────────────────

export type AccessMethod = "localhost" | "proxy" | "ssh-tunnel";

export interface DeploymentVerification {
  gatewayReachable: boolean;
  gatewayVersion: string | null;
  inferenceRouteWorking: boolean;
  dashboardReachable: boolean;
  messagingBridgesHealthy: boolean;
  /**
   * Channels recorded in the registry that the in-sandbox agent config
   * does not expose. Set to null when the runtime probe is disabled
   * (no agent config to read, e.g. Hermes), when the gateway log layer
   * was unavailable so the runtime view could not be corroborated, or
   * when no channels are configured. See [[channel-runtime-status]] for
   * the probe internals. Why: fixes #4156 — empty/null lets onboarding
   * finish quietly; a non-empty array surfaces "configured but invisible
   * at runtime" so the dashboard's "No channels found" panel does not
   * catch the user by surprise.
   */
  messagingRuntimeChannelsMissing: string[] | null;
  /**
   * Channels expected by the registry that are missing from the
   * in-sandbox agent config file (`openclaw.json`). Distinct from
   * `messagingRuntimeChannelsMissing`: this surfaces stale-rebuild
   * mismatches even when the gateway log isn't readable, while the
   * runtime field requires log corroboration. Null when no channels
   * are configured or the probe is disabled; empty array when the
   * config has every expected channel.
   */
  messagingConfigChannelsMissing: string[] | null;
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
  executeSandboxCommand: (
    name: string,
    script: string,
  ) => { status: number; stdout: string; stderr: string } | null;

  /** Probe an HTTP endpoint on the host. Returns the HTTP status code or 0 on failure. */
  probeHostPort: (port: number, path: string) => number;

  /** List active port forwards. Returns raw output from `openshell forward list`. */
  captureForwardList: () => string | null;

  /** Get the list of configured messaging channels for a sandbox. */
  getMessagingChannels: (name: string) => string[];

  /** Check if a messaging bridge is polling (provider exists in gateway). */
  providerExistsInGateway: (providerName: string) => boolean;

  /**
   * Probe the in-sandbox agent config to learn which channels the runtime
   * would actually expose to the dashboard "Channels" snapshot. Optional:
   * onboarding only wires it when the agent has a JSON config the runtime
   * parses (today: OpenClaw). Returning `null` means "skip the comparison";
   * a result object with `ok: false` means "tried to probe and failed",
   * which downgrades the diagnostic to a warning rather than a fail.
   *
   * Fixes #4156: configured/registered channels were never compared with
   * the runtime view, so a user could land on the dashboard and see
   * "No channels found" without any NemoClaw warning.
   */
  probeChannelRuntimeStatus?: () => RuntimeChannelStatus | null;
}

export interface VerifyDeploymentOptions {
  /**
   * Delays in ms between blocking-probe retries. Gateway and dashboard probes
   * can race the post-onboard startup on slower hosts (#3563) — the wizard
   * returns from createSandbox before the gateway process or the host port
   * forward have finished coming up. Each entry below adds one extra attempt
   * after the initial try, scheduled at the given delay from the previous
   * attempt. The defaults give roughly a 25 s budget per probe before the
   * wizard surfaces a ✗ marker.
   * Tests pass `[]` to disable retry.
   */
  retryDelaysMs?: number[];
  /** Sleep helper, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 5000, 7000, 10000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// HTTP status codes that indicate the gateway process is alive.
// 401 = device auth is enabled but the gateway is running.
const GATEWAY_ALIVE_CODES = new Set([200, 401]);
const TOKENLESS_MESSAGING_CHANNELS = new Set(["whatsapp"]);

// Gateway-failure hint: cover both layers the probe could be failing at.
// The probe runs curl inside the sandbox against the in-sandbox OpenClaw
// gateway (initialised at /tmp/gateway.log by agent/runtime.ts), so the
// sandbox log is the first thing to check. If the sandbox itself never
// came up, the host-side OpenShell gateway log is the right place to
// look — see gatewayLogCandidates() in onboard/sandbox-create-failure.ts.
function buildGatewayLogHint(sandboxName: string): string {
  return (
    `The gateway probe failed after retrying. Inspect the in-sandbox gateway log with ` +
    `\`nemoclaw ${sandboxName} logs\` (the gateway writes to /tmp/gateway.log inside the sandbox when it starts). ` +
    `If the sandbox itself never came up, also check the host-side OpenShell gateway log at ` +
    `~/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.log ` +
    `(or ~/.local/state/openshell/openshell-gateway.log on older installs).`
  );
}

// ── Core verification ────────────────────────────────────────────────

/**
 * Probe the gateway /health endpoint inside the sandbox.
 * Uses HTTP status code extraction (not curl -sf) so 401 counts as alive.
 */
function probeGatewayInSandboxOnce(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
): { reachable: boolean; httpCode: number; detail: string } {
  const port = chain.gatewayPort ?? chain.port;
  const endpoint = chain.gatewayHealthEndpoint ?? chain.healthEndpoint;
  const script =
    `curl -so /dev/null -w '%{http_code}' --max-time 3 ` +
    `http://127.0.0.1:${port}${endpoint} 2>/dev/null || echo 000`;
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

async function verifyGatewayInSandbox(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
  retryDelaysMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<{ reachable: boolean; httpCode: number; detail: string }> {
  let last = probeGatewayInSandboxOnce(sandboxName, chain, deps);
  if (last.reachable) return last;
  for (const delayMs of retryDelaysMs) {
    await sleep(delayMs);
    last = probeGatewayInSandboxOnce(sandboxName, chain, deps);
    if (last.reachable) return last;
  }
  return last;
}

/**
 * Retrieve the gateway version from inside the sandbox.
 */
function fetchGatewayVersion(sandboxName: string, deps: VerifyDeploymentDeps): string | null {
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
function probeDashboardFromHostOnce(
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
): { reachable: boolean; detail: string } {
  const code = deps.probeHostPort(
    chain.port,
    chain.dashboardHealthEndpoint ?? chain.healthEndpoint,
  );
  if (GATEWAY_ALIVE_CODES.has(code)) {
    return { reachable: true, detail: `host probe HTTP ${code}` };
  }
  if (code > 0) {
    return { reachable: false, detail: `host probe HTTP ${code} (unexpected)` };
  }
  return { reachable: false, detail: "port forward not working (connection refused)" };
}

async function verifyDashboardFromHost(
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
  retryDelaysMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<{ reachable: boolean; detail: string }> {
  let last = probeDashboardFromHostOnce(chain, deps);
  if (last.reachable) return last;
  for (const delayMs of retryDelaysMs) {
    await sleep(delayMs);
    last = probeDashboardFromHostOnce(chain, deps);
    if (last.reachable) return last;
  }
  return last;
}

/**
 * Detect the access method based on the chain configuration.
 */
function detectAccessMethod(chain: DashboardDeliveryChain): AccessMethod {
  if (chain.bindAddress === "0.0.0.0") return "proxy";
  if (chain.accessUrl.includes("127.0.0.1") || chain.accessUrl.includes("localhost"))
    return "localhost";
  return "ssh-tunnel";
}

export interface MessagingBridgeStatus {
  healthy: boolean;
  detail: string;
  /** Channel names that the gateway has no bridge provider for. */
  missingProviders: string[];
  /**
   * Channel names recorded in the registry but not corroborated by the
   * OpenClaw runtime log. Null when the probe was not run or the log
   * layer was unavailable. Empty array means the probe ran with log
   * corroboration and everything matched. See #4156.
   */
  runtimeMissing: string[] | null;
  /**
   * Channel names recorded in the registry but absent from the in-sandbox
   * config file. Surfaced even when the log layer is unavailable so a
   * stale rebuild can be detected without runtime corroboration. Null
   * when the probe was not run or no config-only diff was performed.
   */
  configMissing: string[] | null;
  /** Detail from the runtime probe when it ran (ok or failure reason). */
  runtimeProbeDetail: string | null;
}

/**
 * Verify messaging bridge health for all configured channels. Combines the
 * provider-attachment check (does OpenShell know about the bridge?) with the
 * runtime-config probe (does the in-sandbox agent config actually expose
 * the channel?) so the "No channels found" dashboard symptom from #4156
 * surfaces here as a warning.
 */
function verifyMessagingBridges(
  sandboxName: string,
  deps: VerifyDeploymentDeps,
): MessagingBridgeStatus {
  const channels = deps.getMessagingChannels(sandboxName);
  if (channels.length === 0) {
    return {
      healthy: true,
      detail: "no messaging channels configured",
      missingProviders: [],
      runtimeMissing: null,
      configMissing: null,
      runtimeProbeDetail: null,
    };
  }
  const missingProviders: string[] = [];
  for (const channel of channels) {
    const providerNames = getMessagingProviderNamesForChannel(sandboxName, channel);
    if (providerNames.length === 0 && TOKENLESS_MESSAGING_CHANNELS.has(channel)) {
      continue;
    }
    const expectedProviders = providerNames.length > 0 ? providerNames : [channel];
    if (!expectedProviders.every((providerName) => deps.providerExistsInGateway(providerName))) {
      missingProviders.push(channel);
    }
  }
  let runtimeMissing: string[] | null = null;
  let configMissing: string[] | null = null;
  let runtimeProbeDetail: string | null = null;
  let runtimeProbeFailed = false;
  let runtimeProbeOnlyConfig = false;
  if (deps.probeChannelRuntimeStatus) {
    const runtime = deps.probeChannelRuntimeStatus();
    if (runtime) {
      runtimeProbeDetail = runtime.detail;
      if (runtime.ok) {
        if (runtime.logProbeOk) {
          // Log corroboration is available — compare the registry's
          // expected set with what the runtime actually acknowledged.
          // Catches both "config drops the channel" (stale/bad rebuild)
          // and "config has it but runtime never started it" (#4156).
          runtimeMissing = compareChannelSets(channels, runtime.visibleChannels).missing;
        } else {
          // No log to corroborate; we cannot honestly claim which channels
          // are missing at runtime, so do not populate `runtimeMissing`.
          // We CAN still detect a config-only mismatch — registry expects
          // telegram but openclaw.json never had the channel block — so
          // diff against the config-derived set and surface that separately
          // (CodeRabbit catch on PR #4182).
          configMissing = compareChannelSets(channels, runtime.configuredChannels).missing;
          runtimeProbeOnlyConfig = true;
        }
      } else {
        // ok=false = could not read /sandbox/.openclaw/openclaw.json (missing,
        // empty, invalid JSON, or sandbox unreachable). With provider checks
        // alone this case would silently pass — yet it's exactly the
        // malformed-runtime-config the probe was added to catch (#4156).
        // Treat it as warn-level so the diagnostic surfaces with the probe's
        // own detail string instead of being swallowed.
        runtimeProbeFailed = true;
      }
    }
  }
  const parts: string[] = [];
  if (missingProviders.length > 0) {
    parts.push(`missing providers: ${missingProviders.join(", ")}`);
  }
  if (runtimeMissing && runtimeMissing.length > 0) {
    parts.push(`configured but not in OpenClaw runtime: ${runtimeMissing.join(", ")}`);
  }
  if (configMissing && configMissing.length > 0) {
    // Specific to the log-unavailable branch: registry expected channels
    // are absent from the in-sandbox config altogether, so we know they
    // can't possibly load at runtime regardless of the missing log.
    parts.push(`missing from sandbox config: ${configMissing.join(", ")}`);
  }
  if (runtimeProbeFailed && runtimeProbeDetail) {
    parts.push(`runtime channel probe inconclusive: ${runtimeProbeDetail}`);
  }
  if (runtimeProbeOnlyConfig) {
    // The gateway log was unreadable, so we can't actually confirm the
    // runtime started each bridge. `runtimeMissing` stays null in this
    // branch (see above) — surface the "checked config only" caveat so
    // the operator inspects the dashboard.
    parts.push("runtime gateway log not yet available; checked config only");
  }
  const healthy =
    missingProviders.length === 0 &&
    (!runtimeMissing || runtimeMissing.length === 0) &&
    (!configMissing || configMissing.length === 0) &&
    !runtimeProbeFailed &&
    !runtimeProbeOnlyConfig;
  const detail = healthy
    ? `${channels.length} channel(s) attached`
    : parts.join("; ") || "messaging channel verification failed";
  return {
    healthy,
    detail,
    missingProviders,
    runtimeMissing,
    configMissing,
    runtimeProbeDetail,
  };
}

function buildMessagingHint(messaging: MessagingBridgeStatus): string {
  if (messaging.runtimeMissing && messaging.runtimeMissing.length > 0) {
    // Either cause — missing from openclaw.json (stale rebuild) or
    // present in config but never logged by the runtime — produces this
    // diff. Keep the copy neutral so the operator checks both layers
    // rather than chasing only the log path (CodeRabbit on PR #4182).
    return (
      `Configured channel(s) ${messaging.runtimeMissing.join(", ")} were not visible to the OpenClaw ` +
      `runtime. The dashboard "Channels" panel will show "No channels found" for these. Inspect ` +
      `\`/sandbox/.openclaw/openclaw.json\` and the gateway log with \`nemoclaw <sandbox> logs\`, ` +
      `then re-run \`nemoclaw <sandbox> rebuild\` if the channel block needs to be regenerated.`
    );
  }
  if (messaging.configMissing && messaging.configMissing.length > 0) {
    // Config-only branch: we couldn't read the runtime log, but we can
    // still see that the registry expects channels that openclaw.json
    // doesn't have. That's a stale rebuild — the runtime cannot possibly
    // start them.
    return (
      `Configured channel(s) ${messaging.configMissing.join(", ")} are missing from ` +
      `\`/sandbox/.openclaw/openclaw.json\` — the runtime cannot start them. Re-run ` +
      `\`nemoclaw <sandbox> rebuild\` so the channel block is regenerated.`
    );
  }
  if (messaging.missingProviders.length === 0 && messaging.runtimeProbeDetail) {
    // Provider attachment looks fine but the runtime config could not be read.
    // Tell the operator how to follow up rather than burying the probe detail.
    return (
      `Could not verify the OpenClaw runtime channel registry: ${messaging.runtimeProbeDetail}. ` +
      `Start the sandbox and re-run \`nemoclaw <sandbox> doctor\`, or rebuild with ` +
      `\`nemoclaw <sandbox> rebuild\` if the config file is missing.`
    );
  }
  return "Some messaging providers are not attached to the gateway. Re-run onboard with the relevant channels enabled.";
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Run full post-deployment verification. Call this between
 * ensureDashboardForward() and printDashboard() in onboard.ts.
 *
 * Returns a structured result with pass/fail for each link and
 * actionable diagnostics on failure.
 */
export async function verifyDeployment(
  sandboxName: string,
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
  options: VerifyDeploymentOptions = {},
): Promise<VerifyDeploymentResult> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const diagnostics: DeploymentDiagnostic[] = [];

  // 1. Gateway reachable inside sandbox
  const gateway = await verifyGatewayInSandbox(sandboxName, chain, deps, retryDelaysMs, sleep);
  diagnostics.push({
    link: "gateway",
    status: gateway.reachable ? "ok" : "fail",
    detail: gateway.detail,
    hint: gateway.reachable ? "" : buildGatewayLogHint(sandboxName),
  });

  // 2. Gateway version (cosmetic — not a health signal)
  const gatewayVersion = gateway.reachable ? fetchGatewayVersion(sandboxName, deps) : null;

  // 3. Dashboard reachable from host (port forward)
  const dashboard = await verifyDashboardFromHost(chain, deps, retryDelaysMs, sleep);
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

  // 5. Messaging bridges (providers attached AND runtime config exposes
  // each configured channel — #4156).
  const messaging = verifyMessagingBridges(sandboxName, deps);
  if (!messaging.healthy) {
    diagnostics.push({
      link: "messaging",
      status: "warn",
      detail: messaging.detail,
      hint: buildMessagingHint(messaging),
    });
  }

  const accessMethod = detectAccessMethod(chain);

  const verification: DeploymentVerification = {
    gatewayReachable: gateway.reachable,
    gatewayVersion,
    inferenceRouteWorking: inference.working,
    dashboardReachable: dashboard.reachable,
    messagingBridgesHealthy: messaging.healthy,
    messagingRuntimeChannelsMissing: messaging.runtimeMissing,
    messagingConfigChannelsMissing: messaging.configMissing,
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
    // The overall result is healthy when gateway + dashboard are reachable,
    // but the run can still carry warn-level diagnostics (#4156: configured
    // channels missing from the runtime registry would otherwise pass
    // silently and the user would only learn about it from the dashboard's
    // "No channels found" panel after the fact). Surface those alongside
    // the success line instead of swallowing them.
    for (const d of result.diagnostics) {
      if (d.status !== "warn") continue;
      lines.push(`  ${Y}!${RESET} ${d.link}: ${d.detail}`);
      if (d.hint) {
        lines.push(`    ${D}${d.hint}${RESET}`);
      }
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
