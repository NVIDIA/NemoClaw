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
  with?: Record<string, unknown>;
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

  it("starts Docker with preinstalled Colima only for trusted macOS live runs", () => {
    const docker = stepNamed("Prepare Docker availability");
    expect(String(docker.env?.TRUSTED_MACOS_LIVE)).toContain("github.event_name != 'pull_request'");
    expect(docker.run).toContain('TRUSTED_MACOS_LIVE" != "1"');
    expect(docker.run).toContain("command -v docker");
    expect(docker.run).toContain("command -v colima");
    expect(docker.run).toContain(
      "skipping live E2E instead of bootstrapping floating Homebrew packages",
    );
    expect(docker.run).not.toContain("brew install");
    expect(docker.run).toContain("colima start");
    expect(docker.run).toContain("Colima could not start Docker");
    expect(docker.run).toContain("docker_ok=false");
    expect(docker.run).toContain("docker info");
  });

  it("uploads live macOS E2E artifacts when the workflow fails", () => {
    const upload = stepNamed("Upload logs on failure");
    expect(upload.if).toBe("failure()");
    expect(String(upload.with?.path)).toContain("/tmp/nemoclaw-e2e-*.log");
    expect(String(upload.with?.path)).toContain("${{ github.workspace }}/e2e-artifacts/live");
  });

  it("keeps the job timeout outside the combined live test budgets", () => {
    expect(macosJob()["timeout-minutes"]).toBeGreaterThanOrEqual(150);
  });
});
