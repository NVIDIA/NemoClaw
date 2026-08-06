// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

type DailyTagWorkflow = {
  on: { schedule: Array<{ cron: string }> };
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const workflow = readYaml<DailyTagWorkflow>(".github/workflows/release-daily-tag.yaml");

describe("daily release tag workflow", () => {
  // source-shape-contract: security -- The trusted schedule, signer boundary, and non-E2E cut command protect automated immutable tags
  it("cuts at 4 PM Los Angeles without consulting E2E and promotes the exact tag", () => {
    expect(workflow.on.schedule.map(({ cron }) => cron)).toEqual(["0 23 * * *", "0 0 * * *"]);
    expect(workflow.permissions).toEqual({});

    const gate = workflow.jobs["schedule-gate"];
    const cut = workflow.jobs["cut-release"];
    const promote = workflow.jobs["promote-release"];
    const prepareScript = cut.steps?.find(
      (step) => step.name === "Prepare the current main release",
    )?.run;
    const cutStep = cut.steps?.find(
      (step) => step.name === "Create and push the signed release tag",
    );

    expect(gate.steps?.[0]?.run).toContain("TZ=America/Los_Angeles");
    expect(cut.environment).toBe("release-tag");
    expect(cut.permissions).toEqual({ contents: "write" });
    expect(prepareScript).toContain("scripts/release-plan.mts");
    expect(prepareScript).toContain("git rev-list --count");
    expect(prepareScript).toContain('git grep -l -x -F "## $tag"');
    expect(cutStep?.env?.NEMOCLAW_RELEASE_TAG_SIGNING_KEY).toBe(
      "${{ secrets.NEMOCLAW_RELEASE_TAG_SIGNING_KEY }}",
    );
    expect(cutStep?.run).toContain("scripts/release-cut-tag.sh");
    expect(cutStep?.run).toContain("--scheduled");
    expect(JSON.stringify(workflow)).not.toContain("e2e");
    expect(promote.uses).toBe("./.github/workflows/release-latest-tag.yaml");
    expect(promote.with?.tag).toBe("${{ needs.cut-release.outputs.tag }}");
  });
});
