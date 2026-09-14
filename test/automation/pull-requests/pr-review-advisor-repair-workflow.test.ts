// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract";

type RepairWorkflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const workflow = readYaml<RepairWorkflow>(".github/workflows/pr-review-advisor-repair.yaml");

function serialized(job: WorkflowJob): string {
  return JSON.stringify(job);
}

function checkoutSteps(job: WorkflowJob): WorkflowStep[] {
  return (job.steps ?? []).filter((step) => step.uses?.startsWith("actions/checkout@"));
}

const checkoutCases = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
  checkoutSteps(job).map((checkout, index) => [jobName, index, checkout] as const),
);
const jobEnvironmentCases = Object.entries(workflow.jobs).map(
  ([jobName, job]) => [jobName, job.env] as const,
);

describe("manual PR Review Advisor repair workflow", () => {
  // source-shape-contract: security -- A manual-only entrypoint and denied ambient permissions prevent unreviewed automatic repair execution
  it("has one manual entrypoint and no ambient permissions (#10791)", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.select.if).toContain("refs/heads/main");
    expect(workflow.jobs.select.if).toContain("repository_egress_authorized");
    expect(workflow.jobs.publish.if).toContain("inputs.repair_publish");
    expect(workflow.jobs.publish.if).toContain("PR_REVIEW_ADVISOR_REPAIR_ENABLED");
  });

  // source-shape-contract: security -- Model credentials and protected branch-write authority must remain in separate jobs with a credential-free validator between them
  it("separates model access, candidate execution, and protected write authority (#10791)", () => {
    const claim = workflow.jobs.claim;
    const recover = workflow.jobs.recover;
    const resolve = workflow.jobs.resolve;
    const validate = workflow.jobs.validate;
    const publish = workflow.jobs.publish;

    expect(recover.permissions).toEqual({ contents: "read" });
    expect(serialized(recover)).not.toMatch(/secrets[.]|OPENAI_API_KEY/u);
    expect(claim.permissions).toEqual({ checks: "write", contents: "read" });
    expect(claim.needs).toContain("recover");
    expect(serialized(claim)).toContain("external_id");
    expect(serialized(claim)).toContain("conclusion=neutral");
    expect(serialized(claim)).not.toMatch(/secrets[.]|OPENAI_API_KEY/u);
    expect(resolve.needs).toContain("claim");
    expect(resolve.permissions).toEqual({ actions: "read", contents: "read" });
    expect(serialized(resolve)).toContain("secrets.PR_REVIEW_ADVISOR_API_KEY");
    expect(serialized(resolve)).not.toContain('"contents":"write"');

    expect(validate.permissions).toEqual({ actions: "read", contents: "read" });
    expect(serialized(validate)).not.toMatch(/secrets[.]|OPENAI_API_KEY/u);
    expect(serialized(validate)).toContain("repair-validate.mts");

    expect(publish.environment).toBe("advisor-repair-publish");
    expect(publish.permissions).toEqual({
      actions: "read",
      contents: "write",
      "pull-requests": "read",
    });
    expect(serialized(publish)).not.toMatch(/secrets[.]|OPENAI_API_KEY/u);
    expect(serialized(publish)).toContain("needs.validate.outputs.artifact-id");
    expect(serialized(publish)).toContain("repair-publish.mts");
  });

  it.each(checkoutCases)("keeps checkout %s/%i inert (#10791)", (_jobName, _index, checkout) => {
    expect(checkout.with).toEqual(
      expect.objectContaining({
        "persist-credentials": false,
        lfs: false,
        submodules: false,
      }),
    );
  });

  // source-shape-contract: security -- Every job that executes repair tooling must load it from the immutable workflow revision rather than the mutable PR head
  it.each(["select", "recover", "claim", "resolve", "validate", "publish"])(
    "loads %s executable code only from the immutable workflow revision (#10791)",
    (jobName) => {
      expect(serialized(workflow.jobs[jobName])).toContain("github.workflow_sha");
    },
  );

  // source-shape-contract: security -- Immutable artifact IDs prevent name-based substitution across the model, validator, and publisher trust promotions
  it("uses immutable artifact IDs across both trust promotions (#10791)", () => {
    const select = serialized(workflow.jobs.select);
    const resolve = serialized(workflow.jobs.resolve);
    const validate = serialized(workflow.jobs.validate);
    const publish = serialized(workflow.jobs.publish);

    expect(select).toContain("repair-select.mts");
    expect(select).toContain("artifact-ids");
    expect(select).toContain("steps.artifact-ids.outputs.artifact-ids");
    expect(resolve).toContain("needs.select.outputs.artifact-id");
    expect(validate).toContain("needs.resolve.outputs.artifact-id");
    expect(publish).toContain("needs.validate.outputs.artifact-id");
    expect([resolve, validate, publish].join("\n")).not.toContain("pattern:");
  });

  // source-shape-contract: security -- The one-shot claim must inspect every check-run page before allowing another model attempt
  it("paginates all existing attempt claims before creating a new claim (#10791)", () => {
    const claim = serialized(workflow.jobs.claim);

    expect(claim).toContain("gh api --paginate --slurp");
    expect(claim).toContain("repair-claim.mts");
  });

  // source-shape-contract: security -- A retry must reconcile every prior sandbox before the permanent model-attempt claim can reject repeated execution
  it("recovers earlier retry sandboxes before claiming model work (#10791)", () => {
    const recover = serialized(workflow.jobs.recover);
    const claim = workflow.jobs.claim;

    expect(recover).toContain('repair-resolve.mts\\" recover');
    expect(claim.needs).toContain("recover");
    expect(serialized(workflow.jobs.resolve)).not.toContain('repair-resolve.mts\\" recover');
  });

  // source-shape-contract: security -- A failed create can still allocate a sandbox, so cleanup must always attempt idempotent deletion
  it("always cleans up the repair sandbox after a create attempt (#10791)", () => {
    const cleanup = (workflow.jobs.resolve.steps ?? []).find((step) =>
      step.run?.includes('repair-resolve.mts" delete'),
    );

    expect(cleanup).toBeDefined();
    expect(cleanup?.if).toBe("${{ always() }}");
    expect(cleanup?.if).not.toContain("steps.create.outcome");
  });

  it.each(jobEnvironmentCases)(
    "uses contexts available while GitHub compiles the %s job environment (#10791)",
    (_jobName, env) => {
      expect(JSON.stringify(env ?? {})).not.toContain("runner.temp");
    },
  );

  // source-shape-contract: security -- Job-level repair paths must use a context GitHub permits while compiling the workflow
  it.each(["recover", "resolve", "validate", "publish"])(
    "uses isolated workspace paths for the %s job (#10791)",
    (jobName) => {
      expect(JSON.stringify(workflow.jobs[jobName].env)).toContain("github.workspace");
    },
  );
});
