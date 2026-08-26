// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../../src/lib/agent/defs.ts";

function localDockerfilePath(env: NodeJS.ProcessEnv): string {
  const agent = loadAgent(env.NEMOCLAW_AGENT ?? "openclaw", env);
  const dockerfilePath = agent.dockerfilePath ?? agent.legacyPaths?.dockerfile;
  if (!dockerfilePath) {
    throw new Error(`Agent '${agent.name}' has no Dockerfile for local E2E workload source.`);
  }
  return dockerfilePath;
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
  const dockerfilePath = localDockerfilePath({ ...process.env, ...input });
  return {
    ...input,
    NEMOCLAW_FROM_DOCKERFILE: dockerfilePath,
  };
}
