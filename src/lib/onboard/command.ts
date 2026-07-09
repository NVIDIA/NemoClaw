// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { formatAgentAliasSuffix, resolveAgentNameAlias } from "../agent/aliases";
import {
  resolveToolDisclosureRequest,
  TOOL_DISCLOSURE_ENV,
  type ToolDisclosure,
} from "../tool-disclosure";
import { applyAgentsManifestEnv } from "./agents-manifest";
import type { OnboardFlags } from "./command-support";
import { managedSandboxFeatureIssue } from "./managed-sandbox-feature";
import { DCODE_OBSERVABILITY_FEATURE } from "./observability-policy-presets";
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
  toolDisclosure: ToolDisclosure | null;
  observabilityEnabled: boolean | null;
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

// Validate the effective agent from the --agent flag, else the NEMOCLAW_AGENT
// env var. Both feed the same downstream resolver, so validating the env var
// here makes an unknown value fail with the clean flag-style message instead of
// throwing uncaught deep inside runOnboard (a raw Node `throw new Error(...)`
// source frame on stderr) (#5972). For a valid env value we return null and let
// downstream resolution canonicalize it, leaving existing behavior unchanged.
function failUnknownAgent(
  deps: ResolveOnboardOptionsDeps,
  value: string,
  fromEnv: boolean,
  knownAgents: readonly string[],
): never {
  const source = fromEnv ? " (from NEMOCLAW_AGENT)" : "";
  return fail(
    deps,
    `  Unknown agent '${value}'${source}. Available: ${knownAgents.join(", ")}${formatAgentAliasSuffix(knownAgents)}`,
  );
}

function resolveAgent(
  requestedAgent: string | undefined,
  deps: ResolveOnboardOptionsDeps,
): string | null {
  const fromEnv = requestedAgent === undefined;
  const candidate = ((fromEnv ? deps.env.NEMOCLAW_AGENT : requestedAgent) ?? "").trim();
  if (candidate === "") return null;

  const knownAgents = deps.listAgents?.() ?? [];
  const resolved =
    knownAgents.length === 0 ? candidate : resolveAgentNameAlias(candidate, knownAgents);
  if (!resolved) failUnknownAgent(deps, candidate, fromEnv, knownAgents);

  // The env path leaves canonicalization to downstream resolution (returns
  // null); the flag path returns the canonical name as before.
  return fromEnv ? null : resolved;
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

function validateObservabilityAgent(
  requested: boolean | undefined,
  agent: string | null,
  deps: ResolveOnboardOptionsDeps,
): void {
  if (
    agent &&
    managedSandboxFeatureIssue(DCODE_OBSERVABILITY_FEATURE, { agent, requested }) ===
      "unsupported-request"
  ) {
    fail(deps, "  --observability is supported only with --agent langchain-deepagents-code.");
  }
}

export function resolveOnboardOptions(
  flags: OnboardFlags,
  deps: ResolveOnboardOptionsDeps,
): OnboardCommandOptions {
  const agent = resolveAgent(flags.agent, deps);
  validateObservabilityAgent(flags.observability, agent, deps);
  let toolDisclosure: ToolDisclosure | null;
  try {
    toolDisclosure = resolveToolDisclosureRequest(flags["tool-disclosure"], deps.env);
  } catch (error) {
    fail(deps, `  ${error instanceof Error ? error.message : String(error)}`);
  }
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
    toolDisclosure,
    observabilityEnabled: typeof flags.observability === "boolean" ? flags.observability : null,
    controlUiPort: flags["control-ui-port"] ?? null,
    gpu: flags.gpu === true,
    noGpu: flags["no-gpu"] === true,
    autoYes: flags.yes === true,
    noOllamaAutostart: flags["no-ollama-autostart"] === true,
  };
}

// A prompt closed before the user answered (stdin EOF, e.g.
// `nemoclaw onboard ... < /dev/null`). `prompt()` rejects these with code
// "EOF" so callers can treat them as a deliberate cancellation rather than a
// crash. See src/lib/credentials/store.ts.
function isPromptCancellation(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EOF";
}

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const options = resolveOnboardOptions(deps.flags, deps);
  if (options.noOllamaAutostart) process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART = "1";
  // Keep direct callers and the legacy monolithic onboard path on the same
  // canonical source. No value is written for the default so resume/rebuild
  // can distinguish an explicit request from an unset environment.
  if (options.toolDisclosure) process.env[TOOL_DISCLOSURE_ENV] = options.toolDisclosure;
  if (options.agentsManifest) applyAgentsManifestEnv(options.agentsManifest);
  try {
    await deps.runOnboard(options);
  } catch (error) {
    // Stdin EOF at any onboarding prompt is a cancellation, not a failure:
    // print a clear message and exit non-zero instead of either crashing with
    // a stack trace or — as in the original bug — exiting 0 silently (#5976).
    if (!isPromptCancellation(error)) throw error;
    fail(deps, "  Installation cancelled");
  }
}
