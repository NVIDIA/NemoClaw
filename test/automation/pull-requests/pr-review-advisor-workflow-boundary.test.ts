// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validatePrReviewAdvisorWorkflowBoundary } from "../../../tools/pr-review-advisor/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/pr-review-advisor.yaml");

function workflow(): Record<string, any> {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as Record<string, any>;
}

function validateMutation(mutate: (value: Record<string, any>) => void): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-workflow-"));
  const file = path.join(directory, "workflow.yaml");
  const value = workflow();
  mutate(value);
  fs.writeFileSync(file, YAML.stringify(value));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("PR review advisor workflow boundary", () => {
  it("accepts the specialist workflow with linked reviews", () => {
    expect(validatePrReviewAdvisorWorkflowBoundary()).toEqual([]);
  });

  it("requires valid specialist sandbox names", () => {
    const errors = validateMutation((workflow) => {
      workflow.jobs["review-specialists"].strategy.matrix.advisor = [
        { sandbox_name: "invalid_name" },
      ];
    });
    expect(errors).toContain(
      "specialist matrix entry 1 sandbox_name must satisfy the OpenShell sandbox-name contract (max 19 characters)",
    );
  });

  it("rejects a synthesis job", () => {
    const errors = validateMutation((workflow) => {
      workflow.jobs.review = {
        permissions: {},
        strategy: { matrix: { advisor: [{ sandbox_name: "pr-adv-synthesis" }] } },
      };
    });
    expect(errors).toContain("workflow must not declare a synthesis job");
  });

  it("keeps model jobs read-only and the publisher separate", () => {
    const errors = validateMutation((value) => {
      value.jobs["review-specialists"].permissions["pull-requests"] = "write";
      value.jobs.publish.env.PR_REVIEW_ADVISOR_API_KEY = "secret";
      value.jobs.publish.env.ADVISOR_WORKDIR = "/tmp/pr";
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "review-specialists job permissions.pull-requests must be read",
        "publish job must not receive the advisor model credential",
        "publish job must not receive the untrusted analysis worktree",
      ]),
    );
  });

  it("requires discovered specialists before publication", () => {
    const errors = validateMutation((value) => {
      value.jobs["review-specialists"].strategy.matrix.advisor = [];
      value.jobs["review-specialists"].needs = "publish";
      value.jobs["review-specialists"]["continue-on-error"] = true;
      value.jobs.publish.needs = "discover-specialists";
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "specialist matrix must use the discovered specialist prompts",
        "specialist matrix must depend on prompt discovery",
        "specialist failures must block publication",
        "publisher must depend on the specialist matrix",
      ]),
    );
  });

  it.each([
    {
      variable: "BASE_REF",
      expectedError: "Prepare advisor sandbox inputs must receive the selected base ref",
    },
    {
      variable: "HEAD_REF",
      expectedError: "Prepare advisor sandbox inputs must receive the selected head ref",
    },
  ])("requires $variable while preparing specialist context", ({ variable, expectedError }) => {
    const errors = validateMutation((value) => {
      const prepare = value.jobs["review-specialists"].steps.find(
        (step: Record<string, any>) => step.name === "Prepare advisor sandbox inputs",
      );
      delete prepare.env[variable];
    });
    expect(errors).toEqual([expectedError]);
  });

  it("rejects a non-artifact specialist upload action", () => {
    const errors = validateMutation((workflow) => {
      const upload = workflow.jobs["review-specialists"].steps.find(
        (step: Record<string, any>) => step.name === "Upload specialist review",
      );
      upload.uses = "actions/cache@" + "a".repeat(40);
    });
    expect(errors.some((item) => item.includes("must use actions/upload-artifact"))).toBe(true);
  });

  it("rejects an incomplete specialist artifact path", () => {
    const errors = validateMutation((workflow) => {
      const upload = workflow.jobs["review-specialists"].steps.find(
        (step: Record<string, any>) => step.name === "Upload specialist review",
      );
      upload.with.path =
        "artifacts/${{ matrix.advisor.artifact_dir }}/pr-review-session.jsonl";
    });
    expect(
      errors.some((item) =>
        item.includes("expected with.path=artifacts/${{ matrix.advisor.artifact_dir }}/"),
      ),
    ).toBe(true);
  });

  it("keeps the publisher on trusted workflow code", () => {
    const errors = validateMutation((value) => {
      const checkout = value.jobs.publish.steps.find(
        (step: Record<string, any>) =>
          step.name === "Checkout trusted comment publisher (workflow revision)",
      );
      checkout.with.ref = "main";
      const setup = value.jobs.publish.steps.find(
        (step: Record<string, any>) => step.name === "Setup Node for trusted publisher",
      );
      setup.uses = "actions/setup-node@v7";
    });
    expect(errors.some((error) => error.includes("with.ref"))).toBe(true);
    expect(errors.some((error) => error.includes("full commit SHA"))).toBe(true);
  });

  it("reports unreadable workflows", () => {
    expect(validatePrReviewAdvisorWorkflowBoundary("/missing/workflow.yaml")).toEqual([
      "failed to read or parse workflow: /missing/workflow.yaml",
    ]);
  });
});
