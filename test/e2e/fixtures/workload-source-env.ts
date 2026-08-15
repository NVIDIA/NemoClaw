// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { REPO_ROOT } from "./paths.ts";

const LEGACY_DOCKERFILE_BY_AGENT = {
  openclaw: "Dockerfile",
  hermes: "agents/hermes/Dockerfile",
  "langchain-deepagents-code": "agents/langchain-deepagents-code/Dockerfile",
} as const;

type LegacyDockerfileAgent = keyof typeof LEGACY_DOCKERFILE_BY_AGENT;

function legacyDockerfileAgent(env: NodeJS.ProcessEnv): LegacyDockerfileAgent {
  const agent = env.NEMOCLAW_AGENT ?? "openclaw";
  if (agent in LEGACY_DOCKERFILE_BY_AGENT) return agent as LegacyDockerfileAgent;
  return "openclaw";
}

/**
 * Existing live E2E targets retain the product's default legacy-Dockerfile
 * path. Targets that must select a source explicitly do so through the
 * provider-neutral E2E_WORKLOAD_SOURCE contract.
 *
 * This is applied at the final fixture spawn boundary so an agent selected by
 * a test command receives its own Dockerfile rather than an OpenClaw default.
 */
export function resolveLiveE2eWorkloadSourceEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const targetId = input.E2E_TARGET_ID;
  const source = input.E2E_WORKLOAD_SOURCE;
  if (!targetId || source !== "legacy-dockerfile") return input;
  if (input.NEMOCLAW_FROM_DOCKERFILE) return input;
  const agent = legacyDockerfileAgent(input);
  return {
    ...input,
    NEMOCLAW_FROM_DOCKERFILE: path.join(REPO_ROOT, LEGACY_DOCKERFILE_BY_AGENT[agent]),
  };
}
