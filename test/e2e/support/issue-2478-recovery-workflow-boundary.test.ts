// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

describe("recovery workflow scheduling (#7919)", () => {
  it("rejects recovery schedule, profile, and change-focused soak drift (#7919)", () => {
    const workflow = readWorkflow() as {
      on: { schedule: Array<{ cron: string }> };
      jobs: Record<string, { env: Record<string, string>; if: string }>;
    };
    workflow.on.schedule = [{ cron: "0 0 * * *" }];
    workflow.jobs["issue-2478-crash-loop-recovery"]!.env.NEMOCLAW_E2E_CRASH_CYCLES = "5";
    workflow.jobs["issue-2478-crash-loop-recovery-soak"]!.env.E2E_CHANGE_FOCUSED = "1";
    workflow.jobs["issue-2478-crash-loop-recovery-soak"]!.if =
      "${{ github.event_name != 'workflow_dispatch' }}";

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "workflow schedule must include 0 0 * * 1-6",
        "workflow schedule must include 0 0 * * 0",
        "workflow schedule must split nightly and weekly recovery runs",
        "issue-2478-crash-loop-recovery job env NEMOCLAW_E2E_CRASH_CYCLES must be 1",
        'issue-2478-crash-loop-recovery-soak job E2E_CHANGE_FOCUSED must be "0" when set',
        "issue-2478-crash-loop-recovery-soak job must keep its soak schedule and selector",
      ]),
    );
  });
});
