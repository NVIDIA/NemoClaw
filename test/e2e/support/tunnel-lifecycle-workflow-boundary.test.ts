// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  evaluateE2eWorkflowDispatchSelectors,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github/workflows/e2e.yaml"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("tunnel lifecycle workflow boundary", () => {
  it("maps the tunnel lifecycle selector to its free-standing E2E job", () => {
    expect(evaluateE2eWorkflowDispatchSelectors({ targets: "tunnel-lifecycle" })).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["tunnel-lifecycle"],
      registryTargets: [],
    });
    expect(evaluateE2eWorkflowDispatchSelectors({ jobs: "tunnel-lifecycle" })).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["tunnel-lifecycle"],
      registryTargets: [],
    });
  });

  it("requires the tunnel lifecycle job to use the repo NemoClaw CLI boundary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { env?: Record<string, unknown> }>;
    };
    const job = workflow.jobs["tunnel-lifecycle"];
    expect(job).toBeDefined();
    job.env = { ...job.env };
    delete job.env.NEMOCLAW_CLI_BIN;
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toContain(
        "tunnel-lifecycle job must point NEMOCLAW_CLI_BIN at the repo CLI",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects tunnel lifecycle trusted-boundary drift", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        { env?: Record<string, unknown>; steps: Array<Record<string, unknown>> }
      >;
    };
    const job = workflow.jobs["tunnel-lifecycle"];
    expect(job).toBeDefined();
    job.env = {
      ...job.env,
      DOCKER_CONFIG: "${{ github.workspace }}/e2e-artifacts/live/tunnel-lifecycle/docker-config",
    };

    const checkout = job.steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout).toBeDefined();
    checkout!.with = {
      ...(checkout!.with as Record<string, unknown>),
      "persist-credentials": true,
    };

    const install = job.steps.find((step) => step.name === "Install root dependencies");
    expect(install).toBeDefined();
    install!.env = {
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
    };
    install!.run = "npm install";

    const cloudflared = job.steps.find(
      (step) => step.name === "Install and verify cloudflared prerequisite",
    );
    expect(cloudflared).toBeDefined();
    cloudflared!.env = {
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
    };
    cloudflared!.run = "cloudflared --version";

    const runTunnel = job.steps.find((step) => step.name === "Run tunnel lifecycle live test");
    expect(runTunnel).toBeDefined();
    runTunnel!.run = `${String(runTunnel!.run ?? "")}\nsudo apt-get install -y cloudflared`;

    const upload = job.steps.find((step) => step.name === "Upload tunnel lifecycle artifacts");
    expect(upload).toBeDefined();
    upload!.with = {
      ...(upload!.with as Record<string, unknown>),
      path: "e2e-artifacts/live/",
      "include-hidden-files": true,
    };

    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "tunnel-lifecycle job must not set DOCKER_CONFIG at job level",
          "tunnel-lifecycle checkout step must set persist-credentials=false",
          "tunnel-lifecycle step 'Install root dependencies' env must not include NVIDIA_INFERENCE_API_KEY",
          "tunnel-lifecycle step 'Install root dependencies' env must not include NVIDIA_API_KEY",
          "step 'Install root dependencies' run script must include npm ci --ignore-scripts",
          "tunnel-lifecycle step 'Install and verify cloudflared prerequisite' env must not include NVIDIA_INFERENCE_API_KEY",
          "tunnel-lifecycle step 'Install and verify cloudflared prerequisite' env must not include NVIDIA_API_KEY",
          "tunnel-lifecycle cloudflared prerequisite step env must not include NVIDIA_INFERENCE_API_KEY",
          "tunnel-lifecycle cloudflared prerequisite step env must not include NVIDIA_API_KEY",
          "tunnel-lifecycle cloudflared prerequisite step must pin CLOUDFLARED_VERSION=2026.6.1",
          "tunnel-lifecycle cloudflared prerequisite step must pin CLOUDFLARED_DEB_SHA256=ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526",
          "step 'Install and verify cloudflared prerequisite' run script must include https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb",
          "step 'Install and verify cloudflared prerequisite' run script must include sha256sum -c -",
          "step 'Install and verify cloudflared prerequisite' run script must include dpkg-deb -f",
          "step 'Install and verify cloudflared prerequisite' run script must include sudo dpkg -i",
          "step 'Install and verify cloudflared prerequisite' run script must include cloudflared version ${CLOUDFLARED_VERSION}",
          "tunnel-lifecycle live E2E step must not run cloudflared APT installation with NVIDIA_INFERENCE_API_KEY in scope",
          "artifact upload path must include e2e-artifacts/live/tunnel-lifecycle/",
          "tunnel-lifecycle artifact upload must set include-hidden-files: false",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unverified cloudflared package installation before secret-bearing tunnel tests", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
    };
    const job = workflow.jobs["tunnel-lifecycle"];
    expect(job).toBeDefined();
    const cloudflared = job.steps.find(
      (step) => step.name === "Install and verify cloudflared prerequisite",
    );
    expect(cloudflared).toBeDefined();
    cloudflared!.env = { CLOUDFLARED_VERSION: "2026.6.1" };
    cloudflared!.run = [
      "set -euo pipefail",
      "sudo mkdir -p --mode=0755 /usr/share/keyrings",
      "curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null",
      "echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared noble main' | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null",
      "sudo apt-get update -qq",
      "sudo apt-get install -y cloudflared",
      "cloudflared --version",
    ].join("\n");
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "tunnel-lifecycle cloudflared prerequisite step must pin CLOUDFLARED_DEB_SHA256=ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526",
          "step 'Install and verify cloudflared prerequisite' run script must include https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb",
          "step 'Install and verify cloudflared prerequisite' run script must include sha256sum -c -",
          "step 'Install and verify cloudflared prerequisite' run script must include sudo dpkg -i",
          "step 'Install and verify cloudflared prerequisite' run script must not include pkg.cloudflare.com",
          "step 'Install and verify cloudflared prerequisite' run script must not include cloudflare-main.gpg",
          "step 'Install and verify cloudflared prerequisite' run script must not include apt-get install",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
