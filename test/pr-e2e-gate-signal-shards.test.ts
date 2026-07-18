// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildRiskPlan,
  PR_E2E_TYPED_TARGET_IDS,
  riskPlanRequiredJobIds,
} from "../tools/advisors/risk-plan.mts";
import { expectedSignalShards } from "../tools/e2e/pr-e2e-gate.mts";

const HEAD_SHA = "a".repeat(40);
const DCODE_TARGET = PR_E2E_TYPED_TARGET_IDS[0];
const BROAD_FILES = [
  "src/lib/onboard.ts",
  "src/lib/actions/upgrade-sandboxes.ts",
  "src/lib/actions/sandbox/agents/apply.ts",
  "src/lib/messaging/applier/agent-config.ts",
  "src/lib/inference/health.ts",
  "install.sh",
  "src/lib/credentials/provider-list.ts",
] as const;

describe("PR E2E signal shard policy", () => {
  it("derives shard policy from the checked-in workflow", () => {
    expect(expectedSignalShards(["onboard-repair", "onboard-resume"])).toEqual({
      "onboard-repair": ["default"],
      "onboard-resume": ["default"],
    });
    expect(expectedSignalShards(["docs-validation"])).toEqual({
      "docs-validation": ["default"],
    });
    expect(expectedSignalShards(["hermes-inference-switch", "openclaw-inference-switch"])).toEqual({
      "hermes-inference-switch": ["hosted", "anthropic"],
      "openclaw-inference-switch": ["hosted", "anthropic"],
    });
    expect(expectedSignalShards(["openshell-gateway-upgrade"], undefined, [DCODE_TARGET])).toEqual({
      "openshell-gateway-upgrade": [
        "v0-0-36-x86-64",
        "v0-0-55-x86-64",
        "v0-0-55-aarch64",
        "v0-0-74-x86-64",
      ],
      [DCODE_TARGET]: ["default"],
    });
    const broadPlan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: BROAD_FILES });
    const broadShards = expectedSignalShards(riskPlanRequiredJobIds(broadPlan));
    expect(Object.keys(broadShards)).toHaveLength(13);
    expect(Object.values(broadShards).flat()).toHaveLength(15);
    expect(() => expectedSignalShards(["not-a-workflow-job"])).toThrow(/does not define/u);
  });
});
