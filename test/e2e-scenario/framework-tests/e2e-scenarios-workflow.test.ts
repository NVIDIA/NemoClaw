// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { validateE2eVitestScenariosWorkflowBoundary } from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("e2e-vitest-scenarios workflow boundary", () => {
  it("keeps the live Vitest scenario workflow manual, pinned, and artifact-safe", () => {
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);
  });

  it("flags direct dispatch-input interpolation and unsafe artifact upload", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    fs.writeFileSync(
      workflowPath,
      `
"on":
  workflow_dispatch:
    inputs:
      test_filter:
        required: false
permissions:
  contents: read
jobs:
  live-scenarios:
    runs-on: ubuntu-latest
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/vitest
      NEMOCLAW_RUN_E2E_SCENARIOS: "1"
      NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
      - name: Run Vitest live E2E scenarios
        env:
          TEST_FILTER: \${{ inputs.test_filter }}
        run: npx vitest run --project e2e-scenarios-live "\${{ inputs.test_filter }}"
      - name: Summarize artifacts
        run: echo "\${{ github.event.inputs['test_filter'] }}"
      - name: Upload Vitest E2E artifacts
        uses: actions/upload-artifact@v4
        with:
          name: e2e-vitest-scenarios
          path: .e2e/vitest/
          include-hidden-files: true
          if-no-files-found: ignore
`,
    );

    try {
      const errors = validateE2eVitestScenariosWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "workflow_dispatch missing input: scenarios",
          "workflow_dispatch must not expose legacy test_filter input",
          "workflow missing generate-matrix job",
          "generate-matrix job must run on ubuntu-latest",
          "live-scenarios job must run on the matrix runner",
          "live-scenarios job must depend on generate-matrix",
          "live-scenarios strategy.fail-fast must be false",
          "live-scenarios matrix.include must come from generate-matrix output",
          "live-scenarios job must write artifacts under e2e-artifacts/vitest",
          "live-scenarios job must point NEMOCLAW_CLI_BIN at the repo CLI",
          "live-scenarios job env must not include NVIDIA_API_KEY",
          "checkout action must be pinned to a full commit SHA",
          "checkout step must set persist-credentials=false",
          "step 'Set up Node' env must not include NVIDIA_API_KEY",
          "setup-node action must be pinned to a full commit SHA",
          "run-scenario job missing step: Build CLI",
          "Vitest step must pass matrix.id through SCENARIO_ID env",
          "Vitest step must receive NVIDIA_API_KEY from secrets",
          "step 'Run Vitest live E2E scenarios' run script must not interpolate dispatch inputs directly",
          "step 'Run Vitest live E2E scenarios' run script must include test/e2e-scenario/live/registry-scenarios.test.ts",
          "step 'Run Vitest live E2E scenarios' run script must include \"^${SCENARIO_ID}$\"",
          "step 'Summarize artifacts' run script must not interpolate dispatch inputs directly",
          "summary step must pass matrix.id through SCENARIO_ID env",
          "summary step must pass matrix.label through SCENARIO_LABEL env",
          "step 'Summarize artifacts' run script must include run-plan.json",
          'step \'Summarize artifacts\' run script must include Path(os.environ["E2E_ARTIFACT_DIR"]) / os.environ["SCENARIO_ID"]',
          "step 'Summarize artifacts' run script must include | Scenario | Manifest | Expected state | Suites | Phases |",
          "artifact upload must set include-hidden-files: false",
          "artifact upload name must include matrix.id",
          "artifact upload path must include e2e-artifacts/vitest/${{ matrix.id }}/run-plan.json",
          "artifact upload path must include e2e-artifacts/vitest/${{ matrix.id }}/scenario.json",
          "artifact upload path must include e2e-artifacts/vitest/${{ matrix.id }}/shell/",
          "artifact upload retention-days must be 14",
          "upload-artifact action must be pinned to a full commit SHA",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
