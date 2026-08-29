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

import os from "node:os";

import { parseVersionFromText } from "./adapters/openshell/client";
import {
  isDcodeOpenRouterModelsRoute404,
  runSandboxInferenceInvocationProbe,
  type SandboxInferenceRouteHealthContext,
} from "./actions/sandbox/inference-route-health";
import { compareChannelSets, type RuntimeChannelStatus } from "./channel-runtime-status";
import type { DashboardDeliveryChain } from "./dashboard/contract";
import { listMessagingChannelsWithoutCredentials } from "./messaging/channels";

import { retryUntilAsync } from "./core/retry";
import {
  buildCustomOpenClawRuntimeFailureHints,
  classifyOpenClawRuntimeFailure,
  type SandboxCommandExecutor,
} from "./onboard/custom-openclaw-runtime-diagnosis";
import { GATEWAY_PORT, resolveGatewayLogPathForPort } from "./onboard/gateway/state-dir";
import { getMessagingProviderNamesForChannel } from "./onboard/messaging-reuse";

export { shouldDiagnoseCustomOpenClawRuntime } from "./onboard/custom-openclaw-runtime-diagnosis";

// ── Types ────────────────────────────────────────────────────────────

export type AccessMethod = "localhost" | "proxy" | "ssh-tunnel";

export interface DeploymentVerification {
  gatewayReachable: boolean;
  gatewayVersion: string | null;
  inferenceRouteWorking: boolean;
  dashboardReachable: boolean;
  /**
   * Host reachability of the agent's OpenAI-compatible API forward, or null
   * when the agent publishes no API port separate from the dashboard (every
   * agent but Hermes today). Distinct from `gatewayReachable`, which only
   * proves the API answers *inside* the sandbox: the host forward can be down
   * while the in-sandbox listener is perfectly healthy (#9290).
   */
  agentApiReachable: boolean | null;
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
  executeSandboxCommand: SandboxCommandExecutor;

  /** Probe an HTTP endpoint on the host. Returns the HTTP status code or 0 on failure. */
  probeHostPort: (port: number, path: string) => number;

  /** List active port forwards. Returns raw output from `openshell forward list`. */
  captureForwardList: () => string | null;

  /** Get the list of configured messaging channels for a sandbox. */
  getMessagingChannels: (name: string) => string[];

  /** Check if a messaging bridge is polling (provider exists in gateway). */
  providerExistsInGateway: (providerName: string) => boolean;

  /**
   * Send one bounded inference request over the gateway route from inside the
   * sandbox. Only consulted for the Deep Agents Code OpenRouter models route,
   * whose HTTP 404 is expected (#9834) and can only be accepted on the
   * evidence of a served request. Optional: when it is absent that 404 fails
   * closed, because nothing validated the selected model (#10543).
   */
  probeInferenceInvocation?: () => { ok: boolean; detail?: string };

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
   * attempt. The defaults give a 90 s budget per probe before the
   * wizard surfaces a ✗ marker.
   * Tests pass `[]` to disable retry.
   */
  retryDelaysMs?: number[];
  /** Sleep helper, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Inspect a failed custom OpenClaw image for the managed runtime contract.
   * Keep this disabled for stock images and other agents, whose config and
   * startup paths intentionally differ.
   */
  diagnoseCustomOpenClawRuntime?: boolean;
  /**
   * Agent and provider behind this deployment, used to recognise the one
   * models route that answers HTTP 404 by design (#9834). Defaults to no
   * agent and no provider, which fails every 404 closed.
   */
  inferenceRouteContext?: InferenceRouteContext;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  1000, 2000, 5000, 7000, 10000, 15000, 20000, 30000,
];
// OpenClaw cron stops its provider preflight after 2.5 seconds. Require a
// response within 2 seconds so onboarding leaves time for client overhead.
const INFERENCE_ROUTE_REACHABILITY_MAX_SECONDS = 2;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// HTTP status codes that indicate the gateway process is alive.
// 401 = device auth is enabled but the gateway is running.
const GATEWAY_ALIVE_CODES = new Set([200, 401]);
const CREDENTIALLESS_MESSAGING_CHANNELS = new Set(listMessagingChannelsWithoutCredentials());

// Gateway-failure hint: cover both layers the probe could be failing at.
// The probe runs curl inside the sandbox against the in-sandbox OpenClaw
// gateway (initialised at /tmp/gateway.log by agent/runtime.ts), so the
// sandbox log is the first thing to check. If the sandbox itself never
// came up, the host-side OpenShell gateway log is the right place to
// look — see gatewayLogCandidates() in onboard/sandbox-create-failure.ts.
export function buildGatewayLogHint(
  sandboxName: string,
  customRuntimeHint: string | null,
  gatewayState: { configured?: string; home: string; port: number } = {
    configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    home: os.homedir(),
    port: GATEWAY_PORT,
  },
): string {
  if (customRuntimeHint) return customRuntimeHint;
  const hostGatewayLog = resolveGatewayLogPathForPort(gatewayState);
  return (
    `The gateway probe failed after retrying. Inspect the in-sandbox gateway log with ` +
    `\`nemoclaw ${sandboxName} logs\` (the gateway writes to /tmp/gateway.log inside the sandbox when it starts). ` +
    `If the sandbox itself never came up, also check the host-side OpenShell gateway log at ` +
    `\`${hostGatewayLog}\` ` +
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
  return retryUntilAsync(() => probeGatewayInSandboxOnce(sandboxName, chain, deps), {
    accept: (result) => result.reachable,
    retryDelaysMs,
    sleep,
  });
}

/**
 * Retrieve the gateway version from inside the sandbox.
 */
function fetchGatewayVersion(sandboxName: string, deps: VerifyDeploymentDeps): string | null {
  const script = "openclaw --version 2>/dev/null";
  const result = deps.executeSandboxCommand(sandboxName, script);
  if (!result || result.status !== 0 || !result.stdout.trim()) return null;
  return parseVersionFromText(result.stdout, "openclaw --version");
}

type InferenceRouteStatus = "ok" | "unreachable" | "unhealthy";

/**
 * Agent and provider behind the deployment, normalised into the context
 * `status` uses so the two readiness paths cannot drift (#10080).
 */
export type InferenceRouteContext = {
  agentName?: string | null;
  provider?: string | null;
};

function toRouteHealthContext(context: InferenceRouteContext): SandboxInferenceRouteHealthContext {
  return { agentName: context.agentName ?? null, provider: context.provider ?? null };
}

type InferenceRouteProbe = {
  status: InferenceRouteStatus;
  detail: string;
  /** Status the models route answered with, or 0 when it never answered. */
  httpCode: number;
  /** Set when the status alone would point the user at the wrong remedy. */
  hint?: string;
};

function probeInferenceRouteOnce(
  sandboxName: string,
  deps: VerifyDeploymentDeps,
): InferenceRouteProbe {
  const script =
    `HTTP_CODE=$(curl -so /dev/null -w '%{http_code}' --max-time ${INFERENCE_ROUTE_REACHABILITY_MAX_SECONDS} ` +
    `https://inference.local/v1/models 2>/dev/null || echo 000); echo $HTTP_CODE`;
  const result = deps.executeSandboxCommand(sandboxName, script);
  if (!result) {
    return { status: "unreachable", detail: "sandbox unreachable", httpCode: 0 };
  }
  const code = parseInt(result.stdout.trim(), 10) || 0;
  if (code === 0) {
    return {
      status: "unreachable",
      detail: "inference.local unreachable (DNS or proxy not running)",
      httpCode: 0,
    };
  }
  if (code >= 500) {
    return {
      status: "unhealthy",
      detail: `inference.local returned HTTP ${code} (route reachable but endpoint unhealthy)`,
      httpCode: code,
    };
  }
  // A models route that answers 404 has no model catalog, so nothing validated
  // the selected model against the provider. `status` already fails closed on
  // that (#10080); onboarding kept calling it healthy and exiting 0, so the two
  // readiness paths disagreed about the same route (#10543). A credential-gated
  // 401/403 stays healthy here: that route did answer, it just wants a key
  // (#2342).
  if (code === 404) {
    return {
      status: "unhealthy",
      detail:
        `inference.local returned HTTP ${code}, so the selected model was never ` +
        `validated against a model catalog`,
      httpCode: code,
    };
  }
  return { status: "ok", detail: `inference.local responded HTTP ${code}`, httpCode: code };
}

/**
 * A 404 needs its own hint: the route answered, so neither the "unreachable
 * proxy" nor the "5xx endpoint" remedy applies. The model catalog is what is
 * missing (#10543).
 */
function buildInferenceRouteHint(inference: InferenceRouteProbe): string {
  if (inference.status === "ok") return "";
  if (inference.hint) return inference.hint;
  if (inference.httpCode === 404) {
    return (
      "The inference route answered but served no model catalog, so the selected model was " +
      "never validated. Confirm the provider and model are configured for this sandbox and " +
      "that the endpoint serves /v1/models, then re-run: nemoclaw <sandbox> status."
    );
  }
  if (inference.status === "unhealthy") {
    return "The inference route is reachable but the endpoint returned a server error (HTTP 5xx). If the endpoint runs on the host, configure it to listen on a host address reachable through host.openshell.internal and restrict access with the host firewall or equivalent controls; a 127.0.0.1/localhost-only bind is not reachable from the sandbox. Then re-run: nemoclaw <sandbox> status.";
  }
  return "The inference proxy is unreachable. Confirm the configured endpoint is running and reachable from the sandbox, then re-run: nemoclaw <sandbox> status.";
}

/**
 * Resolve the one 404 that is expected: Deep Agents Code on OpenRouter serves
 * no model catalog (#9834). Matching the shared predicate is necessary but not
 * sufficient — the route status alone proves nothing about whether the sandbox
 * can invoke its selected model — so accept it only through a successful
 * bounded inference request, exactly as `status` does.
 */
function resolveExpectedModelsRoute404(
  probe: InferenceRouteProbe,
  deps: VerifyDeploymentDeps,
): InferenceRouteProbe {
  const invocation = deps.probeInferenceInvocation?.() ?? null;
  if (invocation?.ok) {
    return {
      status: "ok",
      detail:
        "inference.local served an inference request; its models route answers " +
        "HTTP 404 by design for this agent and provider",
      httpCode: probe.httpCode,
    };
  }
  const reason = invocation?.detail ?? "no inference request confirmed the selected model";
  return {
    status: "unhealthy",
    detail:
      `inference.local answered HTTP ${probe.httpCode} on its models route, which is expected ` +
      `for this agent and provider, but no inference request confirmed the selected model: ${reason}`,
    httpCode: probe.httpCode,
    hint:
      "This agent and provider serve no model catalog, so the models route answering HTTP 404 is " +
      "expected. The inference request itself failed. Confirm the provider credential and the " +
      "selected model, then re-run: nemoclaw <sandbox> status.",
  };
}

async function verifyInferenceRoute(
  sandboxName: string,
  deps: VerifyDeploymentDeps,
  retryDelaysMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
  context: InferenceRouteContext,
): Promise<InferenceRouteProbe> {
  const routeContext = toRouteHealthContext(context);
  const isExpected404 = (result: InferenceRouteProbe) =>
    isDcodeOpenRouterModelsRoute404(routeContext, result.httpCode);
  // An ordinary 404 still gets the startup budget: a route can answer before
  // its model catalog is registered, and the inference probe already recovers
  // a late route (#6849). Only the 404 that is expected settles immediately,
  // so the by-design case does not wait out a budget it can never satisfy.
  const probe = await retryUntilAsync(() => probeInferenceRouteOnce(sandboxName, deps), {
    accept: (result) => result.status === "ok" || isExpected404(result),
    retryDelaysMs,
    sleep,
  });
  return isExpected404(probe) ? resolveExpectedModelsRoute404(probe, deps) : probe;
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
  return retryUntilAsync(() => probeDashboardFromHostOnce(chain, deps), {
    accept: (result) => result.reachable,
    retryDelaysMs,
    sleep,
  });
}

/**
 * Does this agent publish an OpenAI-compatible API on its own host forward?
 *
 * `buildChain` falls back to the dashboard port when the agent declares no
 * separate gateway port, so a distinct `gatewayPort` is precisely the signal
 * that onboarding forwarded a second host port for the API (Hermes:
 * `forward_ports: [18789, 8642]`). Agents without one (OpenClaw) keep the
 * single dashboard probe and are unaffected.
 */
function hasSeparateAgentApiPort(chain: DashboardDeliveryChain): boolean {
  return Number.isInteger(chain.gatewayPort) && chain.gatewayPort !== chain.port;
}

/**
 * Verify the agent's OpenAI-compatible API port is reachable from the host.
 *
 * The in-sandbox gateway probe only proves the API listens inside the sandbox;
 * it says nothing about the host forward operators actually connect through.
 * Onboarding advertises that host URL on the success screen, so it has to be
 * probed from the host too. Otherwise, a failed API forward leaves onboarding
 * reporting a healthy deployment while the documented endpoint refuses every
 * connection (#9290).
 */
function probeAgentApiFromHostOnce(
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
): { reachable: boolean; detail: string } {
  const code = deps.probeHostPort(
    chain.gatewayPort,
    chain.gatewayHealthEndpoint ?? chain.healthEndpoint,
  );
  if (GATEWAY_ALIVE_CODES.has(code)) {
    return { reachable: true, detail: `host probe HTTP ${code}` };
  }
  if (code > 0) {
    return { reachable: false, detail: `host probe HTTP ${code} (unexpected)` };
  }
  return { reachable: false, detail: "port forward not working (connection refused)" };
}

async function verifyAgentApiFromHost(
  chain: DashboardDeliveryChain,
  deps: VerifyDeploymentDeps,
  retryDelaysMs: readonly number[],
  sleep: (ms: number) => Promise<void>,
): Promise<{ reachable: boolean; detail: string }> {
  return retryUntilAsync(() => probeAgentApiFromHostOnce(chain, deps), {
    accept: (result) => result.reachable,
    retryDelaysMs,
    sleep,
  });
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
    if (providerNames.length === 0 && CREDENTIALLESS_MESSAGING_CHANNELS.has(channel)) {
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
  // Diagnose only after the normal startup budget. A slow custom runtime should
  // get the same recovery window as the stock image, and an early unreachable
  // exec cannot safely prove that image artifacts are absent.
  const runtimeDiagnosis =
    !gateway.reachable && options.diagnoseCustomOpenClawRuntime
      ? classifyOpenClawRuntimeFailure(sandboxName, deps.executeSandboxCommand)
      : null;
  const customRuntimeHints = runtimeDiagnosis
    ? buildCustomOpenClawRuntimeFailureHints(runtimeDiagnosis)
    : null;
  diagnostics.push({
    link: "gateway",
    status: gateway.reachable ? "ok" : "fail",
    detail: gateway.detail,
    hint: gateway.reachable
      ? ""
      : buildGatewayLogHint(sandboxName, customRuntimeHints?.gateway ?? null),
  });

  // 2. Gateway version (cosmetic — not a health signal)
  const gatewayVersion = gateway.reachable ? fetchGatewayVersion(sandboxName, deps) : null;

  // 3. Dashboard reachable from host (port forward)
  // A port forward cannot repair an image that has no managed gateway runtime,
  // so avoid spending a second retry budget on the dependent dashboard probe.
  const dashboardRetryDelays = customRuntimeHints ? [] : retryDelaysMs;
  const dashboard = await verifyDashboardFromHost(chain, deps, dashboardRetryDelays, sleep);
  diagnostics.push({
    link: "dashboard",
    status: dashboard.reachable ? "ok" : "fail",
    detail: dashboard.detail,
    hint: dashboard.reachable
      ? ""
      : (customRuntimeHints?.dashboard ??
        `Port forward on ${chain.port} is not working. Run: openshell forward start ${chain.forwardTarget} ${sandboxName}`),
  });

  // 3b. Agent OpenAI-compatible API reachable from the host (second port
  // forward). Skipped for agents that publish no separate API port, so the
  // OpenClaw path keeps exactly one host probe. A dead host forward cannot be
  // repaired by retrying when the sandbox gateway itself never came up, so it
  // shares the dashboard's collapsed retry budget in that case.
  const agentApi = hasSeparateAgentApiPort(chain)
    ? await verifyAgentApiFromHost(chain, deps, dashboardRetryDelays, sleep)
    : null;
  if (agentApi) {
    diagnostics.push({
      link: "api",
      status: agentApi.reachable ? "ok" : "fail",
      detail: agentApi.detail,
      hint: agentApi.reachable
        ? ""
        : `The OpenAI-compatible API on port ${chain.gatewayPort} is not reachable from the host. ` +
          `Run: openshell forward start --background ${chain.gatewayPort} ${sandboxName}`,
    });
  }

  // 4. Inference route
  const inference = await verifyInferenceRoute(
    sandboxName,
    deps,
    gateway.reachable ? retryDelaysMs : [],
    sleep,
    options.inferenceRouteContext ?? {},
  );
  const inferenceRouteWorking = inference.status === "ok";
  diagnostics.push({
    link: "inference",
    status: inference.status === "ok" ? "ok" : "fail",
    detail: inference.detail,
    hint: buildInferenceRouteHint(inference),
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
    inferenceRouteWorking,
    dashboardReachable: dashboard.reachable,
    agentApiReachable: agentApi ? agentApi.reachable : null,
    messagingBridgesHealthy: messaging.healthy,
    messagingRuntimeChannelsMissing: messaging.runtimeMissing,
    messagingConfigChannelsMissing: messaging.configMissing,
    accessMethod,
  };

  // An unreachable agent API forward is a failed deployment, not a warning:
  // onboarding prints that endpoint as the way to use the sandbox (#9290).
  const healthy =
    gateway.reachable &&
    dashboard.reachable &&
    (agentApi?.reachable ?? true) &&
    inference.status === "ok";

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
    lines.push(
      `  ${G}✓${RESET} Deployment verified — gateway, dashboard, and inference route are healthy.`,
    );
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

export type InferenceInvocationContext = {
  sandboxName: string;
  gatewayName: string;
  agentName: string | null | undefined;
  model: string | null;
  provider: string | null;
  preferredInferenceApi: string | null;
};

/**
 * The standard `probeInferenceInvocation` dependency: send one bounded
 * inference request over the gateway route, using the same probe `status`
 * runs. Onboarding wires this so the one models route that answers HTTP 404 by
 * design — Deep Agents Code on OpenRouter (#9834) — is accepted only on the
 * evidence of a served request (#10543).
 */
export function probeOnboardInferenceInvocation(context: InferenceInvocationContext): {
  ok: boolean;
  detail?: string;
} {
  const { model, provider } = context;
  if (!model || !provider) {
    return { ok: false, detail: "no provider and model were recorded for this sandbox" };
  }
  const result = runSandboxInferenceInvocationProbe({
    sandboxName: context.sandboxName,
    gatewayName: context.gatewayName,
    agentName: context.agentName ?? null,
    provider,
    model,
    preferredInferenceApi: context.preferredInferenceApi,
  });
  return result.ok ? { ok: true } : { ok: false, detail: result.detail };
}
