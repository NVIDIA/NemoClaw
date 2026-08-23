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

function mutate(run: (workflow: Record<string, any>) => void): string[] {
  const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as Record<string, any>;
  run(workflow);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-openshell-workflow-"));
  const file = path.join(directory, "workflow.yaml");
  fs.writeFileSync(file, YAML.stringify(workflow));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("PR review advisor OpenShell workflow boundary", () => {
  // source-shape-contract: security -- OpenShell sandbox names prevent command and resource identity injection.
  it("requires valid sandbox names", () => {
    const errors = mutate((workflow) => {
      workflow.jobs.review.strategy.matrix.advisor[0].sandbox_name = "invalid_name";
    });
    expect(errors).toContain(
      "synthesis matrix entry 1 sandbox_name must satisfy the OpenShell sandbox-name contract (max 19 characters)",
    );
  });

  // source-shape-contract: security -- Distinct sandbox identities isolate every specialist from synthesis state.
  it("requires distinct specialist and synthesis sandboxes", () => {
    const errors = mutate((workflow) => {
      workflow.jobs.review.strategy.matrix.advisor[0].sandbox_name =
        workflow.jobs["review-specialists"].strategy.matrix.advisor[0].sandbox_name;
    });
    expect(errors).toContain(
      "advisor, specialist, and synthesis sandbox_name values must be unique",
    );
  });

  // source-shape-contract: security -- A fixed synthesis lane preserves the reviewed read-only model boundary.
  it("requires a synthesis matrix", () => {
    const errors = mutate((workflow) => {
      delete workflow.jobs.review.strategy.matrix.advisor;
    });
    expect(errors).toContain("synthesis matrix must declare a non-empty advisor array");
  });

  // source-shape-contract: security -- Required same-run native sessions prevent incomplete evidence from reaching synthesis.
  it("requires native specialist sessions", () => {
    const errors = mutate((workflow) => {
      const upload = workflow.jobs["review-specialists"].steps.find(
        (step: Record<string, any>) => step.name === "Upload native specialist session",
      );
      upload.with["if-no-files-found"] = "ignore";
      const download = workflow.jobs.review.steps.find(
        (step: Record<string, any>) => step.name === "Download specialist session artifacts",
      );
      download.with.path = "/tmp/sessions";
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "step 'Upload native specialist session' expected with.if-no-files-found=error",
        "step 'Download specialist session artifacts' expected with.path=pr-workdir/.pr-review-advisor-sessions",
      ]),
    );
  });
});
