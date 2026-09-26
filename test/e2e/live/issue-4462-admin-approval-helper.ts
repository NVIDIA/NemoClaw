// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ISSUE_4462_SCOPE_UPGRADE_PHASES = [
  "confirm configured runtime availability and clear the scope-upgrade sandbox",
  "install the OpenClaw sandbox",
  "prove the first agent request needs no admin approval",
  "trigger and approve an operator.admin request through connect",
  "record the approval contract",
] as const;

const ISSUE_4462_AGENT_GATEWAY_FAILURE_PATTERN =
  /EMBEDDED FALLBACK|\[agent\/embedded\]|gateway connect failed|scope upgrade pending approval|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded/i;

export function hasIssue4462AgentGatewayFailureOutput(stdout: string, stderr: string): boolean {
  return ISSUE_4462_AGENT_GATEWAY_FAILURE_PATTERN.test(`${stdout}\n${stderr}`);
}
