// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/e2e-scenarios.yaml");
const PARITY_WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/e2e-parity-compare.yaml");

type AnyRecord = Record<string, unknown>;

function loadWorkflowAt(workflowPath: string): AnyRecord {
  expect(fs.existsSync(workflowPath), `workflow missing at ${workflowPath}`).toBe(true);
  const raw = fs.readFileSync(workflowPath, "utf8");
  return yaml.load(raw) as AnyRecord;
}

function loadWorkflow(): AnyRecord {
  return loadWorkflowAt(WORKFLOW_PATH);
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
    expect(raw).toMatch(/test\/e2e\/runtime\/run-scenario\.sh/);
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

describe("e2e-parity-compare workflow", () => {
  it("parity_workflow_should_support_single_script_bucket_and_all_inputs", () => {
    const wf = loadWorkflowAt(PARITY_WORKFLOW_PATH);
    const on = (wf.on ?? wf[true as unknown as string]) as AnyRecord | undefined;
    const inputs = ((on?.workflow_dispatch as AnyRecord | undefined)?.inputs ?? {}) as AnyRecord;
    expect(inputs).toHaveProperty("legacy_script");
    expect(inputs).toHaveProperty("bucket");
    expect(inputs).toHaveProperty("all_migrated");
    expect(inputs).toHaveProperty("scenario");
    expect(inputs).toHaveProperty("strict");
    expect(inputs).toHaveProperty("deferred_handling");
  });

  it("parity_workflow_should_upload_logs_and_reports", () => {
    const raw = fs.readFileSync(PARITY_WORKFLOW_PATH, "utf8");
    expect(raw).toMatch(/actions\/upload-artifact/);
    expect(raw).toMatch(/legacy\.log/);
    expect(raw).toMatch(/scenario\.log/);
    expect(raw).toMatch(/parity-report\.json/);
    expect(raw).toMatch(/coverage-report\.md/);
  });

  it("parity_workflow_should_fail_on_strict_divergence", () => {
    const raw = fs.readFileSync(PARITY_WORKFLOW_PATH, "utf8");
    const compareStep = raw.match(/- name: Compare parity[\s\S]*?(?=\n\s*- name:|\n\s*uses:|$)/)?.[0] ?? "";
    expect(compareStep).toMatch(/compare-parity\.sh/);
    expect(compareStep).toMatch(/STRICT_ARGS\+=\(--strict\)/);
    expect(compareStep).not.toMatch(/compare-parity\.sh[\s\S]*\|\|\s*true/);
  });
});
