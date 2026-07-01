// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml } from "./helpers/e2e-workflow-contract";

type ReusableCallerJob = {
  env?: Record<string, unknown>;
  if?: string;
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  steps?: Array<{
    env?: Record<string, unknown>;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
  }>;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
};

type Workflow = {
  concurrency?: { group?: string };
  permissions?: Record<string, string>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
    };
    workflow_dispatch?: {
      inputs?: Record<string, unknown>;
    };
  };
  jobs?: Record<string, ReusableCallerJob>;
};

describe("Brev nightly workflow contract", () => {
  const nightly = readYaml<Workflow>(".github/workflows/brev-nightly-e2e.yaml");
  const branchValidation = readYaml<Workflow>(".github/workflows/e2e-branch-validation.yaml");

  it("passes only declared inputs and secrets to branch validation", () => {
    const declaredInputs = new Set(Object.keys(branchValidation.on?.workflow_call?.inputs ?? {}));
    const declaredSecrets = new Set(Object.keys(branchValidation.on?.workflow_call?.secrets ?? {}));
    const callerJobs = Object.entries(nightly.jobs ?? {}).filter(
      ([, job]) => job.uses === "./.github/workflows/e2e-branch-validation.yaml",
    );

    expect(callerJobs.length).toBeGreaterThan(0);
    for (const [jobName, job] of callerJobs) {
      const unknownInputs = Object.keys(job.with ?? {}).filter((name) => !declaredInputs.has(name));
      const unknownSecrets = Object.keys(job.secrets ?? {}).filter(
        (name) => !declaredSecrets.has(name),
      );

      expect(unknownInputs, `${jobName} passes unsupported reusable workflow inputs`).toEqual([]);
      expect(unknownSecrets, `${jobName} passes unsupported reusable workflow secrets`).toEqual([]);
    }
  });

  it("grants the reusable workflow permission ceiling so GitHub can start the run", () => {
    expect(nightly.permissions).toEqual(branchValidation.permissions);
    expect(nightly.permissions).toEqual({
      contents: "read",
      checks: "write",
      "pull-requests": "write",
    });
  });

  it("keeps write permissions out of the secret-bearing target-branch job", () => {
    const caller = nightly.jobs?.["brev-nightly-e2e"];
    const validation = branchValidation.jobs?.["e2e-branch-validation"];
    const reporter = branchValidation.jobs?.["report-pr"];
    const checkout = validation?.steps?.find((step) => step.name === "Checkout target branch");
    const resolveBranch = validation?.steps?.find(
      (step) => step.name === "Resolve branch from PR number",
    );
    const recordRevision = validation?.steps?.find(
      (step) => step.name === "Record exact tested revision",
    );

    expect(nightly.on?.workflow_dispatch?.inputs).not.toHaveProperty("branch");
    expect(caller?.with?.branch).toBe("${{ github.ref_name }}");
    expect(validation?.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(resolveBranch?.env?.PR_NUMBER).toBe("${{ inputs.pr_number }}");
    expect(resolveBranch?.run).not.toContain("gh pr view ${{");
    expect(validation?.outputs?.tested_sha).toBe("${{ steps.tested-ref.outputs.sha }}");
    expect(recordRevision?.run).toContain("git rev-parse HEAD");
    expect(validation?.env?.BREV_E2E_INSTANCE_NAME).toContain("inputs.test_suite");
    expect(reporter?.permissions).toEqual({
      contents: "read",
      checks: "write",
      "pull-requests": "write",
    });
    expect(reporter?.if).toContain("inputs.pr_number != ''");
    expect(reporter?.steps?.[0]?.env?.TESTED_SHA).toBe(
      "${{ needs.e2e-branch-validation.outputs.tested_sha }}",
    );
    expect(reporter?.steps?.[0]?.env?.INSTANCE_NAME).toContain("inputs.test_suite");
    expect(reporter?.steps?.[0]?.run).toContain(
      "PR head moved after Brev validation; refusing to report stale evidence",
    );
    expect(reporter?.steps?.some((step) => step.uses?.includes("checkout"))).toBe(false);
    expect(JSON.stringify(reporter)).not.toMatch(/BREV_|NVIDIA_INFERENCE_API_KEY/);
  });

  it("keeps every suite in the nightly matrix in a distinct concurrency group", () => {
    expect(branchValidation.concurrency?.group).toContain("inputs.test_suite");
  });

  it("does not expose stale published-launchable controls", () => {
    const dispatchInputs = Object.keys(nightly.on?.workflow_dispatch?.inputs ?? {});
    const callerInputs = Object.values(nightly.jobs ?? {}).flatMap((job) =>
      Object.keys(job.with ?? {}),
    );

    expect(dispatchInputs).not.toContain("launchable_id");
    expect(callerInputs).not.toContain("launchable_id");
    expect(callerInputs).not.toContain("use_published_launchable");
  });
});
