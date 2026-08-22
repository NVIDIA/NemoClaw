// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validatePrReviewAdvisorWorkflowBoundary } from "../tools/pr-review-advisor/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/pr-review-advisor.yaml");
const OPENSHELL_POLICY_PATH = path.join(
  ROOT,
  "tools",
  "pr-review-advisor",
  "openshell-policy.yaml",
);
function workflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

function mutateWorkflowSource(
  source: string,
  mutate: (workflow: Record<string, any>) => void,
): string {
  const workflow = YAML.parse(source) as Record<string, any>;
  mutate(workflow);
  return YAML.stringify(workflow);
}

function validateMutation(mutate: (source: string) => string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-boundary-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  fs.writeFileSync(workflowPath, mutate(workflowSource()));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function validatePolicyMutation(mutate: (policy: Record<string, any>) => void): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-policy-"));
  const policyPath = path.join(tmp, "openshell-policy.yaml");
  const policy = YAML.parse(fs.readFileSync(OPENSHELL_POLICY_PATH, "utf8")) as Record<string, any>;
  mutate(policy);
  fs.writeFileSync(policyPath, YAML.stringify(policy));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(
      WORKFLOW_PATH,
      path.join(ROOT, "package-lock.json"),
      policyPath,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("PR review advisor OpenShell workflow boundary", () => {
  it("pins the OpenShell image, loopback gateway, and per-lane sandbox identity", () => {
    const errors = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs.review.env.OPENSHELL_GATEWAY_ENDPOINT = "http://gateway.example:8080";
        workflow.jobs.review.env.PI_IMAGE =
          "ghcr.io/nvidia/openshell-community/sandboxes/pi:latest";
        workflow.jobs.review.env.SANDBOX_NAME = "pr-advisor";
        workflow.jobs.review.strategy.matrix.advisor[0].sandbox_name = "pr-advisor--bad";
        workflow.jobs.review.strategy.matrix.advisor[0].artifact_dir = "../../advisor";
        const prepare = workflow.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Prepare isolated analysis workspace",
        );
        prepare.env.TARGET_DIR = "/tmp/pr-workdir";
      }),
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        "review job env.OPENSHELL_GATEWAY_ENDPOINT must be http://127.0.0.1:8080",
        "review job env.PI_IMAGE must be ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:00d0c5e9e733f94f6db3eaa2ab70d4fd75bcc4aace6b13a54535cbf2dd20dfcd",
        "review job env.SANDBOX_NAME must be ${{ matrix.advisor.sandbox_name }}",
        "advisor matrix entry 1 sandbox_name must satisfy the OpenShell sandbox-name contract (max 19 characters)",
        "advisor matrix entry 1 artifact_dir must be a simple directory name",
        "Prepare isolated analysis workspace must use the fixed pr-workdir upload directory",
      ]),
    );
  });

  it("rejects overlong and duplicate specialist and synthesis sandbox names (#9968)", () => {
    const overlong = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs["review-specialists"].strategy.matrix.advisor[0].sandbox_name =
          "pr-advisor-sp-behavior";
        workflow.jobs["review-synthesis-shadow"].strategy.matrix.advisor[0].sandbox_name =
          "pr-advisor-synthesis";
      }),
    );
    expect(overlong).toEqual(
      expect.arrayContaining([
        "specialist matrix entry 1 sandbox_name must satisfy the OpenShell sandbox-name contract (max 19 characters)",
        "synthesis matrix entry 1 sandbox_name must satisfy the OpenShell sandbox-name contract (max 19 characters)",
      ]),
    );

    const duplicate = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs["review-synthesis-shadow"].strategy.matrix.advisor[0].sandbox_name =
          workflow.jobs["review-specialists"].strategy.matrix.advisor[0].sandbox_name;
      }),
    );
    expect(duplicate).toContain(
      "advisor, specialist, and synthesis sandbox_name values must be unique",
    );
  });

  it.each([
    [
      "missing",
      (workflow: Record<string, any>) => {
        delete workflow.jobs["review-synthesis-shadow"].strategy.matrix.advisor;
      },
    ],
    [
      "non-array",
      (workflow: Record<string, any>) => {
        workflow.jobs["review-synthesis-shadow"].strategy.matrix.advisor = {};
      },
    ],
    [
      "empty",
      (workflow: Record<string, any>) => {
        workflow.jobs["review-synthesis-shadow"].strategy.matrix.advisor = [];
      },
    ],
  ])("rejects a %s synthesis advisor matrix (#9968)", (_case, mutate) => {
    const errors = validateMutation((source) => mutateWorkflowSource(source, mutate));
    expect(errors).toContain("synthesis matrix must declare a non-empty advisor array");
  });

  it("requires specialist success to include the native session upload (#9968)", () => {
    const errors = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        const steps = workflow.jobs["review-specialists"].steps;
        const upload = steps.find(
          (step: { name?: string }) => step.name === "Upload native specialist session",
        );
        upload.id = "detached-upload";
        upload.with["if-no-files-found"] = "warn";
        const outcome = steps.find(
          (step: { name?: string }) => step.name === "Verify advisor analysis outcome",
        );
        outcome.env.SPECIALIST_UPLOAD_OUTCOME = "success";
      }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "Upload native specialist session id must be upload-specialist-session",
        "step 'Upload native specialist session' expected with.if-no-files-found=error",
        "specialist outcome must use the native session upload outcome",
      ]),
    );
  });

  it("downloads sandbox artifacts before upload and always deletes the sandbox", () => {
    const weakenedDownload = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        const download = workflow.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Download advisor artifacts from sandbox",
        );
        download.id = "untrusted-download";
        download.if = "success()";
        download["continue-on-error"] = false;
        download.run =
          'node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" run';
      }),
    );
    expect(weakenedDownload).toEqual(
      expect.arrayContaining([
        "Download advisor artifacts from sandbox id must be download-analysis",
        "Download advisor artifacts from sandbox must run after every configured sandbox analysis",
        "Download advisor artifacts from sandbox must continue-on-error until artifacts are uploaded",
        "step 'Download advisor artifacts from sandbox' must use the canonical trusted OpenShell helper command",
      ]),
    );

    const weakenedCleanup = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        const cleanup = workflow.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Delete advisor sandbox",
        );
        cleanup.if = "success()";
        cleanup.run =
          'node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" create';
      }),
    );
    expect(weakenedCleanup).toEqual(
      expect.arrayContaining([
        "Delete advisor sandbox must run always",
        "step 'Delete advisor sandbox' must use the canonical trusted OpenShell helper command",
      ]),
    );

    const detachedOutcome = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        const verify = workflow.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Verify advisor analysis outcome",
        );
        verify.env.DOWNLOAD_OUTCOME = "${{ steps.analysis.outcome }}";
        verify.env.CONFIGURE_OUTCOME = "${{ steps.analysis.outcome }}";
        verify.env.UNAVAILABLE_OUTCOME = "${{ steps.analysis.outcome }}";
      }),
    );
    expect(detachedOutcome).toEqual(
      expect.arrayContaining([
        "Verify advisor analysis outcome must use the trusted sandbox download outcome",
        "Verify advisor analysis outcome must use the trusted configuration step outcome",
        "Verify advisor analysis outcome must use the trusted unavailable step outcome",
      ]),
    );
  });

  it("rejects specialist count, fail-fast, permission, session-path, and synthesis-dependency changes (#9949)", () => {
    const errors = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs["review-specialists"].strategy["fail-fast"] = true;
        workflow.jobs["review-specialists"].strategy.matrix.advisor.pop();
        workflow.jobs["review-specialists"].permissions["pull-requests"] = "write";
        workflow.jobs["review-synthesis-shadow"].needs = "review";
        workflow.jobs["review-synthesis-shadow"].env.PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR =
          "/tmp/sessions";
      }),
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        "review-specialists job permissions.pull-requests must be read",
        "publish must be the only job with pull-requests: write",
        "specialist matrix must disable fail-fast",
        "specialist matrix must declare exactly five interests",
        "synthesis job env.PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR must be ${{ github.workspace }}/pr-workdir/.pr-review-advisor-sessions",
        "shadow synthesis must depend only on the specialist matrix",
      ]),
    );
  });
});
