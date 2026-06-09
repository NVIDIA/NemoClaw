// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listScenarios } from "../scenarios/registry.ts";
import { resolveRunnerForScenario } from "../scenarios/runner-routing.ts";
import {
  validateE2eScenariosWorkflowBoundary,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "e2e-scenarios.yaml");

function routesFromWorkflow(workflowPath = WORKFLOW_PATH): Map<string, string> {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const match = /declare -A ROUTES=\(\n(?<body>[\s\S]*?)\n\s*\)/.exec(workflow);
  if (!match?.groups?.body) {
    throw new Error("Could not find ROUTES table in e2e-scenarios.yaml");
  }
  return new Map(
    Array.from(match.groups.body.matchAll(/^\s*\[([^\]]+)\]=([^\s)]+)\s*$/gm), ([, id, runner]) => [
      id,
      runner,
    ]),
  );
}

describe("e2e-scenarios workflow boundary", () => {
  it("keeps scenario execution manual/reusable and artifact-safe", () => {
    expect(validateE2eScenariosWorkflowBoundary()).toEqual([]);
  });

  it("routes every typed scenario ID to its resolved runner", () => {
    const scenarios = listScenarios().sort((left, right) => left.id.localeCompare(right.id));
    const routes = routesFromWorkflow();
    const typedIds = scenarios.map((scenario) => scenario.id);
    const routeIds = Array.from(routes.keys()).sort();
    const missing = typedIds.filter((id) => !routeIds.includes(id));
    const extra = routeIds.filter((id) => !typedIds.includes(id));
    const runnerMismatches = scenarios.flatMap((scenario) => {
      const workflowRunner = routes.get(scenario.id);
      if (!workflowRunner) {
        return [];
      }
      const resolvedRunner = resolveRunnerForScenario(scenario).runner;
      return workflowRunner === resolvedRunner
        ? []
        : [`${scenario.id}: workflow=${workflowRunner}, typed=${resolvedRunner}`];
    });

    expect(missing, `workflow ROUTES missing typed scenario IDs: ${missing.join(", ")}`).toEqual(
      [],
    );
    expect(extra, `workflow ROUTES has unknown scenario IDs: ${extra.join(", ")}`).toEqual([]);
    expect(
      runnerMismatches,
      `workflow ROUTES has runner mismatches: ${runnerMismatches.join("; ")}`,
    ).toEqual([]);
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
      - name: Run typed scenarios
        run: npx tsx test/e2e-scenario/scenarios/run.ts --scenarios "$SCENARIOS" --plan-only
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
          "run-scenario job missing step: Run typed scenarios in WSL",
          "artifact upload name must include the scenarios input",
          "artifact upload must set include-hidden-files: false (raw context.env must not leak)",
          "artifact upload path must include .e2e/actions/ (redacted action evidence)",
          "artifact upload path must include .e2e/logs/ (redacted shell-step evidence)",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("e2e-vitest-scenarios workflow boundary", () => {
  it("keeps the live Vitest scenario workflow manual, pinned, and artifact-safe", () => {
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);
  });

  it("flags direct dispatch-input interpolation and missing hidden artifact upload", () => {
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
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Set up Node
        uses: actions/setup-node@v4
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
          include-hidden-files: false
          if-no-files-found: ignore
`,
    );

    try {
      const errors = validateE2eVitestScenariosWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "checkout action must be pinned to a full commit SHA",
          "checkout step must set persist-credentials=false",
          "setup-node action must be pinned to a full commit SHA",
          "run-scenario job missing step: Build CLI",
          "step 'Run Vitest live E2E scenarios' run script must not interpolate dispatch inputs directly",
          "step 'Summarize artifacts' run script must not interpolate dispatch inputs directly",
          "summary step must pass display filter through FILTER_LABEL env",
          "artifact upload must set include-hidden-files: true",
          "upload-artifact action must be pinned to a full commit SHA",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
