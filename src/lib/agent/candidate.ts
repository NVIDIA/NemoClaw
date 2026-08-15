// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CandidateManagedImageAgent,
  isCandidateManagedImageAgent,
} from "../onboard/managed-image/contract";

export const CANDIDATE_AGENT_FEATURE_ENV = "NEMOCLAW_CANDIDATE_AGENTS" as const;
export const CANDIDATE_AGENT_QUALIFICATION_ENV = "NEMOCLAW_CANDIDATE_QUALIFICATION" as const;

export function isCandidateAgent(name: string): name is CandidateManagedImageAgent {
  return isCandidateManagedImageAgent(name);
}

export function isCandidateAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CANDIDATE_AGENT_FEATURE_ENV] === "1";
}

export function isCandidateQualificationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCandidateAgentEnabled(env) && env[CANDIDATE_AGENT_QUALIFICATION_ENV] === "1";
}

export function isCandidateAgentSelectable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isCandidateAgent(name) && isCandidateAgentEnabled(env);
}

export function candidateAgentUnavailableMessage(name: string): string {
  return `Agent '${name}' is a release candidate and is not selectable in this release`;
}

export function requireCandidateAgentSelectable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isCandidateAgent(name) && !isCandidateAgentEnabled(env)) {
    throw new Error(candidateAgentUnavailableMessage(name));
  }
}

export function requireCandidateQualificationEnabled(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  requireCandidateAgentSelectable(name, env);
  if (isCandidateAgent(name) && !isCandidateQualificationEnabled(env)) {
    throw new Error(
      `Agent '${name}' requires protected candidate qualification before it can start`,
    );
  }
}
