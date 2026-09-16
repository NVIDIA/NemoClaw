// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract";

type RepairWorkflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: WorkflowJob["concurrency"];
  jobs: Record<string, WorkflowJob>;
};

const workflow = readYaml<RepairWorkflow>(".github/workflows/pr-review-advisor-repair.yaml");

function serialized(job: WorkflowJob): string {
  return JSON.stringify(job);
}

function checkoutSteps(job: WorkflowJob): WorkflowStep[] {
  return (job.steps ?? []).filter((step) => step.uses?.startsWith("actions/checkout@"));
}

function repairToolSteps(job: WorkflowJob): WorkflowStep[] {
  return (job.steps ?? []).filter(
    (step) => step.run?.includes("/tools/pr-review-advisor/repair-") && step.run.includes(".mts"),
  );
}

const checkoutCases = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
  checkoutSteps(job).map((checkout, index) => [jobName, index, checkout] as const),
);
const jobEnvironmentCases = Object.entries(workflow.jobs).map(
  ([jobName, job]) => [jobName, job.env] as const,
);
const trustedExecutionJobs = ["select", "claim", "resolve", "validate"];
const trustedToolCases = trustedExecutionJobs.flatMap((jobName) =>
  repairToolSteps(workflow.jobs[jobName]).map((step, index) => [jobName, index, step] as const),
);

describe("manual PR Review Advisor repair workflow", () => {
  // source-shape-contract: security -- A manual-only entrypoint and denied ambient permissions prevent unreviewed automatic repair execution
  it("has one manual entrypoint and no ambient permissions (#10791)", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.select.if).toContain("refs/heads/main");
    expect(workflow.jobs.select.if).toContain("repository_egress_authorized");
    expect(workflow.jobs).not.toHaveProperty("publish");
    expect(serialized(workflow.jobs.audit)).toContain(
      "Publish: unavailable pending trusted-main exact-head validation",
    );
    expect(JSON.stringify(workflow)).not.toContain('"contents":"write"');
  });

  // source-shape-contract: security -- Model credentials must remain separate from credential-free candidate validation, while branch-write authority stays unavailable
  it("separates model access from credential-free candidate validation (#10791)", () => {
    const claim = workflow.jobs.claim;
    const resolve = workflow.jobs.resolve;
    const reviewedDependency = workflow.jobs["reviewed-dependency"];
    const validate = workflow.jobs.validate;

    expect(claim.permissions).toEqual({ checks: "write", contents: "read" });
    expect(claim.needs).toBe("select");
    expect(workflow.concurrency).toBeUndefined();
    expect(claim.concurrency).toEqual({
      group: "advisor-repair-claim-${{ inputs.pr_number }}",
      "cancel-in-progress": false,
    });
    expect(serialized(claim)).toContain("external_id");
    expect(serialized(claim)).toContain("conclusion=neutral");
    expect(serialized(claim)).not.toMatch(/secrets[.]|OPENAI_API_KEY/u);
    expect(resolve.needs).toContain("claim");
    expect(resolve.permissions).toEqual({ actions: "read", contents: "read" });
    expect(serialized(resolve)).toContain("secrets.PR_REVIEW_ADVISOR_API_KEY");
    expect(serialized(resolve)).not.toContain('"contents":"write"');

    expect(reviewedDependency.permissions).toEqual({ contents: "read", packages: "read" });
    expect(serialized(reviewedDependency)).toContain("package-openshell-sdk-for-pr.mts");
    expect(serialized(reviewedDependency)).toContain("NODE_AUTH_TOKEN");
    expect(serialized(reviewedDependency)).toContain("github.token");
    expect(serialized(reviewedDependency)).not.toMatch(/PR_REVIEW_ADVISOR_API_KEY|OPENAI_API_KEY/u);
    expect(workflow.jobs.select.needs).toContain("reviewed-dependency");
    expect(resolve.needs).toContain("reviewed-dependency");
    expect(validate.needs).toContain("reviewed-dependency");
    expect(workflow.jobs.select.permissions).not.toHaveProperty("packages");
    expect(resolve.permissions).not.toHaveProperty("packages");
    expect(validate.permissions).not.toHaveProperty("packages");
    const dependencyConsumers = [workflow.jobs.select, resolve, validate]
      .map(serialized)
      .join("\n");
    expect(
      dependencyConsumers.match(/needs[.]reviewed-dependency[.]outputs[.]artifact-id/gu),
    ).toHaveLength(3);
    expect(dependencyConsumers.match(/ci-install-dependencies[.]sh none/gu)).toHaveLength(3);
    expect(dependencyConsumers).not.toMatch(/NODE_AUTH_TOKEN[^}]*github[.]token/u);
    expect(validate.permissions).toEqual({ actions: "read", contents: "read" });
    expect(serialized(validate)).not.toMatch(
      /secrets[.]|OPENAI_API_KEY|NODE_AUTH_TOKEN[^}]*github[.]token/u,
    );
    expect(serialized(validate)).toContain("needs.reviewed-dependency.outputs.artifact-id");
    expect(serialized(validate)).toContain("repair-validate.mts");
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
  it.each(trustedExecutionJobs)(
    "loads %s executable code only from the immutable workflow revision (#10791)",
    (jobName) => {
      const job = workflow.jobs[jobName];
      const trustedCheckouts = checkoutSteps(job).filter((step) => step.with?.path === "trusted");

      expect(trustedCheckouts).toHaveLength(1);
      expect(trustedCheckouts[0]?.with?.ref).toBe("${{ github.workflow_sha }}");
      expect(repairToolSteps(job).length).toBeGreaterThan(0);
    },
  );

  it.each(trustedToolCases)(
    "executes trusted repair tool %s/%i from the immutable checkout (#10791)",
    (_jobName, _index, step) => {
      expect(step.run).toMatch(
        /"(?:\$TRUSTED_CHECKOUT|\$\{GITHUB_WORKSPACE\}\/trusted)\/tools\/pr-review-advisor\/repair-[a-z-]+[.]mts"/u,
      );
    },
  );

  // source-shape-contract: security -- Immutable artifact IDs prevent name-based substitution across the model and validator trust promotion
  it("uses immutable artifact IDs across candidate validation (#10791)", () => {
    const select = serialized(workflow.jobs.select);
    const resolve = serialized(workflow.jobs.resolve);
    const validate = serialized(workflow.jobs.validate);

    expect(select).toContain("repair-select.mts");
    expect(select).toContain("artifact-ids");
    expect(select).toContain("steps.artifact-ids.outputs.artifact-ids");
    expect(resolve).toContain("needs.select.outputs.artifact-id");
    expect(validate).toContain("needs.resolve.outputs.artifact-id");
    expect([resolve, validate].join("\n")).not.toContain('"pattern":');
  });

  // source-shape-contract: security -- The one-shot claim must inspect every check-run page before allowing another model attempt
  it("paginates all existing attempt claims before creating a new claim (#10791)", () => {
    const claim = serialized(workflow.jobs.claim);

    expect(claim).toContain("gh api --paginate --slurp");
    expect(claim).toContain("repair-claim.mts");
  });

  // source-shape-contract: security -- Runner-local OpenShell state must never be presented as recoverable by a later ephemeral runner
  it("owns each repair sandbox within one workflow run attempt (#10791)", () => {
    const resolveJob = workflow.jobs.resolve;
    const claim = workflow.jobs.claim;

    expect(resolveJob.env?.SANDBOX_NAME).toBe(
      "advisor-repair-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow.jobs.validate.env?.SANDBOX_NAME).toBe(
      "advisor-repair-validation-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(claim.needs).toBe("select");
    expect(workflow.jobs).not.toHaveProperty("recover");
    expect(serialized(resolveJob)).not.toContain('repair-resolve.mts\\" recover');
  });

  // source-shape-contract: security -- The gateway and sandbox must share one owned lifecycle so later failures cannot strand either process
  it("owns inference and repair cleanup in one lifecycle command (#10791)", () => {
    const resolve = (workflow.jobs.resolve.steps ?? []).find((step) =>
      step.run?.includes('repair-resolve.mts" resolve'),
    );

    expect(resolve).toBeDefined();
    expect(resolve?.env?.CLEANUP_RECEIPT_FILE).toBe("${{ runner.temp }}/cleanup.json");
    expect(serialized(workflow.jobs.resolve)).not.toContain('repair-resolve.mts\\" configure');
  });

  // source-shape-contract: security -- Cleanup evidence must survive every candidate or deletion failure without gaining credentials or write authority
  it("retains cleanup evidence independently of repair success (#10791)", () => {
    const cleanupUpload = (workflow.jobs.resolve.steps ?? []).find((step) =>
      String(step.with?.name ?? "").startsWith("advisor-repair-cleanup-"),
    );

    expect(cleanupUpload?.if).toBe("${{ always() }}");
    expect(cleanupUpload?.with?.path).toBe("${{ runner.temp }}/cleanup.json");
    expect(cleanupUpload?.with?.["retention-days"]).toBe(1);
  });

  // source-shape-contract: security -- Validation evidence must remain available throughout the maintainer review window
  it("retains validation evidence through the review window (#10791)", () => {
    const selection = (workflow.jobs.select.steps ?? []).find((step) =>
      String(step.with?.name ?? "").startsWith("advisor-repair-selection-"),
    );
    const candidate = (workflow.jobs.resolve.steps ?? []).find((step) =>
      String(step.with?.name ?? "").startsWith("advisor-repair-candidate-"),
    );
    const validated = (workflow.jobs.validate.steps ?? []).find((step) =>
      String(step.with?.name ?? "").startsWith("advisor-repair-validated-"),
    );
    const dependency = (workflow.jobs["reviewed-dependency"].steps ?? []).find((step) =>
      String(step.with?.name ?? "").startsWith("advisor-repair-reviewed-dependency-"),
    );

    expect(selection?.with?.["retention-days"]).toBe(31);
    expect(candidate?.with?.["retention-days"]).toBe(31);
    expect(validated?.with?.["retention-days"]).toBe(31);
    expect(dependency?.with?.["retention-days"]).toBe(31);
  });

  // source-shape-contract: security -- A model-declared no-repair outcome must never cross into candidate validation
  it("records blocked outcomes without validating or publishing them (#10791)", () => {
    expect(workflow.jobs.resolve.outputs?.outcome).toContain("steps.export.outputs.outcome");
    expect(workflow.jobs.validate.if).toContain("needs.resolve.outputs.outcome == 'proposed'");
    expect(workflow.jobs).not.toHaveProperty("publish");
    expect(serialized(workflow.jobs.audit)).toContain("needs.resolve.outputs.outcome");
  });

  it.each(jobEnvironmentCases)(
    "uses contexts available while GitHub compiles the %s job environment (#10791)",
    (_jobName, env) => {
      expect(JSON.stringify(env ?? {})).not.toContain("runner.temp");
    },
  );

  // source-shape-contract: security -- Job-level repair paths must use a context GitHub permits while compiling the workflow
  it.each(["resolve", "reviewed-dependency", "validate"])(
    "uses isolated workspace paths for the %s job (#10791)",
    (jobName) => {
      expect(JSON.stringify(workflow.jobs[jobName].env)).toContain("github.workspace");
    },
  );
});
