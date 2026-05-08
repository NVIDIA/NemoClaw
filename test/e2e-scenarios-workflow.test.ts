// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/e2e-scenarios.yaml");

type AnyRecord = Record<string, unknown>;

function loadWorkflow(): AnyRecord {
  expect(fs.existsSync(WORKFLOW_PATH), `workflow missing at ${WORKFLOW_PATH}`).toBe(true);
  const raw = fs.readFileSync(WORKFLOW_PATH, "utf8");
  return yaml.load(raw) as AnyRecord;
}

describe("e2e-scenarios workflow", () => {
  it("e2e_scenarios_workflow_should_have_dispatch_inputs", () => {
    const wf = loadWorkflow();
    // YAML `on:` parses as the literal key "true" in some parsers — handle both.
    const on = (wf.on ?? wf[true as unknown as string]) as AnyRecord | undefined;
    expect(on, "workflow missing 'on' trigger").toBeTruthy();
    const dispatch = on?.workflow_dispatch as AnyRecord | undefined;
    expect(dispatch, "workflow missing workflow_dispatch").toBeTruthy();
    const inputs = dispatch?.inputs as AnyRecord | undefined;
    expect(inputs).toBeTruthy();
    expect(inputs).toHaveProperty("scenario");
    expect(inputs).toHaveProperty("plan_only");
    expect(inputs).toHaveProperty("suite_filter");
  });

  it("e2e_scenarios_workflow_should_call_run_scenario", () => {
    const raw = fs.readFileSync(WORKFLOW_PATH, "utf8");
    expect(raw).toMatch(/test\/e2e\/run-scenario\.sh/);
  });

  it("e2e_scenarios_workflow_should_upload_artifacts", () => {
    const raw = fs.readFileSync(WORKFLOW_PATH, "utf8");
    expect(raw).toMatch(/actions\/upload-artifact/);
    // Artifact name should be scenario-scoped.
    expect(raw).toMatch(/e2e-scenario-.*\$\{\{\s*(?:inputs|github\.event\.inputs)\.scenario\s*\}\}/);
    // Uploads .e2e/ artifacts.
    expect(raw).toMatch(/\.e2e\//);
  });

  it("e2e_scenarios_workflow_should_be_manual_only", () => {
    const wf = loadWorkflow();
    const on = (wf.on ?? wf[true as unknown as string]) as AnyRecord | undefined;
    expect(on).toBeTruthy();
    const keys = Object.keys(on ?? {});
    // Manual-only: must not trigger on push, pull_request, or schedule.
    expect(keys).not.toContain("push");
    expect(keys).not.toContain("pull_request");
    expect(keys).not.toContain("schedule");
  });
});
