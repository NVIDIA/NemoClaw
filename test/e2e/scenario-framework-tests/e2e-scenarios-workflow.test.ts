// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateE2eScenariosWorkflowBoundary } from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("e2e-scenarios workflow boundary", () => {
  it("keeps scenario execution manual/reusable and artifact-safe", () => {
    expect(validateE2eScenariosWorkflowBoundary()).toEqual([]);
  });

  it("flags unsafe trigger and contract regressions", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-scenarios-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    fs.writeFileSync(
      workflowPath,
      `
"on":
  pull_request_target: {}
permissions:
  contents: write
jobs:
  run-scenario:
    runs-on: ubuntu-latest
    steps:
      - name: Run scenario
        run: bash test/e2e/runtime/run-scenario.sh --plan-only
      - name: Upload scenario artifacts
        uses: actions/upload-artifact@v4
        with:
          name: bad-name
          path: test/e2e/logs/
`,
    );

    try {
      const errors = validateE2eScenariosWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "workflow must support workflow_dispatch",
          "workflow must support workflow_call",
          "workflow must not run on pull_request_target",
          "workflow permissions.contents must be read",
          "workflow missing resolve-runner job",
          "run-scenario job must use the resolved runner output",
          "Run scenario step must not use retired --plan-only flag",
          "run-scenario job missing step: Run scenario in WSL",
          "artifact upload name must include the scenario input",
          "artifact upload must include hidden .e2e files",
          "artifact upload path must include .e2e/",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
