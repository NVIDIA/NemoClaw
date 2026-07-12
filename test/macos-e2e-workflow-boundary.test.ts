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
    expect(jobNamed("macos-docker-final-destroy").if).toContain(
      "github.event_name != 'pull_request'",
    );
    expect(jobNamed("macos-docker-final-destroy").if).toContain("github.ref == 'refs/heads/main'");
  });

  // source-shape-contract: compatibility -- Real Docker cleanup must invoke its gated live lane on the reviewed Intel runner and engine
  it("runs final-destroy against a pinned Docker setup on trusted Intel macOS", () => {
    const job = readMacosWorkflow().jobs?.["macos-docker-final-destroy"];
    const docker = job?.steps?.find((step) => step.name === "Set up pinned Docker Engine");
    const live = job?.steps?.find((step) => step.name === "Run macOS Docker final-destroy E2E");

    expect(job?.["runs-on"]).toBe("macos-15-intel");
    expect(job?.permissions).toEqual({ contents: "read" });
    expect(docker?.uses).toBe(
      "docker/setup-docker-action@6d7cfa65f60a9dda7b46e5513fa982536f3c9877",
    );
    expect(docker?.with?.version).toBe("v27.4.0");
    expect(live?.run).toContain("npx vitest run --project e2e-live");
    expect(live?.run).toContain("test/e2e/live/sandbox-operations.test.ts");
    expect(live?.env?.NEMOCLAW_RUN_LIVE_E2E).toBe("1");
    expect(live?.env?.NEMOCLAW_NON_INTERACTIVE).toBe("1");
  });

  // source-shape-contract: security -- Failure-only macOS artifact publishers must retain diagnostic paths and immutable actions
  it("pins live macOS artifact publishers to an immutable action", () => {
    const workflow = readMacosWorkflow();
    const upload = workflow.jobs?.["macos-e2e"]?.steps?.find(
      (step) => step.name === "Upload logs on failure",
    );
    const dockerUpload = workflow.jobs?.["macos-docker-final-destroy"]?.steps?.find(
      (step) => step.name === "Upload macOS Docker logs on failure",
    );

    for (const step of [upload, dockerUpload]) {
      expect(step?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
      expect(String(step?.with?.path)).toContain("/tmp/nemoclaw-e2e-*.log");
      expect(String(step?.with?.path)).toContain("${{ github.workspace }}/e2e-artifacts/live");
    }
    expect(upload?.if).toBe("failure() && github.event_name == 'pull_request'");
    expect(dockerUpload?.if).toBe("failure()");
  });
});
