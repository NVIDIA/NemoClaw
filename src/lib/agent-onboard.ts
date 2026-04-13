// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific onboarding logic — called from onboard.ts when a
// non-default agent (e.g. Hermes) is selected via --agent flag or
// NEMOCLAW_AGENT env var. The OpenClaw path never touches this module.

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

import { ROOT, run, shellQuote } from "./runner";
import { loadAgent, resolveAgentName, type AgentDefinition } from "./agent-defs";
import { getProviderSelectionConfig } from "./inference-config";
import * as onboardSession from "./onboard-session";

export interface OnboardContext {
  step: (current: number, total: number, message: string) => void;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string | null;
  openshellShellCommand: (args: string[]) => string;
  buildSandboxConfigSyncScript: (config: Record<string, unknown>) => string;
  writeSandboxConfigSyncFile: (script: string) => string;
  cleanupTempDir: (file: string, prefix: string) => void;
  startRecordedStep: (stepName: string, updates: Record<string, unknown>) => void;
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

  if (baseDockerfile) {
    const baseImageTag = `ghcr.io/nvidia/nemoclaw/${agent.name}-sandbox-base:latest`;
    const inspectResult = run(`docker image inspect ${shellQuote(baseImageTag)} >/dev/null 2>&1`, {
      ignoreError: true,
    });
    if (inspectResult.status !== 0) {
      console.log(`  Building ${agent.displayName} base image (first time only)...`);
      run(
        `docker build -f ${shellQuote(baseDockerfile)} -t ${shellQuote(baseImageTag)} ${shellQuote(ROOT)}`,
        { stdio: ["ignore", "inherit", "inherit"] },
      );
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
  fs.copyFileSync(agentDockerfile!, stagedDockerfile);
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
  spawnSync("sleep", [String(seconds)]);
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
  _session: unknown,
  ctx: OnboardContext,
): Promise<void> {
  const {
    step,
    runCaptureOpenshell,
    openshellShellCommand,
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
      run(
        `${openshellShellCommand(["sandbox", "connect", sandboxName])} < ${shellQuote(scriptFile)}`,
        { stdio: ["ignore", "ignore", "inherit"] },
      );
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
      console.log(
        `  \u26a0 ${agent.displayName} gateway did not respond within ${timeoutSecs}s.`,
      );
      console.log(
        `    The gateway may still be starting. Check: nemoclaw ${sandboxName} logs`,
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

/**
 * Print the dashboard UI section for a non-OpenClaw agent.
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
  if (token) {
    console.log(`  ${info.displayName} UI (tokenized URL; treat it like a password)`);
    console.log(`  Port ${info.port} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(token, info.port)) {
      console.log(`  ${url}`);
    }
  } else {
    deps.note("  Could not read gateway token from the sandbox (download failed).");
    console.log(`  ${info.displayName} UI`);
    console.log(`  Port ${info.port} must be forwarded before opening this URL.`);
    for (const url of deps.buildControlUiUrls(null, info.port)) {
      console.log(`  ${url}`);
    }
  }
}
