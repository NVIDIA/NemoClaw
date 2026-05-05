// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific onboarding logic — called from onboard.ts when a
// non-default agent (e.g. Hermes) is selected via --agent flag or
// NEMOCLAW_AGENT env var. The OpenClaw path never touches this module.

import fs from "fs";
import os from "os";
import path from "path";

import { ROOT, run, shellQuote, redact } from "./runner";
import { dockerBuild, dockerImageInspect } from "./docker";
import { loadAgent, resolveAgentName, type AgentDefinition } from "./agent-defs";
import { getAgentBranding } from "./branding";
import { getProviderSelectionConfig } from "./inference-config";
import * as onboardSession from "./onboard-session";
import { sleepSeconds } from "./wait";
import type { JsonValue as LooseValue, JsonObject as LooseObject } from "./json-types";

export interface OnboardContext {
  step: (current: number, total: number, message: string) => void;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string | null;
  openshellShellCommand: (args: string[], options?: { openshellBinary?: string }) => string;
  openshellBinary: string;
  buildSandboxConfigSyncScript: (config: LooseObject) => string;
  writeSandboxConfigSyncFile: (script: string) => string;
  cleanupTempDir: (file: string, prefix: string) => void;
  startRecordedStep: (stepName: string, updates: LooseObject) => void;
  skippedStepMessage: (stepName: string, sandboxName: string) => void;
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
  return loadAgent(name);
}

/**
 * Stage build context for an agent-specific sandbox image.
 * Builds the base image if the agent defines one and it's not cached locally.
 */
export function createAgentSandbox(agent: AgentDefinition): {
  buildCtx: string;
  stagedDockerfile: string;
} {
  const agentDockerfile = agent.dockerfilePath;
  const baseDockerfile = agent.dockerfileBasePath;

  if (!agentDockerfile) {
    throw new Error(`${agent.displayName} is missing a sandbox Dockerfile`);
  }

  if (baseDockerfile) {
    const baseImageTag = `ghcr.io/nvidia/nemoclaw/${agent.name}-sandbox-base:latest`;
    const inspectResult = dockerImageInspect(baseImageTag, {
      ignoreError: true,
      suppressOutput: true,
    });
    if (inspectResult.status !== 0) {
      console.log(`  Building ${agent.displayName} base image (first time only)...`);
      dockerBuild(baseDockerfile, baseImageTag, ROOT, {
        stdio: ["ignore", "inherit", "inherit"],
      });
      console.log(`  \u2713 Base image built: ${baseImageTag}`);
    } else {
      console.log(`  Base image exists: ${baseImageTag}`);
    }
  }

  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
  fs.cpSync(ROOT, buildCtx, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return !["node_modules", ".git", ".venv", "__pycache__", ".claude"].includes(base);
    },
  });
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.copyFileSync(agentDockerfile, stagedDockerfile);
  console.log(`  Using ${agent.displayName} Dockerfile: ${agentDockerfile}`);

  return { buildCtx, stagedDockerfile };
}

/**
 * Get the agent-specific network policy path, or null to use the default.
 */
export function getAgentPolicyPath(agent: AgentDefinition): string | null {
  return agent.policyAdditionsPath || null;
}

/**
 * Get the agent-specific permissive policy path, or null to use the global fallback.
 */
export function getAgentPermissivePolicyPath(agent: AgentDefinition): string | null {
  return agent.policyPermissivePath || null;
}

function sleep(seconds: number): void {
  sleepSeconds(seconds);
}

function agentCliName(agent: AgentDefinition): string {
  return getAgentBranding(agent.name).cli;
}

function agentExecutableName(agent: AgentDefinition): string {
  const configuredPath = typeof agent.binary_path === "string" ? agent.binary_path.trim() : "";
  return path.basename(configuredPath || agent.name);
}

type AgentBinaryAvailability =
  | { available: true }
  | {
      available: false;
      reason: "not_found" | "not_executable" | "path_mismatch";
      binaryPath?: string;
      resolvedPath?: string;
    };

const AGENT_BINARY_CHECK_PREFIX = "NEMOCLAW_AGENT_BINARY_CHECK:";

// Exported for unit coverage of the sandbox-side guard without running onboarding.
export function verifyAgentBinaryAvailable(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: OnboardContext["runCaptureOpenshell"],
): AgentBinaryAvailability {
  const executable = agentExecutableName(agent);
  const binaryPath = typeof agent.binary_path === "string" ? agent.binary_path.trim() : "";
  const script = binaryPath
    ? [
        `if [ -x ${shellQuote(binaryPath)} ]; then echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}ok`)}; exit 0; fi`,
        `resolved="$(command -v ${shellQuote(executable)} 2>/dev/null || true)"`,
        `[ -n "$resolved" ] || { echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}not_found`)}; exit 0; }`,
        `[ -x "$resolved" ] || { printf '${AGENT_BINARY_CHECK_PREFIX}not_executable:%s\\n' "$resolved"; exit 0; }`,
        `printf '${AGENT_BINARY_CHECK_PREFIX}path_mismatch:%s\\n' "$resolved"`,
      ].join("; ")
    : [
        `resolved="$(command -v ${shellQuote(executable)} 2>/dev/null || true)"`,
        `[ -n "$resolved" ] && [ -x "$resolved" ] && echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}ok`)} || echo ${shellQuote(`${AGENT_BINARY_CHECK_PREFIX}not_found`)}`,
      ].join("; ");
  const result = runCaptureOpenshell(
    ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", script],
    {
      ignoreError: true,
    },
  );
  const status = result?.trim() ?? "";
  const marker = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(AGENT_BINARY_CHECK_PREFIX));
  const checkStatus = marker?.slice(AGENT_BINARY_CHECK_PREFIX.length) ?? "";
  if (checkStatus === "ok") {
    return { available: true };
  }
  if (binaryPath && checkStatus) {
    const mismatch = checkStatus.match(/^path_mismatch:(.+)$/);
    if (mismatch) {
      return {
        available: false,
        reason: "path_mismatch",
        binaryPath,
        resolvedPath: mismatch[1].trim(),
      };
    }
    if (checkStatus.startsWith("not_executable")) {
      return { available: false, reason: "not_executable", binaryPath };
    }
  }
  return { available: false, reason: "not_found", binaryPath: binaryPath || undefined };
}

function describeAgentBinaryFailure(
  sandboxName: string,
  agent: AgentDefinition,
  result: Exclude<AgentBinaryAvailability, { available: true }>,
): string {
  const executable = agentExecutableName(agent);
  if (result.reason === "path_mismatch") {
    return `${agent.displayName} binary '${executable}' resolves to '${result.resolvedPath}', expected '${result.binaryPath}' inside sandbox '${sandboxName}'`;
  }
  if (result.reason === "not_executable") {
    return `${agent.displayName} configured binary '${result.binaryPath}' is not executable inside sandbox '${sandboxName}'`;
  }
  return `${agent.displayName} binary '${executable}' is missing inside sandbox '${sandboxName}'`;
}

function failAgentSetup(sandboxName: string, agent: AgentDefinition, message: string): never {
  onboardSession.markStepFailed("agent_setup", message);
  console.error(`  \u2717 ${message}`);
  console.error(`    Check: ${agentCliName(agent)} ${sandboxName} logs --follow`);
  process.exit(1);
}

function isHealthProbeOk(result: string | null | undefined): boolean {
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
    openshellShellCommand,
    openshellBinary: openshellBin,
    buildSandboxConfigSyncScript,
    writeSandboxConfigSyncFile,
    cleanupTempDir,
    startRecordedStep,
    skippedStepMessage,
  } = ctx;

  if (resume && sandboxName) {
    const probe = agent.healthProbe;
    if (probe?.url) {
      const result = runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "curl", "-sf", "--max-time", "3", probe.url],
        { ignoreError: true },
      );
      if (isHealthProbeOk(result)) {
        skippedStepMessage("agent_setup", sandboxName);
        onboardSession.markStepComplete("agent_setup", { sandboxName, provider, model });
        return;
      }
    }
  }

  startRecordedStep("agent_setup", { sandboxName, provider, model });
  step(7, 8, `Setting up ${agent.displayName} inside sandbox`);

  const binaryAvailability = verifyAgentBinaryAvailable(sandboxName, agent, runCaptureOpenshell);
  if (!binaryAvailability.available) {
    failAgentSetup(
      sandboxName,
      agent,
      describeAgentBinaryFailure(sandboxName, agent, binaryAvailability),
    );
  }

  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      agent: agent.name,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    const scriptFile = writeSandboxConfigSyncFile(script);
    try {
      const scriptContent = fs.readFileSync(scriptFile, "utf-8");
      run([openshellBin, "sandbox", "connect", sandboxName], {
        stdio: ["pipe", "ignore", "inherit"],
        input: scriptContent,
      });
    } finally {
      cleanupTempDir(scriptFile, "nemoclaw-sync");
    }
  }

  const probe = agent.healthProbe;
  if (probe?.url) {
    const timeoutSecs = probe.timeout_seconds || 60;
    const pollInterval = 3;
    const maxAttempts = Math.ceil(timeoutSecs / pollInterval);
    console.log(`  Waiting for ${agent.displayName} gateway (up to ${timeoutSecs}s)...`);
    let healthy = false;
    for (let i = 0; i < maxAttempts; i++) {
      const result = runCaptureOpenshell(
        ["sandbox", "exec", "-n", sandboxName, "--", "curl", "-sf", "--max-time", "3", probe.url],
        { ignoreError: true },
      );
      if (isHealthProbeOk(result)) {
        healthy = true;
        break;
      }
      sleep(pollInterval);
    }
    if (healthy) {
      console.log(`  \u2713 ${agent.displayName} gateway is healthy`);
    } else {
      failAgentSetup(
        sandboxName,
        agent,
        `${agent.displayName} gateway did not respond within ${timeoutSecs}s`,
      );
    }
  } else {
    console.log(`  \u2713 ${agent.displayName} configured inside sandbox`);
  }

  onboardSession.markStepComplete("agent_setup", { sandboxName, provider, model });
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
  },
): void {
  const info = getAgentDashboardInfo(agent);
  const { kind, label, path } = agent.dashboard;
  const cliName = getAgentBranding(agent.name).cli;

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
    return;
  }

  if (token) {
    console.log(
      `  ${info.displayName} ${label} (auth token redacted from displayed URLs)`,
    );
    console.log(`  Port ${info.port} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(token, info.port)) {
      console.log(`  ${dashboardUrlForDisplay(url)}`);
    }
    console.log(`  Token: ${cliName} ${sandboxName} gateway-token --quiet`);
    console.log(`         append  #token=<token> locally if the browser asks for auth.`);
  } else {
    deps.note("  Could not read gateway token from the sandbox (download failed).");
    console.log(`  ${info.displayName} ${label}`);
    console.log(`  Port ${info.port} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(null, info.port)) {
      console.log(`  ${dashboardUrlForDisplay(url)}`);
    }
  }
}
