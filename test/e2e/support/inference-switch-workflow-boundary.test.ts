// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  readInferenceSwitchWorkflow,
  validateInferenceSwitchWorkflow,
  validateInferenceSwitchWorkflowBoundary,
} from "../../../tools/e2e/inference-switch-workflow-boundary.mts";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

describe("Hermes inference switch workflow boundary", () => {
  it("accepts the canonical Anthropic-compatible mode", () => {
    expect(validateInferenceSwitchWorkflowBoundary()).toEqual([]);
    expect(validateE2eWorkflowBoundary()).toEqual([]);
  });

  it("rejects removal or misconfiguration of the Anthropic-compatible mode", () => {
    const missingMode = readInferenceSwitchWorkflow();
    missingMode.jobs["hermes-inference-switch"].strategy?.matrix?.include?.pop();
    expect(validateInferenceSwitchWorkflow(missingMode)).toContain(
      "hermes-inference-switch must run the canonical Anthropic-compatible mode",
    );

    const failFast = readInferenceSwitchWorkflow();
    failFast.jobs["hermes-inference-switch"].strategy!["fail-fast"] = true;
    expect(validateInferenceSwitchWorkflow(failFast)).toContain(
      "hermes-inference-switch mode matrix must not fail fast",
    );
  });

  it("rejects a missing E2E shard mapping", () => {
    const workflow = readInferenceSwitchWorkflow();
    delete workflow.jobs["hermes-inference-switch"].env!.NEMOCLAW_E2E_SHARD;

    expect(validateInferenceSwitchWorkflow(workflow)).toContain(
      "hermes-inference-switch must map NEMOCLAW_E2E_SHARD from its mode matrix",
    );
  });

  it("pins the local Anthropic switch target without hosted credentials", () => {
    const wrongTarget = readInferenceSwitchWorkflow();
    const anthropic = wrongTarget.jobs["hermes-inference-switch"].strategy?.matrix?.include?.find(
      (entry) => entry.mode === "anthropic",
    );
    anthropic!.switch_model = "nvidia/nvidia/nemotron-3-super-v3";
    expect(validateInferenceSwitchWorkflow(wrongTarget)).toContain(
      "hermes-inference-switch must run the canonical Anthropic-compatible mode",
    );

    const publicKey = readInferenceSwitchWorkflow();
    publicKey.jobs["hermes-inference-switch"].env!.NVIDIA_API_KEY = "${{ secrets.NVIDIA_API_KEY }}";
    expect(validateInferenceSwitchWorkflow(publicKey)).toContain(
      "hermes-inference-switch must not expose NVIDIA_API_KEY at job scope",
    );
  });
});
