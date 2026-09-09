// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific onboarding logic — called from onboard.ts when a
// non-default agent (e.g. Hermes) is selected via --agent flag or
// NEMOCLAW_AGENT env var. The OpenClaw path never touches this module.

import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import type { CaptureOpenshellResult } from "../adapters/openshell/client";
import { getAgentBranding } from "../cli/branding";
import type { JsonObject as LooseObject } from "../core/json-types";
import { sleepSeconds } from "../core/wait";
import { getProviderSelectionConfig } from "../inference/config";
import { runSandboxConfigSync, sandboxConfigSyncArgs } from "../onboard/config-sync";
import { isValidForwardPort } from "../onboard/dashboard-runtime";
import {
  resolveSandboxHermesApiPort,
  retargetHermesApiPortInUrl,
} from "../onboard/hermes-api-port";

export {
  createHermesApiPortScopedSandboxEntryPoints,
  createHermesApiPortReservationScope,
  type HermesApiPortReservationScope,
  reserveCreateSandboxHermesApiPort,
  withHermesApiPortReservationScope,
} from "../onboard/hermes-api-port";

import { redact, run } from "../runner";
import * as registry from "../state/registry";
import * as baseImage from "./base-image";
import { describeAgentBinaryFailure, verifyAgentBinaryAvailable } from "./binary-availability";
import { printOptionalDashboardUi } from "./dashboard-ui";
import {
  type AgentDefinition,
  isTerminalAgent,
  loadAgent,
  requireAgentPolicyAdditionsPath,
  requireCandidateQualificationEnabled,
  resolveAgentName,
} from "./defs";
import { waitForAgentGatewayReady } from "./gateway-readiness";
import { runAgentSmokeCommands } from "./terminal-smoke";
import { enforceTerminalAgentVersion } from "./terminal-version-enforcement";
import { printBearerTokenApiAccess } from "./web-auth-ui";

export { verifyAgentBinaryAvailable } from "./binary-availability";

export interface OnboardContext {
  step: (current: number, total: number, message: string) => void;
  runCaptureOpenshell: (
    args: string[],
    opts?: { ignoreError?: boolean; includeStderr?: boolean; timeout?: number },
  ) => string | null;
  captureOpenshell?: (
    args: string[],
    opts?: { ignoreError?: boolean; includeStderr?: boolean; timeout?: number },
  ) => CaptureOpenshellResult;
  openshellShellCommand: (args: string[], options?: { openshellBinary?: string }) => string;
  openshellBinary: string;
  gatewayName?: string;
  startRecordedStep: (stepName: string, updates: LooseObject) => Promise<void>;
  recordStepComplete: (stepName: string, updates: LooseObject) => Promise<unknown>;
  recordStepFailed: (stepName: string, message: string | null) => Promise<unknown>;
  skippedStepMessage: (stepName: string, sandboxName: string) => void;
  revalidateSandboxIdentity?: (operation: string) => void;
  now?: () => number;
  sleepSeconds?: (seconds: number) => void;
}

// Keep these compatibility exports as ordinary writable functions. Focused
// onboarding and rebuild harnesses replace them at the facade boundary, while
// the implementation stays isolated in base-image.ts.
export function getAgentSandboxBaseImageEnvVar(agentName: string): string {
  return baseImage.getAgentSandboxBaseImageEnvVar(agentName);
}

export function pinAgentSandboxBaseImageRef(
  agentName: string,
  imageRef: string,
  options: { forceLocal?: boolean; temporary?: boolean } = {},
): string {
  return baseImage.pinAgentSandboxBaseImageRef(agentName, imageRef, options);
}

export function bindLocalAgentBaseImageToPinnedProvenance(
  agent: AgentDefinition,
  imageRef: string,
): ReturnType<typeof baseImage.bindLocalAgentBaseImageToPinnedProvenance> {
  return baseImage.bindLocalAgentBaseImageToPinnedProvenance(agent, imageRef);
}

export function bindLocalAgentBaseImageHandoffToResolution(
  agent: AgentDefinition,
  sourceRef: string,
  handoffRef: string,
  metadata: import("../sandbox-base-image").SandboxBaseImageResolutionMetadata,
  reusedResolutionHint: import("../sandbox-base-image").SandboxBaseImageResolutionMetadata,
): ReturnType<typeof baseImage.bindLocalAgentBaseImageHandoffToResolution> {
  return baseImage.bindLocalAgentBaseImageHandoffToResolution(
    agent,
    sourceRef,
    handoffRef,
    metadata,
    reusedResolutionHint,
  );
}

export function pinTrustedAgentBaseImageOverrideForOperation(
  overrideEnvVar: string,
  override: import("../sandbox-base-image").TrustedLocalBaseImageOverride,
): () => void {
  return baseImage.pinTrustedAgentBaseImageOverrideForOperation(overrideEnvVar, override);
}

export function pinTrustedAgentRemoteBaseImageOverrideForOperation(
  overrideEnvVar: string,
  override: baseImage.TrustedRemoteBaseImageOverride,
): () => void {
  return baseImage.pinTrustedAgentRemoteBaseImageOverrideForOperation(overrideEnvVar, override);
}

export function hermesBaseImageSupportsMcp(imageRef: string): boolean {
  return baseImage.hermesBaseImageSupportsMcp(imageRef);
}

export function ensureAgentBaseImage(
  agent: AgentDefinition,
  options: baseImage.EnsureAgentBaseImageOptions = {},
): baseImage.EnsureAgentBaseImageResult {
  return baseImage.ensureAgentBaseImage(agent, options);
}

export function createAgentSandbox(
  agent: AgentDefinition,
  options: baseImage.CreateAgentSandboxOptions = {},
): baseImage.CreateAgentSandboxResult {
  return baseImage.createAgentSandbox(agent, options);
}

/**
 * Resolve the effective agent from CLI flags, env, or session.
 * Returns null for openclaw (default path), loaded agent object otherwise.
 */
export function resolveAgent({
  agentFlag = null,
  session = null,
}: {
  agentFlag?: string | null;
  session?: { agent?: string } | null;
} = {}): AgentDefinition | null {
  const name = resolveAgentName({ agentFlag, session });
  if (name === "openclaw") return null;
  requireCandidateQualificationEnabled(name);
  return loadAgent(name);
}

/**
 * Get the agent-specific network policy path, or null to use the default.
 */
export function getAgentPolicyPath(agent: AgentDefinition): string | null {
  if (agent.name === "openclaw") return null;
  return requireAgentPolicyAdditionsPath(agent);
}

/**
 * Sleep for the requested number of seconds using the shared wait helper.
 */
function sleep(seconds: number): void {
  sleepSeconds(seconds);
}

const HERMES_TIRITH_MARKER_ABSENT = "tirith marker: absent";
const HERMES_STARTUP_DIAGNOSTICS_SCRIPT = `
set +e
marker=/sandbox/.hermes/.tirith-install-failed
if [ ! -e "$marker" ]; then
  echo "${HERMES_TIRITH_MARKER_ABSENT}"
  exit 0
fi
if [ -L "$marker" ]; then
  echo "tirith marker: symlink (not read)"
else
  printf "tirith marker: "
  head -c 200 "$marker" 2>/dev/null || printf "unreadable"
  printf "\\n"
fi

tirith=/sandbox/.hermes/bin/tirith
if [ -x "$tirith" ] && [ ! -L "$tirith" ]; then
  echo "tirith binary: present executable ($tirith)"
elif [ -e "$tirith" ]; then
  echo "tirith binary: present but not executable ($tirith)"
else
  echo "tirith binary: missing ($tirith)"
fi

for log in /tmp/nemoclaw-start.log /tmp/gateway.log; do
  if [ -f "$log" ] && [ ! -L "$log" ]; then
    echo "--- tail: $log ---"
    tail -n 40 "$log" 2>/dev/null || echo "(tail unavailable)"
  elif [ -L "$log" ]; then
    echo "--- tail: $log skipped (symlink) ---"
  else
    echo "--- tail: $log unavailable ---"
  fi
done
`.trim();

/**
 * Collect read-only Hermes startup diagnostics for Step 7 health timeouts.
 * Returns no extra lines when the Tirith marker is absent so non-Tirith
 * failures keep the existing terse error shape.
 */
export function collectHermesStartupDiagnostics(
  sandboxName: string,
  runCaptureOpenshell: OnboardContext["runCaptureOpenshell"],
): string[] {
  const output = runCaptureOpenshell(
    ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", HERMES_STARTUP_DIAGNOSTICS_SCRIPT],
    { ignoreError: true },
  );
  const redactedOutput = String(redact(output ?? ""));
  const lines = redactedOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const markerLine = lines.find((line) => line.startsWith("tirith marker:"));
  if (!markerLine || markerLine === HERMES_TIRITH_MARKER_ABSENT) {
    return [];
  }
  return ["Hermes startup diagnostics:", ...lines.slice(0, 140)];
}

/**
 * Record and print an agent setup failure before exiting the onboarding flow.
 */
async function failAgentSetup(
  sandboxName: string,
  agent: AgentDefinition,
  message: string,
  recordStepFailed: OnboardContext["recordStepFailed"],
  details: string[] = [],
  revalidateSandboxIdentity?: OnboardContext["revalidateSandboxIdentity"],
): Promise<never> {
  revalidateSandboxIdentity?.(`record failed agent setup for sandbox '${sandboxName}'`);
  await recordStepFailed(
    "agent_setup",
    details.length > 0 ? `${message}\n${details.join("\n")}` : message,
  );
  console.error("  \u2717 Agent setup failed.");
  console.error("    Check the sandbox logs for redacted diagnostics.");
  process.exit(1);
}

/**
 * Interpret an agent health-probe response as healthy or unhealthy.
 */
export function isHealthProbeOk(result: string | null | undefined): boolean {
  const body = (result ?? "").trim();
  if (body === "ok") {
    return true;
  }
  try {
    const parsed = JSON.parse(body) as { status?: unknown };
    return parsed.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Hermes allocates a per-sandbox API port, so the manifest default names a port
 * a second sandbox has no listener on (#9739). Step 6 records the allocated
 * port before this step runs.
 */
function resolveAgentHealthProbeUrl(
  agent: AgentDefinition,
  sandboxName: string,
  probeUrl: string,
): string {
  if (agent.name !== "hermes") return probeUrl;
  return retargetHermesApiPortInUrl(
    probeUrl,
    resolveSandboxHermesApiPort(registry.getSandbox(sandboxName) ?? {}),
  );
}

const AGENT_BINARY_OBSERVATION_ATTEMPTS = 31;
const AGENT_BINARY_OBSERVATION_DELAY_SECONDS = 1;

/** Retry only an unobservable read-only exec while a newly Ready sandbox settles. */
function waitForAgentBinaryObservation(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: Parameters<typeof verifyAgentBinaryAvailable>[2],
  wait: (seconds: number) => void,
  gatewayName?: string,
) {
  let result = verifyAgentBinaryAvailable(sandboxName, agent, runCaptureOpenshell, gatewayName);
  for (
    let attempt = 1;
    !result.available &&
    result.reason === "unobservable" &&
    attempt < AGENT_BINARY_OBSERVATION_ATTEMPTS;
    attempt += 1
  ) {
    wait(AGENT_BINARY_OBSERVATION_DELAY_SECONDS);
    result = verifyAgentBinaryAvailable(sandboxName, agent, runCaptureOpenshell, gatewayName);
  }
  return result;
}

/**
 * Handle the full agent setup step (step 7) including resume detection.
 * For non-OpenClaw agents: writes config into the sandbox and verifies
 * the agent's health probe.
 */
export async function handleAgentSetup(
  sandboxName: string,
  model: string,
  provider: string,
  agent: AgentDefinition,
  resume: boolean,
  _session: object | null,
  ctx: OnboardContext,
): Promise<void> {
  const {
    step,
    runCaptureOpenshell,
    captureOpenshell,
    openshellBinary: openshellBin,
    startRecordedStep,
    recordStepComplete,
    recordStepFailed,
    skippedStepMessage,
    revalidateSandboxIdentity,
  } = ctx;

  const runSmokeCapture =
    agent.name === "langchain-deepagents-code" && captureOpenshell
      ? captureOpenshell
      : runCaptureOpenshell;
  const runBinaryCapture = captureOpenshell ?? runCaptureOpenshell;
  const waitForBinaryObservation = () =>
    waitForAgentBinaryObservation(
      sandboxName,
      agent,
      runBinaryCapture,
      ctx.sleepSeconds ?? sleep,
      ctx.gatewayName,
    );

  const syncNemoClawConfig = (): void => {
    revalidateSandboxIdentity?.(`synchronize agent configuration in sandbox '${sandboxName}'`);
    runSandboxConfigSync(sandboxName, {
      getSelectionConfig: () => {
        const cfg = getProviderSelectionConfig(provider, model);
        return cfg ? { ...cfg, agent: agent.name } : null;
      },
      runConnectScript: (name, scriptContent) => {
        run([openshellBin, ...sandboxConfigSyncArgs(name)], {
          stdio: ["pipe", "ignore", "inherit"],
          input: scriptContent,
        });
      },
    });
  };

  if (resume && sandboxName) {
    if (isTerminalAgent(agent)) {
      const binaryAvailability = waitForBinaryObservation();
      if (binaryAvailability.available) {
        syncNemoClawConfig();
        const smokeResult = runAgentSmokeCommands(
          sandboxName,
          agent,
          runSmokeCapture,
          ctx.gatewayName,
        );
        if (smokeResult.ok) {
          await enforceTerminalAgentVersion(sandboxName, agent, runCaptureOpenshell, {
            beforeFailure: () => {
              revalidateSandboxIdentity?.(
                `start failed agent setup recording for sandbox '${sandboxName}'`,
              );
              return startRecordedStep("agent_setup", { sandboxName, provider, model });
            },
            onFailure: (message) =>
              failAgentSetup(
                sandboxName,
                agent,
                message,
                recordStepFailed,
                [],
                revalidateSandboxIdentity,
              ),
          });
          revalidateSandboxIdentity?.(`record resumed agent setup for sandbox '${sandboxName}'`);
          skippedStepMessage("agent_setup", sandboxName);
          await recordStepComplete("agent_setup", { sandboxName, provider, model });
          return;
        }
      }
    }

    const probe = agent.healthProbe;
    if (probe?.url) {
      const probeUrl = resolveAgentHealthProbeUrl(agent, sandboxName, probe.url);
      const result = runCaptureOpenshell(
        [
          "sandbox",
          "exec",
          "-n",
          sandboxName,
          "--",
          "curl",
          ...buildValidatedCurlCommandArgs(["-sf", "--max-time", "3", probeUrl]),
        ],
        { ignoreError: true },
      );
      if (isHealthProbeOk(result)) {
        // Re-sync `~/.nemoclaw/config.json` even on the resume skip path —
        // a rebuild destroys/recreates the container and the file reverts
        // to the Dockerfile's zero-byte placeholder. Mirrors the OpenClaw
        // path in src/lib/onboard.ts. Fixes #3999 for non-OpenClaw agents.
        syncNemoClawConfig();
        revalidateSandboxIdentity?.(`record resumed agent setup for sandbox '${sandboxName}'`);
        skippedStepMessage("agent_setup", sandboxName);
        await recordStepComplete("agent_setup", { sandboxName, provider, model });
        return;
      }
    }
  }

  revalidateSandboxIdentity?.(`start agent setup for sandbox '${sandboxName}'`);
  await startRecordedStep("agent_setup", { sandboxName, provider, model });
  step(7, 8, `Setting up ${agent.displayName} inside sandbox`);

  const binaryAvailability = waitForBinaryObservation();
  if (!binaryAvailability.available) {
    await failAgentSetup(
      sandboxName,
      agent,
      describeAgentBinaryFailure(sandboxName, agent, binaryAvailability),
      recordStepFailed,
      [],
      revalidateSandboxIdentity,
    );
  }

  syncNemoClawConfig();

  if (isTerminalAgent(agent)) {
    const smokeResult = runAgentSmokeCommands(sandboxName, agent, runSmokeCapture, ctx.gatewayName);
    if (!smokeResult.ok) {
      await failAgentSetup(
        sandboxName,
        agent,
        `${agent.displayName} terminal smoke command failed: ${smokeResult.command}`,
        recordStepFailed,
        smokeResult.output ? [String(redact(smokeResult.output)).slice(0, 500)] : [],
        revalidateSandboxIdentity,
      );
    }
    await enforceTerminalAgentVersion(sandboxName, agent, runCaptureOpenshell, {
      onFailure: (message) =>
        failAgentSetup(
          sandboxName,
          agent,
          message,
          recordStepFailed,
          [],
          revalidateSandboxIdentity,
        ),
    });
    revalidateSandboxIdentity?.(`record completed agent setup for sandbox '${sandboxName}'`);
    console.log(`  \u2713 ${agent.displayName} terminal runtime is ready`);
    await recordStepComplete("agent_setup", { sandboxName, provider, model });
    return;
  }

  const probe = agent.healthProbe;
  if (probe?.url) {
    const timeoutSecs = probe.timeout_seconds || 60;
    const probeUrl = resolveAgentHealthProbeUrl(agent, sandboxName, probe.url);
    console.log(`  Waiting for ${agent.displayName} gateway (up to ${timeoutSecs}s)...`);
    const healthy = waitForAgentGatewayReady({
      timeoutSeconds: timeoutSecs,
      now: ctx.now,
      sleepSeconds: ctx.sleepSeconds ?? sleep,
      probe: () => {
        const result = runCaptureOpenshell(
          [
            "sandbox",
            "exec",
            "-n",
            sandboxName,
            "--",
            "curl",
            ...buildValidatedCurlCommandArgs(["-sf", "--max-time", "3", probeUrl]),
          ],
          { ignoreError: true },
        );
        return isHealthProbeOk(result);
      },
    });
    if (healthy) {
      revalidateSandboxIdentity?.(`record completed agent setup for sandbox '${sandboxName}'`);
      console.log(`  \u2713 ${agent.displayName} gateway is healthy`);
    } else {
      const diagnostics =
        agent.name === "hermes"
          ? collectHermesStartupDiagnostics(sandboxName, runCaptureOpenshell)
          : [];
      await failAgentSetup(
        sandboxName,
        agent,
        `${agent.displayName} gateway did not respond within ${timeoutSecs}s`,
        recordStepFailed,
        diagnostics,
        revalidateSandboxIdentity,
      );
    }
  } else {
    revalidateSandboxIdentity?.(`record completed agent setup for sandbox '${sandboxName}'`);
    console.log(`  \u2713 ${agent.displayName} configured inside sandbox`);
  }

  await recordStepComplete("agent_setup", { sandboxName, provider, model });
}

/**
 * Get dashboard info for a non-OpenClaw agent.
 */
export function getAgentDashboardInfo(agent: AgentDefinition): {
  port: number;
  displayName: string;
} {
  return {
    port: agent.forwardPort,
    displayName: agent.displayName,
  };
}

/**
 * Redact browser token fragments before printing dashboard URLs.
 */
function dashboardUrlForDisplay(url: string): string {
  return redact(url.replace(/#token=[^\s'"]*$/i, ""));
}

/**
 * Print the dashboard UI section for a non-OpenClaw agent.
 *
 * When the agent manifest declares `dashboard.kind: api`, we print the
 * endpoint as an API (no tokenized URL fragment — the caller authenticates
 * via a header) and use the manifest-supplied label/path. Otherwise we fall
 * back to the original UI-style output used by browser dashboards.
 */
export function printDashboardUi(
  sandboxName: string,
  token: string | null,
  agent: AgentDefinition,
  deps: {
    note: (msg: string) => void;
    buildControlUiUrls: (token: string | null, port: number) => string[];
    effectiveDashboardPort?: number;
  },
): void {
  const info = getAgentDashboardInfo(agent);
  const { auth, kind, label, path } = agent.dashboard;
  const cliName = getAgentBranding(agent.name).cli;
  const effectiveDashboardPort = isValidForwardPort(deps.effectiveDashboardPort)
    ? deps.effectiveDashboardPort
    : info.port;

  if (kind === "api") {
    console.log(`  ${info.displayName} ${label}`);
    console.log(`  Port ${info.port} must be forwarded before connecting.`);
    const seen = new Set<string>();
    for (const baseUrl of deps.buildControlUiUrls(null, info.port)) {
      const withoutHash = baseUrl.split("#")[0].replace(/\/$/, "");
      const url = path && path !== "/" ? `${withoutHash}${path}` : `${withoutHash}/`;
      if (seen.has(url)) continue;
      seen.add(url);
      console.log(`  ${dashboardUrlForDisplay(url)}`);
    }
    printBearerTokenApiAccess(sandboxName, agent, cliName);
    printOptionalDashboardUi(agent, { ...deps, redactUrl: dashboardUrlForDisplay });
    printAdditionalForwardPorts(agent, info.port, deps.buildControlUiUrls, sandboxName);
    return;
  }

  if (auth !== "url_token") {
    console.log(`  ${info.displayName} ${label}`);
    console.log(`  Port ${effectiveDashboardPort} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(null, effectiveDashboardPort)) {
      console.log(`  ${dashboardUrlForDisplay(url)}`);
    }
    printBearerTokenApiAccess(sandboxName, agent, cliName);
    printOptionalDashboardUi(agent, {
      ...deps,
      effectiveDashboardPort,
      redactUrl: dashboardUrlForDisplay,
    });
    printAdditionalForwardPorts(
      agent,
      effectiveDashboardPort,
      deps.buildControlUiUrls,
      sandboxName,
    );
    return;
  }

  if (token) {
    console.log(`  ${info.displayName} ${label} (auth token redacted from displayed URLs)`);
    console.log(`  Port ${effectiveDashboardPort} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(token, effectiveDashboardPort)) {
      console.log(`  ${dashboardUrlForDisplay(url)}`);
    }
    console.log(`  Token: ${cliName} ${sandboxName} gateway-token --quiet`);
    console.log(`         append  #token=<token> locally if the browser asks for auth.`);
  } else {
    deps.note("  Could not read gateway token from the sandbox (download failed).");
    console.log(`  ${info.displayName} ${label}`);
    console.log(`  Port ${effectiveDashboardPort} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(null, effectiveDashboardPort)) {
      console.log(`  ${dashboardUrlForDisplay(url)}`);
    }
  }
  printOptionalDashboardUi(agent, {
    ...deps,
    effectiveDashboardPort,
    redactUrl: dashboardUrlForDisplay,
  });
  printAdditionalForwardPorts(agent, effectiveDashboardPort, deps.buildControlUiUrls, sandboxName);
}

/**
 * Print one block per manifest-declared `forward_ports` entry that is not
 * the primary dashboard port. Each block announces the port and renders a
 * loopback URL using the same `buildControlUiUrls` chain as the primary
 * dashboard so WSL host-address fallbacks remain consistent.
 *
 * The label is sourced from the agent's `health_probe.port` match — that
 * is the only manifest signal today that a declared secondary port is the
 * OpenAI-compatible API surface (Hermes manifest sets
 * `health_probe.port: 8642` alongside `forward_ports: [18789, 8642]`).
 * Any other declared port gets a neutral "additional port" label.
 *
 * The URL filter normalises empty `URL.port` results to the scheme
 * default. `new URL("http://h:80").port` returns `""` because WHATWG
 * URL elides the default scheme port; a strict `urlPort === String(port)`
 * comparison would silently drop scheme-default URLs from older or
 * direct-call agent definitions. The normalisation keeps the filter
 * sound while still excluding any URL whose port truly does not match
 * the declared entry.
 */
function printAdditionalForwardPorts(
  agent: AgentDefinition,
  primaryPort: number,
  buildControlUiUrls: (token: string | null, port: number) => string[],
  sandboxName?: string,
): void {
  const declared = Array.isArray(agent.forward_ports) ? agent.forward_ports : [];
  if (declared.length === 0) return;
  const declaredApiPort = agent.healthProbe?.port;
  // The manifest names Hermes' default API port. This sandbox owns its own, so
  // announce the port the operator actually has to forward. Only Hermes
  // allocates a per-sandbox API port; every other agent keeps its declared one.
  const sandboxApiPort =
    agent.name === "hermes"
      ? resolveSandboxHermesApiPort(
          (sandboxName ? registry.getSandbox(sandboxName) : undefined) ?? {},
        )
      : 0;
  for (const declaredPort of declared) {
    if (!Number.isInteger(declaredPort) || declaredPort < 1024 || declaredPort > 65535) continue;
    if (declaredPort === primaryPort || declaredPort === agent.forwardPort) continue;
    const isApi = declaredPort === declaredApiPort;
    const port = isApi && agent.name === "hermes" ? sandboxApiPort : declaredPort;
    const sectionLabel = isApi ? "OpenAI-compatible API" : "additional port";
    console.log("");
    console.log(`  ${agent.displayName} ${sectionLabel}`);
    console.log(`  Port ${port} must be forwarded before connecting.`);
    const seen = new Set<string>();
    for (const baseUrl of buildControlUiUrls(null, port)) {
      const withoutHash = baseUrl.split("#")[0].replace(/\/$/, "");
      const resolvedUrlPort = resolveUrlPort(withoutHash);
      if (resolvedUrlPort !== port) continue;
      const url = isApi ? `${withoutHash}/v1` : `${withoutHash}/`;
      if (seen.has(url)) continue;
      seen.add(url);
      console.log(`  ${dashboardUrlForDisplay(url)}`);
    }
  }
}

/**
 * Resolve the effective port of `candidate`, normalising the WHATWG
 * URL behaviour that returns an empty string for the scheme-default
 * port (`http://h:80` → `""`, `https://h:443` → `""`). Returns the
 * integer port, or `null` when the input is unparseable or carries no
 * recoverable port. The mapping is intentionally limited to `http` /
 * `https` / `ws` / `wss` — the four schemes the dashboard URL builder
 * emits — so an unknown scheme falls through to `null` instead of
 * silently mapping to 80 or 443.
 */
function resolveUrlPort(candidate: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.port !== "") {
    const numeric = Number(parsed.port);
    return Number.isInteger(numeric) ? numeric : null;
  }
  const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
  switch (protocol) {
    case "http":
      return 80;
    case "https":
      return 443;
    case "ws":
      return 80;
    case "wss":
      return 443;
    default:
      return null;
  }
}
