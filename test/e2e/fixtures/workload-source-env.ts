// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadAgent } from "../../../src/lib/agent/defs.ts";
import {
  CANDIDATE_AGENT_FEATURE_ENV,
  CANDIDATE_QUALIFICATION_RECEIPT_ENV,
} from "../../../src/lib/agent/candidate.ts";
import { CUA_FEATURE_ENV } from "../../../src/lib/cua/feature.ts";

function agentSelectionEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    [CANDIDATE_AGENT_FEATURE_ENV]:
      input[CANDIDATE_AGENT_FEATURE_ENV] ?? process.env[CANDIDATE_AGENT_FEATURE_ENV],
    [CANDIDATE_QUALIFICATION_RECEIPT_ENV]:
      input[CANDIDATE_QUALIFICATION_RECEIPT_ENV] ??
      process.env[CANDIDATE_QUALIFICATION_RECEIPT_ENV],
    [CUA_FEATURE_ENV]: input[CUA_FEATURE_ENV] ?? process.env[CUA_FEATURE_ENV],
  };
}

function localDockerfilePath(input: NodeJS.ProcessEnv): string {
  const agentName = input.NEMOCLAW_AGENT ?? process.env.NEMOCLAW_AGENT ?? "openclaw";
  const agent = loadAgent(agentName, agentSelectionEnv(input));
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
  const dockerfilePath = localDockerfilePath(input);
  return {
    ...input,
    NEMOCLAW_FROM_DOCKERFILE: dockerfilePath,
  };
}
