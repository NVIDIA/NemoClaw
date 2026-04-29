// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific onboarding logic — called from onboard.ts when a
// non-default agent (e.g. Hermes) is selected via --agent flag or
// NEMOCLAW_AGENT env var. The OpenClaw path never touches this module.

import fs from "fs";
import os from "os";
import path from "path";

import { ROOT, run } from "./runner";
import { dockerBuild, dockerImageInspect } from "./docker";
import { loadAgent, resolveAgentName, type AgentDefinition } from "./agent-defs";
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
        ["sandbox", "exec", sandboxName, "curl", "-sf", "--max-time", "3", probe.url],
        { ignoreError: true },
      );
      if (result && result.includes("ok")) {
        skippedStepMessage("agent_setup", sandboxName);
        onboardSession.markStepComplete("agent_setup", { sandboxName, provider, model });
        return;
      }
    }
  }

  startRecordedStep("agent_setup", { sandboxName, provider, model });
  step(7, 8, `Setting up ${agent.displayName} inside sandbox`);

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
        ["sandbox", "exec", sandboxName, "curl", "-sf", "--max-time", "3", probe.url],
        { ignoreError: true },
      );
      if (result && result.includes("ok")) {
        healthy = true;
        break;
      }
      sleep(pollInterval);
    }
    if (healthy) {
      console.log(`  \u2713 ${agent.displayName} gateway is healthy`);
    } else {
      console.log(`  \u26a0 ${agent.displayName} gateway did not respond within ${timeoutSecs}s.`);
      console.log(`    The gateway may still be starting. Check: nemoclaw ${sandboxName} logs`);
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

/**
 * Print the dashboard UI section for a non-OpenClaw agent.
 *
 * When the agent manifest declares `dashboard.kind: api`, we print the
 * endpoint as an API (no tokenized URL fragment — the caller authenticates
 * via a header) and use the manifest-supplied label/path. Otherwise we fall
 * back to the original UI-style output used by browser dashboards.
 */
export function printDashboardUi(
  _sandboxName: string,
  token: string | null,
  agent: AgentDefinition,
  deps: {
    note: (msg: string) => void;
    buildControlUiUrls: (token: string | null, port: number) => string[];
  },
): void {
  const info = getAgentDashboardInfo(agent);
  const { kind, label, path } = agent.dashboard;

  if (kind === "api") {
    console.log(`  ${info.displayName} ${label}`);
    console.log(`  Port ${info.port} must be forwarded before connecting.`);
    const seen = new Set<string>();
    for (const baseUrl of deps.buildControlUiUrls(null, info.port)) {
      const withoutHash = baseUrl.split("#")[0].replace(/\/$/, "");
      const url = path && path !== "/" ? `${withoutHash}${path}` : `${withoutHash}/`;
      if (seen.has(url)) continue;
      seen.add(url);
      console.log(`  ${url}`);
    }
    return;
  }

  if (token) {
    console.log(
      `  ${info.displayName} ${label} (tokenized URL; treat it like a password; save it now - it will not be printed again)`,
    );
    console.log(`  Port ${info.port} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(token, info.port)) {
      console.log(`  ${url}`);
    }
  } else {
    deps.note("  Could not read gateway token from the sandbox (download failed).");
    console.log(`  ${info.displayName} ${label}`);
    console.log(`  Port ${info.port} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(null, info.port)) {
      console.log(`  ${url}`);
    }
  }
}
