// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

type AdvisorWorkflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob & { if?: string }>;
};

describe("PR Review Advisor repair workflow contracts", () => {
  const advisorWorkflow = readYaml<AdvisorWorkflow>(".github/workflows/pr-review-advisor.yaml");
  const generatedHeadWorkflow = readYaml<AdvisorWorkflow>(
    ".github/workflows/pr-review-advisor-generated-head.yaml",
  );
  const generatedHeadWorkflowText = readFileSync(
    ".github/workflows/pr-review-advisor-generated-head.yaml",
    "utf8",
  );

  // source-shape-contract: security -- Job permissions and artifact routing are the executable privilege boundary for Advisor repair.
  it("keeps Phase 0 Advisor repair manual, credential-separated, and non-publishing (#10791)", () => {
    const select = advisorWorkflow.jobs["repair-select"];
    const resolve = advisorWorkflow.jobs["repair-resolve"];
    const validate = advisorWorkflow.jobs["repair-validate"];
    const repairPublish = advisorWorkflow.jobs["repair-publish"];
    const repairVerify = generatedHeadWorkflow.jobs.validate;
    const repairRequest = generatedHeadWorkflow.jobs.locate;
    const audit = advisorWorkflow.jobs["repair-audit"];
    const validatorText = readFileSync("tools/pr-review-advisor/repair-validate.mts", "utf8");
    expect(advisorWorkflow.permissions).toEqual({});
    expect(select.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(select.if).toContain("vars.PR_REVIEW_ADVISOR_REPAIR_ENABLED == 'true'");
    expect(select.permissions).toEqual({
      actions: "read",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(resolve.permissions).toEqual({ actions: "read", contents: "read" });
    expect(validate.permissions).toEqual({ actions: "read", contents: "read" });
    expect(audit.permissions).toEqual({});
    expect(repairPublish.environment).toBe("advisor-repair-publish");
    expect(repairPublish.if).toContain("inputs.repair_publish");
    expect(repairPublish.permissions).toEqual({
      actions: "read",
      contents: "write",
      "pull-requests": "read",
    });
    expect(JSON.stringify(advisorWorkflow)).not.toContain('"actions":"write"');
    expect(repairRequest.permissions).toEqual({ actions: "read", contents: "read" });
    expect(repairVerify.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(
      Object.entries(advisorWorkflow.jobs)
        .filter(([name]) => name !== "publish" && name !== "repair-publish")
        .filter(([, job]) => job.permissions?.contents === "write")
        .map(([name]) => name),
    ).toEqual([]);
    const resolveText = JSON.stringify(resolve);
    const validateText = JSON.stringify(validate);
    const repairPublishText = JSON.stringify(repairPublish);
    const repairVerifyText = JSON.stringify(repairVerify);
    const repairRequestText = JSON.stringify(repairRequest);
    const selectText = JSON.stringify(select);
    expect(JSON.stringify([resolve.env, validate.env, repairPublish.env])).not.toContain(
      "runner.temp",
    );
    expect(advisorWorkflow.concurrency).toEqual(
      expect.objectContaining({ "cancel-in-progress": false }),
    );
    expect(String(advisorWorkflow.concurrency?.group)).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(String(advisorWorkflow.concurrency?.group)).toContain("github.run_id");
    expect(selectText).toContain("PR Review Advisor repair attempt");
    expect(selectText).toContain("external_id");
    expect(resolveText).toContain("secrets.PR_REVIEW_ADVISOR_API_KEY");
    expect(validateText).not.toMatch(/secrets[.]|OPENAI_API_KEY|GITHUB_TOKEN/u);
    expect(resolveText.match(/repair-resolve[.]mts[^\n]* run/gu)).toHaveLength(1);
    expect(resolveText).toContain("assertRepairArtifactDirectory");
    expect(resolveText.match(/repair-resolve[.]mts[^\n]* export/gu)).toHaveLength(1);
    expect(resolveText).toContain('if":"always()"');
    expect(resolveText).toContain('"continue-on-error":true');
    expect(resolveText).toContain("CLEANUP_RECEIPT_FILE");
    expect(resolveText).toContain("Preserve resolver and cleanup outcomes");
    expect(resolve["runs-on"]).toBe("ubuntu-24.04");
    expect(resolve["timeout-minutes"]).toBe(60);
    const boundedSandboxSteps = new Map(
      (resolve.steps ?? []).map((step) => [step.id, String(step.run ?? "")]),
    );
    expect(boundedSandboxSteps.get("install")).toContain("kill-after=15s 10m");
    expect(boundedSandboxSteps.get("budget")).toContain("elapsed_seconds > 900");
    expect(boundedSandboxSteps.get("budget")).toContain("15-minute pre-sandbox budget");
    expect(boundedSandboxSteps.get("create")).toContain("kill-after=15s 5m");
    expect(boundedSandboxSteps.get("repair_run")).toContain("kill-after=15s 22m");
    expect(boundedSandboxSteps.get("download")).toContain("kill-after=15s 5m");
    expect(boundedSandboxSteps.get("cleanup")).toContain("kill-after=15s 5m");
    expect(resolveText).toContain("process.env.INSTALL_OUTCOME");
    expect(resolveText).toContain("process.env.BUDGET_OUTCOME");
    expect(resolveText).toContain("advisor-repair-${{ github.run_id }}");
    expect(validateText).toContain("needs.repair-select.outputs.context-artifact-id");
    expect(validateText).toContain("needs.repair-resolve.outputs.candidate-artifact-id");
    expect(validateText).toContain("repair-validate.mts");
    expect(validatorText).toContain("repairValidationPlan");
    expect(validateText).not.toContain("run check:diff");
    expect(validateText).not.toContain("run test:changed");
    expect(validateText).not.toContain("test:live-e2e");
    expect(validateText).not.toContain("publishAdvisorRepair");
    expect(repairPublishText).toContain("needs.repair-select.outputs.context-artifact-id");
    expect(repairPublishText).toContain("needs.repair-validate.outputs.validated-artifact-id");
    expect(repairPublishText).toContain("assertRepairArtifactDirectory");
    expect(repairPublishText).toContain("advisor-repair-generated-head-request");
    expect(repairPublishText).toContain("validation.json");
    const upload = repairPublishText.indexOf("Upload the generated-head validation request");
    expect(upload).toBeLessThan(
      repairPublishText.indexOf("Compare-and-swap the prepared repair commit"),
    );
    expect(generatedHeadWorkflowText).toContain("types: [completed]");
    expect(repairRequest.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(audit.needs).toContain("repair-publish");
    const auditSteps = advisorWorkflow.jobs["repair-audit"]?.steps ?? [];
    const writeAuditStep = auditSteps.find(
      (candidate) => candidate.name === "Write bounded redacted receipt",
    );
    expect(writeAuditStep, "Write bounded redacted receipt must remain present").toBeDefined();
    expect(writeAuditStep?.["continue-on-error"]).not.toBe(true);
    const uploadAuditStep = auditSteps.find(
      (candidate) => candidate.name === "Upload audit receipt",
    );
    expect(uploadAuditStep, "Upload audit receipt must remain present").toBeDefined();
    expect(uploadAuditStep?.["continue-on-error"]).not.toBe(true);
    expect(repairPublishText).not.toMatch(/secrets[.]|OPENAI_API_KEY|PR_REVIEW_ADVISOR_API_KEY/u);
    expect(repairRequestText).toContain("github.event.workflow_run.id");
    expect(repairRequestText).toContain("pr-review-advisor.yaml");
    expect(repairRequestText).toContain("source-artifact-pages.json");
    expect(repairVerifyText).toContain("needs.locate.outputs.source-workflow-sha");
    expect(repairVerifyText).toContain("needs.locate.outputs.artifact-id");
    expect(repairVerifyText).toContain("advisor-repair-checks");
    expect(repairVerifyText).toContain("VALIDATION_FILE");
    expect(repairVerifyText).toContain("parseValidationReceipt");
    expect(repairVerifyText).not.toContain("check-runs");
    expect(repairVerifyText).not.toMatch(/secrets[.]|contents":"write/u);
    const auditText = JSON.stringify(audit);
    expect(auditText).toContain("failure:{stage:");
    expect(auditText).toContain("resolveFailureStage");
    expect(auditText).toContain("cleanup:$resolveCleanup");
    expect(auditText).toContain("prNumber:$pr");
    expect(auditText).toContain("tr -cd '0-9'");
  });
});
