// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function resolveTestAgentBaselinePolicy(
  agent: string | null | undefined,
): { agent: string; policyPath: string; content: string } | null {
  const resolvedAgent = agent || "openclaw";
  return {
    agent: resolvedAgent,
    policyPath:
      resolvedAgent === "openclaw"
        ? "/repo/nemoclaw-blueprint/policies/openclaw-sandbox.yaml"
        : `/repo/agents/${resolvedAgent}/policy-additions.yaml`,
    content: "version: 1\nnetwork_policies: {}\n",
  };
}
