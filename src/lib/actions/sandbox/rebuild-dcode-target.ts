// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "../../core/ports";
import {
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
  type SandboxGatewayBinding,
} from "../../onboard/gateway-binding";

export const DCODE_AGENT_NAME = "langchain-deepagents-code";

export type DcodeRebuildRegistryEntry = SandboxGatewayBinding & {
  agent?: string | null;
  dashboardPort?: number | null;
};

export type DcodeRebuildResumeConfig = {
  provider: string | null;
  model: string | null;
  preferredInferenceApi: string | null;
};

export type ResolvedDcodeRebuildTarget = {
  agent: typeof DCODE_AGENT_NAME;
  gatewayName: string;
  gatewayPort: number;
  provider: string;
  model: string;
  preferredInferenceApi: string | null;
};

function requiredString(value: string | null | undefined, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`DCode rebuild target is missing its recorded ${label}.`);
  return normalized;
}

/**
 * Resolve the small, ephemeral target contract needed by #6195. It deliberately
 * does not add a persisted recipe or machine state. Cross-port rebuilds fail
 * closed because onboarding's gateway runtime is bound when the process loads.
 */
export function resolveDcodeRebuildTarget(
  entry: DcodeRebuildRegistryEntry,
  resumeConfig: DcodeRebuildResumeConfig,
  currentGatewayPort = GATEWAY_PORT,
): ResolvedDcodeRebuildTarget {
  if (entry.agent !== DCODE_AGENT_NAME) {
    throw new Error(`DCode rebuild target expected agent '${DCODE_AGENT_NAME}'.`);
  }
  const gatewayName = resolveSandboxGatewayName(entry);
  const gatewayPort = resolveGatewayPortFromName(gatewayName);
  if (gatewayPort === null) {
    throw new Error(`Cannot resolve the recorded gateway port for '${gatewayName}'.`);
  }
  if (gatewayPort !== currentGatewayPort) {
    throw new Error(
      `Sandbox uses gateway '${gatewayName}' on port ${gatewayPort}, but this process is bound to port ${currentGatewayPort}. ` +
        `Re-run with NEMOCLAW_GATEWAY_PORT=${gatewayPort}.`,
    );
  }
  return {
    agent: DCODE_AGENT_NAME,
    gatewayName,
    gatewayPort,
    provider: requiredString(resumeConfig.provider, "inference provider"),
    model: requiredString(resumeConfig.model, "inference model"),
    preferredInferenceApi: resumeConfig.preferredInferenceApi,
  };
}
