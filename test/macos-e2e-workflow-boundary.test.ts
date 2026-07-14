// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = {
  name?: string;
  if?: string;
  env?: Record<string, unknown>;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
};

function readMacosWorkflow(): Workflow {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "macos-e2e.yaml"), "utf8"),
  ) as Workflow;
}

function jobNamed(name: string): WorkflowJob {
  const job = readMacosWorkflow().jobs?.[name];
  expect(job).toBeDefined();
  return job!;
}

function stepNamed(name: string, jobName = "macos-e2e"): WorkflowStep {
  const step = jobNamed(jobName).steps?.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step!;
}

describe("macOS E2E workflow boundary", () => {
  // source-shape-contract: security -- Live credentials must stay gated to trusted main-branch workflow code
  it("keeps secret-bearing live E2E on trusted main-branch code", () => {
    expect(readMacosWorkflow().on?.pull_request).toBeDefined();

    expect(stepNamed("Run macOS full E2E").if).toContain("github.event_name != 'pull_request'");
    expect(stepNamed("Run macOS full E2E").if).toContain("github.ref == 'refs/heads/main'");

    expect(String(stepNamed("Run macOS full E2E").env?.NVIDIA_INFERENCE_API_KEY)).toContain(
      "github.event_name != 'pull_request'",
    );
    expect(String(stepNamed("Run macOS full E2E").env?.NVIDIA_INFERENCE_API_KEY)).toContain(
      "github.ref == 'refs/heads/main'",
    );
  });

  // source-shape-contract: compatibility -- OpenShell publishes macOS gateway assets only for Apple Silicon
  it("keeps gateway lifecycle coverage on supported Apple Silicon macOS", () => {
    const workflow = readMacosWorkflow();
    const lifecycle = stepNamed("Run gateway lifecycle regressions");

    expect(jobNamed("macos-e2e")["runs-on"]).toBe("macos-26");
    expect(JSON.stringify(workflow.jobs ?? {})).not.toContain("macos-15-intel");
    expect(lifecycle.run).toContain("test/tunnel-gateway-port-release-runtime.test.ts");
    expect(lifecycle.run).toContain("test/onboard-gateway-prelaunch-cutover.test.ts");
    expect(lifecycle.run).toContain("test/onboard-gateway-legacy-identity-upgrade-runtime.test.ts");
  });

  // source-shape-contract: security -- The failure-only macOS artifact publisher must retain diagnostic paths and an immutable action
  it("pins the macOS artifact publisher to an immutable action", () => {
    const workflow = readMacosWorkflow();
    const upload = workflow.jobs?.["macos-e2e"]?.steps?.find(
      (step) => step.name === "Upload logs on failure",
    );

    expect(upload?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    const paths = String(upload?.with?.path)
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    expect(paths).toHaveLength(2);
    expect(paths).toEqual([
      "/tmp/nemoclaw-e2e-*.log",
      "${{ github.workspace }}/e2e-artifacts/live",
    ]);
    expect(upload?.if).toBe("failure() && github.event_name == 'pull_request'");
  });
});
