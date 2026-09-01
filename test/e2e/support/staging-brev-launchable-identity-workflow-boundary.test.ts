// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import {
  readWorkflow,
  type Workflow,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

const JOB = "staging-brev-launchable-identity";

function workflow(): Workflow {
  return structuredClone(readWorkflow()) as Workflow;
}

function step(value: Workflow, name: string, jobName = JOB): WorkflowStep {
  const found = value.jobs[jobName]!.steps!.find((entry) => entry.name === name);
  expect(found).toBeDefined();
  return found!;
}

const workflowMutations: Array<[string, (value: Workflow) => void, string]> = [
  [
    "an untrusted selector",
    (value) => {
      value.jobs[JOB]!.if = "${{ true }}";
    },
    `${JOB} must run only when trusted main explicitly selects it`,
  ],
  [
    "a self-hosted runner label",
    (value) => {
      value.jobs[JOB]!["runs-on"] = "self-hosted";
    },
    `${JOB} must run on GitHub-hosted ubuntu-latest so GitHub decommissions the VM after the job`,
  ],
  [
    "a PR candidate SHA",
    (value) => {
      value.jobs[JOB]!.env!.CANDIDATE_SHA = "${{ inputs.checkout_sha || github.sha }}";
    },
    `${JOB} must bind CANDIDATE_SHA to its reviewed value`,
  ],
  [
    "a job-level GCP credential",
    (value) => {
      value.jobs[JOB]!.env!.GOOGLE_APPLICATION_CREDENTIALS =
        "${{ secrets.GOOGLE_APPLICATION_CREDENTIALS }}";
    },
    `${JOB} job environment must match its reviewed identity-only contract`,
  ],
  [
    "checkout credentials",
    (value) => {
      step(value, "Checkout trusted Launchable identity lane").env = {
        BREV_API_KEY: "${{ secrets.BREV_API_KEY }}",
        GH_TOKEN: "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
      };
    },
    `${JOB} checkout step must not receive environment values`,
  ],
  [
    "an inference credential",
    (value) => {
      step(value, "Build, boot, and verify identity").env!.NVIDIA_INFERENCE_API_KEY =
        "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    },
    `${JOB} execution step must not receive NVIDIA_INFERENCE_API_KEY`,
  ],
  [
    "full E2E mode",
    (value) => {
      delete step(value, "Build, boot, and verify identity").env!
        .NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY;
    },
    `${JOB} must set NEMOCLAW_BREV_DEFER_CLEANUP, NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY, and WORK_DIR to their reviewed values`,
  ],
  [
    "inline workspace cleanup",
    (value) => {
      delete step(value, "Build, boot, and verify identity").env!.NEMOCLAW_BREV_DEFER_CLEANUP;
    },
    `${JOB} must set NEMOCLAW_BREV_DEFER_CLEANUP, NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY, and WORK_DIR to their reviewed values`,
  ],
  [
    "unreserved workspace cleanup",
    (value) => {
      const cleanup = step(value, "Verify identity workspace cleanup") as WorkflowStep & {
        "timeout-minutes"?: number;
      };
      cleanup["timeout-minutes"] = 1;
    },
    `${JOB} must reserve and verify exact-name workspace cleanup`,
  ],
  [
    "persistent Brev credentials",
    (value) => {
      step(value, "Remove Brev API credentials").if = "success()";
    },
    `${JOB} must always remove and verify removal of its Brev API credential file`,
  ],
  [
    "a Brev credential directory without explicit mode 0700",
    (value) => {
      const prepare = step(value, "Prepare the trusted identity lane");
      prepare.run = String(prepare.run).replace(
        'install -d -m 0700 "$HOME/.brev"',
        'install -d "$HOME/.brev"',
      );
    },
    `${JOB} preparation must retain install -d -m 0700 "$HOME/.brev"`,
  ],
  [
    "missing cleanup evidence",
    (value) => {
      const upload = step(value, "Upload Launchable identity evidence");
      upload.with!.path = String(upload.with!.path).replace(
        "${{ steps.workspace.outputs.work_dir }}/cleanup.json\n",
        "",
      );
    },
    `${JOB} upload-e2e-artifacts must preserve its explicit name/path contract`,
  ],
  [
    "an injected secret-bearing step",
    (value) => {
      value.jobs[JOB]!.steps!.splice(4, 0, {
        name: "Injected step",
        env: { NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}" },
        run: "true",
      });
    },
    `${JOB} steps must not receive NVIDIA_INFERENCE_API_KEY or GCP_/GOOGLE_ environment identifiers`,
  ],
  [
    "a HOME override that separates Brev from OpenSSH",
    (value) => {
      step(value, "Build, boot, and verify identity").env!.HOME =
        "${{ runner.temp }}/isolated-home";
    },
    `${JOB} steps must use the runner account home so Brev and OpenSSH share SSH configuration`,
  ],
];

describe("staging Brev Launchable identity workflow boundary", () => {
  it("keeps the explicit trusted-main identity job valid (#9925)", () => {
    expect(validateE2eWorkflow(workflow())).toEqual([]);
  });

  it.each(workflowMutations)("rejects %s (#9925)", (_case, mutate, expected) => {
    const value = workflow();
    mutate(value);

    expect(validateE2eWorkflow(value)).toContain(expected);
  });

  it("rejects identity-only mode for staging-brev-launchable (#9925)", () => {
    const value = workflow();
    const strictStep = step(
      value,
      "Build, deploy, verify, test, and clean up",
      "staging-brev-launchable",
    );
    strictStep.env = {
      ...strictStep.env,
      NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY: "1",
    };

    expect(validateE2eWorkflow(value)).toContain(
      "staging-brev-launchable must retain the full E2E contract",
    );
  });
});
