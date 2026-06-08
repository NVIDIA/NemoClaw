// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { RunContext, RunPlan } from "../types.ts";

// Spec ownership: emitting the normalized context.env that downstream
// shell helpers consume is FRAMEWORK INFRASTRUCTURE, not a phase action.
// Doing it as a shell action coupled the typed runner back to the old
// resolver's plan.json shape; doing it here keeps the typed RunPlan as
// the single source of truth.
//
// We seed context.env with values derivable from the typed RunPlan
// (scenario id, install method, agent/provider/route, default sandbox
// name and gateway URL). Onboarding helpers may overwrite these via
// e2e_context_set (e.g. assigning a real sandbox name, real gateway
// URL after the gateway boots).

function platformOsFromManifest(plan: RunPlan): string {
  const explicit = plan.manifest?.spec.setup.platform.os;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  // Fall back to the scenario environment platform id ("ubuntu-local",
  // "macos-local", "wsl-local", "gpu-runner", "brev-launchable").
  const platform = plan.environment?.platform ?? "";
  if (platform.startsWith("macos")) return "macos";
  if (platform.startsWith("wsl")) return "wsl";
  if (platform.startsWith("brev")) return "ubuntu";
  if (platform.startsWith("gpu")) return "ubuntu";
  return "ubuntu";
}

function executionTargetFromManifest(plan: RunPlan): string {
  const explicit = plan.manifest?.spec.setup.platform.executionTarget;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  return plan.environment?.platform === "brev-launchable" ? "remote" : "local";
}

function containerEngine(plan: RunPlan): string {
  const explicit = plan.manifest?.spec.setup.runtime.containerEngine;
  return typeof explicit === "string" && explicit.length > 0 ? explicit : "docker";
}

function containerDaemon(plan: RunPlan): string {
  const explicit = plan.manifest?.spec.setup.runtime.containerDaemon;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  return plan.environment?.runtime === "docker-missing" ? "missing" : "running";
}

function defaultGatewayUrl(agent: string): string {
  // Mirrors the historical defaults from emit-context-from-plan.sh so
  // existing shell helpers see the same seed values they used to.
  return agent === "hermes" ? "http://127.0.0.1:8642" : "http://127.0.0.1:18789";
}

function escapeContextValue(value: string): string {
  // The context library accepts plain `KEY=value` lines without quoting.
  // Reject newlines (would corrupt the file) and otherwise pass through.
  if (value.includes("\n")) {
    throw new Error(`context.env value for must not contain newline: ${JSON.stringify(value)}`);
  }
  return value;
}

export interface ContextSeedResult {
  path: string;
  keys: string[];
}

export function seedContextEnv(ctx: RunContext, plan: RunPlan): ContextSeedResult {
  const onboarding = plan.manifest?.spec.onboarding;
  const agent = onboarding?.agent ?? "openclaw";
  const provider = onboarding?.provider ?? "nvidia";
  const inferenceRoute = onboarding?.modelRoute ?? "inference-local";
  const onboardingPath = plan.environment?.onboarding ?? "unknown";
  const installMethod = plan.environment?.install ?? "unknown";

  const entries: Record<string, string> = {
    E2E_SCENARIO: plan.scenarioId,
    E2E_PLATFORM_OS: platformOsFromManifest(plan),
    E2E_EXECUTION_TARGET: executionTargetFromManifest(plan),
    E2E_INSTALL_METHOD: installMethod,
    E2E_CONTAINER_ENGINE: containerEngine(plan),
    E2E_CONTAINER_DAEMON: containerDaemon(plan),
    E2E_ONBOARDING_PATH: onboardingPath,
    E2E_AGENT: agent,
    E2E_PROVIDER: provider,
    E2E_INFERENCE_ROUTE: inferenceRoute,
    E2E_SANDBOX_NAME: `e2e-${plan.scenarioId}`,
    E2E_GATEWAY_URL: defaultGatewayUrl(agent),
  };

  // Path matches the shell helper's e2e_context_init: ${E2E_CONTEXT_DIR}/context.env
  const contextPath = path.join(ctx.contextDir, "context.env");
  fs.mkdirSync(ctx.contextDir, { recursive: true });
  const lines = Object.entries(entries)
    .map(([key, value]) => `${key}=${escapeContextValue(value)}`)
    .join("\n");
  fs.writeFileSync(contextPath, `${lines}\n`);

  return { path: contextPath, keys: Object.keys(entries) };
}
