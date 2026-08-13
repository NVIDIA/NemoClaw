// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  TRUSTED_HERMES_SWAP_STEP_ID,
  validateTrustedHermesSwapHelperSource,
  validateTrustedHermesSwapWorkflow,
} from "../../../tools/e2e/trusted-hermes-swap-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type Step = { id?: string; run?: string };
type Job = { steps: Step[] };
type Workflow = { jobs: Record<string, Job> };

function workflow(): Workflow {
  return readWorkflow() as Workflow;
}

function swapStep(value: Workflow, job: string): Step {
  return value.jobs[job]!.steps.find((step) => step.id === TRUSTED_HERMES_SWAP_STEP_ID)!;
}

describe("trusted Hermes swap workflow boundary", () => {
  it("keeps the privileged program before checkout in retained Hermes jobs", () => {
    expect(validateTrustedHermesSwapWorkflow(workflow())).toEqual([]);
  });

  it("rejects a missing or changed retained-job provisioner", () => {
    const missing = workflow();
    missing.jobs["hermes-e2e"]!.steps = missing.jobs["hermes-e2e"]!.steps.filter(
      (step) => step.id !== TRUSTED_HERMES_SWAP_STEP_ID,
    );
    expect(validateTrustedHermesSwapWorkflow(missing)).toContain(
      "hermes-e2e job must contain exactly one trusted Hermes swap step",
    );

    const changed = workflow();
    swapStep(changed, "mcp-bridge").run = "sudo swapon /tmp/candidate.swap";
    expect(validateTrustedHermesSwapWorkflow(changed)).toContain(
      "mcp-bridge trusted Hermes swap step must preserve the fixed privileged program",
    );
  });

  it("rejects privileged swap code in candidate helpers or unreviewed jobs", () => {
    expect(validateTrustedHermesSwapHelperSource("/usr/bin/sudo swapon candidate.swap")).toContain(
      "candidate live Vitest helper must not contain privileged swap fragment /usr/bin/sudo",
    );

    const value = workflow();
    value.jobs["token-rotation"]!.steps.unshift({ ...swapStep(value, "hermes-e2e") });
    expect(validateTrustedHermesSwapWorkflow(value)).toContain(
      "token-rotation job must not provision trusted Hermes swap",
    );
  });
});
