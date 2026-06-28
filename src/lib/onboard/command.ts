// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { formatAgentAliasSuffix, resolveAgentNameAlias } from "../agent/aliases";
import { applyAgentsManifestEnv } from "./agents-manifest";
import type { OnboardFlags } from "./command-support";
import { isOpenclawAgent } from "./openclaw-otel-policy-presets";
import { NOTICE_ACCEPT_ENV, NOTICE_ACCEPT_FLAG_NAME } from "./usage-notice";

export interface OnboardCommandOptions {
  nonInteractive: boolean;
  resume: boolean;
  fresh: boolean;
  recreateSandbox: boolean;
  fromDockerfile: string | null;
  sandboxName: string | null;
  sandboxGpu: "enable" | "disable" | null;
  sandboxGpuDevice: string | null;
  acceptThirdPartySoftware: boolean;
  agent: string | null;
  agentsManifest: string | null;
  controlUiPort: number | null;
  gpu: boolean;
  noGpu: boolean;
  autoYes: boolean;
  noOllamaAutostart: boolean;
}

export interface ResolveOnboardOptionsDeps {
  env: NodeJS.ProcessEnv;
  listAgents?: () => string[];
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export interface RunOnboardCommandDeps extends ResolveOnboardOptionsDeps {
  flags: OnboardFlags;
  runOnboard: (options: OnboardCommandOptions) => Promise<void>;
}

function fail(deps: ResolveOnboardOptionsDeps, message: string): never {
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  error(message);
  return exit(1);
}

function resolveFileOption(
  flag: "--from" | "--agents",
  value: string | undefined,
  deps: ResolveOnboardOptionsDeps,
  preserveInput: boolean,
): string | null {
  if (value === undefined) return null;
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) fail(deps, `  ${flag} path not found: ${resolved}`);
  if (!fs.statSync(resolved).isFile()) {
    const expected = flag === "--from" ? "a Dockerfile" : "a file";
    fail(deps, `  ${flag} must point to ${expected}: ${resolved}`);
  }
  return preserveInput ? value : resolved;
}

function resolveAgent(
  requestedAgent: string | undefined,
  deps: ResolveOnboardOptionsDeps,
): string | null {
  if (requestedAgent === undefined) return null;
  const knownAgents = deps.listAgents?.() ?? [];
  if (knownAgents.length === 0) return requestedAgent;
  const resolvedAgent = resolveAgentNameAlias(requestedAgent, knownAgents);
  if (resolvedAgent) return resolvedAgent;
  return fail(
    deps,
    `  Unknown agent '${requestedAgent}'. Available: ${knownAgents.join(", ")}${formatAgentAliasSuffix(knownAgents)}`,
  );
}

function resolveAgentsManifest(
  requestedManifest: string | undefined,
  agent: string | null,
  deps: ResolveOnboardOptionsDeps,
): string | null {
  if (requestedManifest === undefined) return null;
  if (!isOpenclawAgent(agent)) {
    fail(
      deps,
      `  --agents is OpenClaw-specific and cannot be used with --agent ${agent}; the declarative manifest only drives OpenClaw secondary agents.`,
    );
  }
  return resolveFileOption("--agents", requestedManifest, deps, false);
}

function resolveSandboxGpu(flags: OnboardFlags): "enable" | "disable" | null {
  if (flags["sandbox-gpu"]) return "enable";
  if (flags["no-sandbox-gpu"]) return "disable";
  return null;
}

export function resolveOnboardOptions(
  flags: OnboardFlags,
  deps: ResolveOnboardOptionsDeps,
): OnboardCommandOptions {
  const agent = resolveAgent(flags.agent, deps);
  return {
    nonInteractive: flags["non-interactive"] === true,
    resume: flags.resume === true,
    fresh: flags.fresh === true,
    recreateSandbox: flags["recreate-sandbox"] === true,
    fromDockerfile: resolveFileOption("--from", flags.from, deps, true),
    sandboxName: flags.name ?? null,
    sandboxGpu: resolveSandboxGpu(flags),
    sandboxGpuDevice: flags["sandbox-gpu-device"] ?? null,
    acceptThirdPartySoftware:
      flags[NOTICE_ACCEPT_FLAG_NAME] === true || String(deps.env[NOTICE_ACCEPT_ENV] || "") === "1",
    agent,
    agentsManifest: resolveAgentsManifest(flags.agents, agent, deps),
    controlUiPort: flags["control-ui-port"] ?? null,
    gpu: flags.gpu === true,
    noGpu: flags["no-gpu"] === true,
    autoYes: flags.yes === true,
    noOllamaAutostart: flags["no-ollama-autostart"] === true,
  };
}

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const options = resolveOnboardOptions(deps.flags, deps);
  if (options.noOllamaAutostart) process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART = "1";
  if (options.agentsManifest) applyAgentsManifestEnv(options.agentsManifest);
  await deps.runOnboard(options);
}
