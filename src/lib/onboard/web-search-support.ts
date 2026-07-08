// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { WebSearchProvider } from "../inference/web-search";
import { ROOT } from "../state/paths";

export type WebSearchAgent =
  | {
      name?: string | null;
      displayName?: string | null;
      dockerfilePath?: string | null;
    }
  | null
  | undefined;

/**
 * Check whether the agent's Dockerfile declares ARG NEMOCLAW_WEB_SEARCH_ENABLED.
 * If the ARG is absent, the patchStagedDockerfile replace is a silent no-op and
 * the config generator has no code path to emit a web search block — so offering
 * the web-search prompt would mislead the user.
 *
 * OpenClaw uses the root Dockerfile (not agents/openclaw/Dockerfile), so we
 * fall back to the root Dockerfile when the agent-specific one doesn't exist.
 */
export function agentSupportsWebSearch(
  agent: WebSearchAgent,
  dockerfilePathOverride: string | null = null,
  rootDir = ROOT,
): boolean {
  const candidates = [
    dockerfilePathOverride,
    agent?.dockerfilePath,
    path.join(rootDir, "Dockerfile"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );

  for (const dockerfilePath of candidates) {
    try {
      const content = fs.readFileSync(dockerfilePath, "utf-8");
      return /^\s*ARG\s+NEMOCLAW_WEB_SEARCH_ENABLED=/m.test(content);
    } catch {
      // Try the next candidate; custom Dockerfile paths can disappear between resume runs.
    }
  }
  return false;
}

/**
 * Tavily needs the provider selector build arg in addition to the legacy
 * enable flag. Brave remains compatible with older custom Dockerfiles that
 * only declare NEMOCLAW_WEB_SEARCH_ENABLED because Brave is the historical
 * default when no provider arg exists.
 */
export function agentSupportsWebSearchProvider(
  agent: WebSearchAgent,
  provider: WebSearchProvider,
  dockerfilePathOverride: string | null = null,
  rootDir = ROOT,
): boolean {
  // Hermes currently exposes only its native Tavily backend. Brave remains
  // OpenClaw-only until Hermes ships a compatible Brave backend.
  if (agent?.name?.trim().toLowerCase() === "hermes" && provider !== "tavily") return false;

  const candidates = [
    dockerfilePathOverride,
    agent?.dockerfilePath,
    path.join(rootDir, "Dockerfile"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );

  for (const dockerfilePath of candidates) {
    try {
      const content = fs.readFileSync(dockerfilePath, "utf-8");
      const enabled = /^\s*ARG\s+NEMOCLAW_WEB_SEARCH_ENABLED=/m.test(content);
      if (!enabled) return false;
      return provider === "brave" || /^\s*ARG\s+NEMOCLAW_WEB_SEARCH_PROVIDER=/m.test(content);
    } catch {
      // Try the next candidate; custom Dockerfile paths can disappear between resume runs.
    }
  }
  return false;
}
