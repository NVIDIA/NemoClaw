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
  it("requires valid specialist sandbox names", () => {
    const errors = mutate((workflow) => {
      workflow.jobs["review-specialists"].strategy.matrix.advisor = [
        { sandbox_name: "invalid_name" },
      ];
    });
    expect(errors).toContain(
      "specialist matrix entry 1 sandbox_name must satisfy the OpenShell sandbox-name contract (max 19 characters)",
    );
  });

  // source-shape-contract: security -- The workflow publishes specialist reviews without a model-backed synthesis job.
  it("rejects a synthesis job", () => {
    const errors = mutate((workflow) => {
      workflow.jobs.review = {
        permissions: {},
        strategy: { matrix: { advisor: [{ sandbox_name: "pr-adv-synthesis" }] } },
      };
    });
    expect(errors).toContain("workflow must not declare a synthesis job");
  });
});
