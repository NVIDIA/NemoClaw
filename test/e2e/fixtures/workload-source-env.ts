// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { REPO_ROOT } from "./paths.ts";

const LOCAL_DOCKERFILE_BY_AGENT = {
  openclaw: "Dockerfile",
  hermes: "agents/hermes/Dockerfile",
  "langchain-deepagents-code": "agents/langchain-deepagents-code/Dockerfile",
  pi: "agents/pi/Dockerfile",
} as const;

type LocalDockerfileAgent = keyof typeof LOCAL_DOCKERFILE_BY_AGENT;

function localDockerfileAgent(env: NodeJS.ProcessEnv): LocalDockerfileAgent {
  const agent = env.NEMOCLAW_AGENT ?? "openclaw";
  if (agent in LOCAL_DOCKERFILE_BY_AGENT) return agent as LocalDockerfileAgent;
  return "openclaw";
}

/**
 * Live E2E targets select the trusted managed image or a Dockerfile from the
 * candidate checkout through the E2E_WORKLOAD_SOURCE contract.
 *
 * This is applied at the final fixture spawn boundary so an agent selected by
 * a test command receives its own Dockerfile rather than an OpenClaw default.
 */
export function resolveLiveE2eWorkloadSourceEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const targetId = input.E2E_TARGET_ID ?? process.env.E2E_TARGET_ID;
  const source = input.E2E_WORKLOAD_SOURCE ?? process.env.E2E_WORKLOAD_SOURCE;
  if (!targetId || source !== "local-dockerfile") return input;
  if (input.NEMOCLAW_FROM_DOCKERFILE) return input;
  const agent = localDockerfileAgent({ ...process.env, ...input });
  return {
    ...input,
    NEMOCLAW_FROM_DOCKERFILE: path.join(REPO_ROOT, LOCAL_DOCKERFILE_BY_AGENT[agent]),
  };
}
