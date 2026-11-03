// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildE2eWorkflowPlan,
  renderE2eWorkflowPlanSummary,
  writeE2eWorkflowPlanCiOutput,
} from "../../../tools/e2e/workflow-plan.mts";
import { expectedWorkflowPlanCiOutput } from "./workflow-plan-test-assertions.ts";

describe("E2E workflow plan Podman runtime", () => {
  it("uses the explicit Podman planner in the CI output path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-podman-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan({}, { gatewayRuntimes: ["podman"] });
    try {
      writeE2eWorkflowPlanCiOutput(
        {},
        {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
          GITHUB_REF: "refs/heads/main",
          GITHUB_WORKFLOW_REF: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main",
          EVENT_NAME: "workflow_dispatch",
          NEMOCLAW_E2E_CREDENTIALS_ALLOWED: "true",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
          NEMOCLAW_GATEWAY_RUNTIMES: "podman",
        },
      );

      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
