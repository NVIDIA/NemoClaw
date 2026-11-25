// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildE2eWorkflowPlan, selectedWorkflowJobs } from "../../../tools/e2e/workflow-plan.mts";

describe("Deep Code revocation E2E ownership", () => {
  it.each([
    "src/lib/state/sandbox.ts",
    "src/lib/state/snapshot/sqlite-credential-scan.ts",
    "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
  ])("selects the live owner when %s changes", (changedFile) => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });
    expect(plan.matrix.map((target) => target.id)).toContain(
      "ubuntu-repo-cloud-langchain-deepagents-code",
    );
    expect(selectedWorkflowJobs(plan)).toContain("live");
  });
});
