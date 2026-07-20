// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function resolveTestAgentBaselinePolicy(agent: string) {
  return {
    agent,
    policyPath:
      agent === "openclaw"
        ? "/repo/nemoclaw-blueprint/policies/openclaw-sandbox.yaml"
        : `/repo/agents/${agent}/policy-additions.yaml`,
    content: "version: 1\nnetwork_policies: {}\n",
  };
}
