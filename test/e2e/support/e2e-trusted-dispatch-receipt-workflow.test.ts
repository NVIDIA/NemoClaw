// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

describe("manual PR dispatch receipt", () => {
  it("rejects receipts with missing fields, changed schema, or mutable uploads", () => {
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          steps: Array<{
            env?: Record<string, string>;
            if?: string;
            name?: string;
            run?: string;
            uses?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    const steps = workflow.jobs["generate-matrix"]!.steps;
    const receipt = steps.find((step) => step.name === "Record trusted E2E dispatch receipt")!;
    delete receipt.env!.BASE_SHA;
    receipt.run = receipt
      .run!.replace('kind: "nemoclaw-e2e-dispatch-v2"', 'kind: "nemoclaw-e2e-dispatch-v1"')
      .replace("baseSha: $baseSha,\n", "");
    const upload = steps.find((step) => step.name === "Upload trusted E2E dispatch receipt")!;
    upload.uses = "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@main";
    upload.with!.name = "mutable-e2e-dispatch";

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "trusted E2E dispatch receipt must bind only the authenticated repository, PR, candidate, workflow, run, and dispatch identities",
        `step 'Record trusted E2E dispatch receipt' run script must include kind: "nemoclaw-e2e-dispatch-v2"`,
        `step 'Record trusted E2E dispatch receipt' run script must include baseSha: $baseSha`,
        "trusted E2E dispatch receipt upload must use the reviewed pinned action",
        "trusted E2E dispatch receipt upload must preserve its immutable run identity",
      ]),
    );
  });

  it("records and uploads the receipt after authentication and before checkout", () => {
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          steps: Array<{ name?: string; uses?: string }>;
        }
      >;
    };
    const steps = workflow.jobs["generate-matrix"]!.steps;
    const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    const authenticationIndex = steps.findIndex(
      (step) => step.name === "Authenticate manual PR dispatch",
    );
    const [checkout] = steps.splice(checkoutIndex, 1);
    steps.splice(authenticationIndex, 0, checkout!);

    expect(validateE2eWorkflow(workflow)).toContain(
      "trusted E2E dispatch receipt must be created and uploaded immediately after authentication and before candidate execution",
    );
  });
});
