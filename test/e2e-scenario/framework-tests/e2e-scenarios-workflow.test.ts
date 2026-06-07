// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listScenarios } from "../scenarios/registry.ts";
import { resolveRunnerForScenario } from "../scenarios/runner-routing.ts";
import { validateE2eScenariosWorkflowBoundary } from "../../../tools/e2e-scenarios/workflow-boundary.mts";

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

  it("routes_every_typed_scenario_id_to_its_resolved_runner", () => {
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

    expect(missing, `workflow ROUTES missing typed scenario IDs: ${missing.join(", ")}`).toEqual([]);
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
          "artifact upload must include hidden .e2e files",
          "artifact upload path must include .e2e/",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
