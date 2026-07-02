// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { loadAgent } from "../agent/defs";
import { getAgentPolicyPath } from "../agent/onboard";
import { ROOT } from "../state/paths";
import type { CustomPolicyEntry } from "../state/registry";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import { resolveDockerGpuSandboxCreatePlan } from "./docker-gpu-sandbox-create";
import { type InitialSandboxPolicy, prepareInitialSandboxCreatePolicy } from "./initial-policy";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

export function preflightAuthoritativeRebuildCreatePolicy(options: {
  agentName: string | null;
  activeMessagingChannels: string[];
  hermesToolGateways: string[];
  recordedPolicyPresets: string[];
  customPolicies: CustomPolicyEntry[];
  policyTier: string | null;
  sandboxGpuConfig: SandboxGpuConfig;
}): InitialSandboxPolicy {
  const agent = options.agentName ? loadAgent(options.agentName) : null;
  const defaultPolicyPath = path.join(
    ROOT,
    "nemoclaw-blueprint",
    "policies",
    "openclaw-sandbox.yaml",
  );
  const basePolicyPath = (agent && getAgentPolicyPath(agent)) || defaultPolicyPath;
  const { useDockerGpuPatch } = resolveDockerGpuSandboxCreatePlan(options.sandboxGpuConfig, {
    dockerDriverGateway: isLinuxDockerDriverGatewayEnabled(),
  });
  return prepareInitialSandboxCreatePolicy(basePolicyPath, options.activeMessagingChannels, {
    directGpu: options.sandboxGpuConfig.sandboxGpuEnabled,
    dockerGpuPatch: useDockerGpuPatch,
    additionalPresets: [...options.recordedPolicyPresets, ...options.hermesToolGateways],
    additionalPresetContents: options.customPolicies.map(({ name, content }) => ({
      name,
      content,
    })),
    agentName: agent?.name,
    policyTier: options.policyTier,
  });
}
