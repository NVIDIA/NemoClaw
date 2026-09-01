// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { basePolicyHandlerOptions, createPolicyHandlerDeps } from "./policies-test-fixture";
import { handlePoliciesState } from "./policies";

describe("policy observability requirements", () => {
  it("threads durable observability intent into live policy reconciliation", async () => {
    const prepare = vi.fn(() => ({
      policyPresets: ["observability-otlp-local"],
      livePolicyPresetsNeedUpdate: true,
      disabledMessagingPolicyPresetApplied: false,
      suppressedAgentRequiredPresetsLive: false,
    }));
    const { deps, setSession, calls } = createPolicyHandlerDeps({
      preparePolicyPresetResumeSelection: prepare,
    });
    const session = calls.load();
    setSession({ ...session, observabilityEnabled: true });

    await handlePoliciesState({ ...basePolicyHandlerOptions(deps), resume: true });

    expect(prepare).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ observabilityEnabled: true }),
    );
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: ["observability-otlp-local"] }),
    );
  });
});
