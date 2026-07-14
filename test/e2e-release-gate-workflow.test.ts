// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

type E2eWorkflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, unknown>;
    };
  };
  jobs: Record<string, WorkflowJob>;
};

const e2eWorkflow = readYaml<E2eWorkflow>(".github/workflows/e2e.yaml");

describe("release gate workflow resource contracts", () => {
  // source-shape-contract: security -- Trusted checkout selection binds TUI evidence to the validated controller commit
  it("replaces legacy target_ref dispatches with the validated checkout contract", () => {
    const inputs = e2eWorkflow.on?.workflow_dispatch?.inputs;
    const tuiJob = e2eWorkflow.jobs["openclaw-tui-chat-correlation"];
    const checkout = tuiJob.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));

    expect(inputs).toHaveProperty("checkout_sha");
    expect(inputs).not.toHaveProperty("target_ref");
    expect(tuiJob.permissions).toEqual({ contents: "read" });
    expect(checkout?.with?.ref).toBe("${{ inputs.checkout_sha || github.sha }}");
    expect(tuiJob.env?.NEMOCLAW_TUI_EXPECTED_CHECKOUT_SHA).toBe(
      "${{ inputs.checkout_sha || github.sha }}",
    );
  });
});
