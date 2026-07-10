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
};

type WorkflowJob = {
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

function macosJob(): WorkflowJob {
  const job = readMacosWorkflow().jobs?.["macos-e2e"];
  expect(job).toBeDefined();
  return job!;
}

function stepNamed(name: string): WorkflowStep {
  const step = macosJob().steps?.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step!;
}

describe("macOS E2E workflow boundary", () => {
  it("keeps secret-bearing live E2E off pull_request runs", () => {
    expect(readMacosWorkflow().on?.pull_request).toBeDefined();

    for (const name of [
      "Run macOS full E2E",
      "Install OpenShell CLI for macOS sandbox operations",
      "Run macOS final-destroy gateway cleanup E2E",
    ]) {
      expect(stepNamed(name).if).toContain("github.event_name != 'pull_request'");
    }

    for (const name of ["Run macOS full E2E", "Run macOS final-destroy gateway cleanup E2E"]) {
      expect(String(stepNamed(name).env?.NVIDIA_INFERENCE_API_KEY)).toContain(
        "github.event_name != 'pull_request'",
      );
    }
  });

  it("starts Docker with Colima only for trusted macOS live runs", () => {
    const docker = stepNamed("Prepare Docker availability");
    expect(String(docker.env?.TRUSTED_MACOS_LIVE)).toContain("github.event_name != 'pull_request'");
    expect(docker.run).toContain('TRUSTED_MACOS_LIVE" != "1"');
    expect(docker.run).toContain("colima start");
    expect(docker.run).toContain("docker info");
  });

  it("keeps the job timeout outside the combined live test budgets", () => {
    expect(macosJob()["timeout-minutes"]).toBeGreaterThanOrEqual(150);
  });
});
