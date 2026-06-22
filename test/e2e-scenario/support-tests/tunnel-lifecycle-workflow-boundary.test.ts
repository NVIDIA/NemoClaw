// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

describe("tunnel lifecycle workflow boundary", () => {
  it("maps the tunnel lifecycle selector to its free-standing Vitest job", () => {
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "tunnel-lifecycle" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["tunnel-lifecycle-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "tunnel-lifecycle-vitest" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["tunnel-lifecycle-vitest"],
      registryScenarios: [],
    });
  });

  it("requires the tunnel lifecycle job to use the repo NemoClaw CLI boundary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { env?: Record<string, unknown> }>;
    };
    const job = workflow.jobs["tunnel-lifecycle-vitest"];
    expect(job).toBeDefined();
    job.env = { ...job.env };
    delete job.env.NEMOCLAW_CLI_BIN;
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toContain(
        "tunnel-lifecycle-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects tunnel lifecycle trusted-boundary drift", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        { env?: Record<string, unknown>; steps: Array<Record<string, unknown>> }
      >;
    };
    const job = workflow.jobs["tunnel-lifecycle-vitest"];
    expect(job).toBeDefined();
    job.env = {
      ...job.env,
      DOCKER_CONFIG: "${{ github.workspace }}/e2e-artifacts/vitest/tunnel-lifecycle/docker-config",
    };

    const checkout = job.steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout).toBeDefined();
    checkout!.with = {
      ...(checkout!.with as Record<string, unknown>),
      "persist-credentials": true,
    };

    const configureDockerAuth = job.steps.find(
      (step) => step.name === "Configure isolated Docker auth directory",
    );
    expect(configureDockerAuth).toBeDefined();
    configureDockerAuth!.run =
      'echo "DOCKER_CONFIG=${{ github.workspace }}/docker-config-tunnel-lifecycle" >> "$GITHUB_ENV"';

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
      path: "e2e-artifacts/vitest/",
      "include-hidden-files": true,
    };

    const cleanup = job.steps.find((step) => step.name === "Clean up Docker auth");
    expect(cleanup).toBeDefined();
    cleanup!.if = "success()";
    cleanup!.run = 'set -euo pipefail\necho "missing Docker auth cleanup"\n';
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "tunnel-lifecycle-vitest job must not set DOCKER_CONFIG at job level",
          'step \'Configure isolated Docker auth directory\' run script must include echo "DOCKER_CONFIG=${RUNNER_TEMP}/docker-config-tunnel-lifecycle" >> "$GITHUB_ENV"',
          "step 'Configure isolated Docker auth directory' run script must not include ${{ github.workspace }}",
          "tunnel-lifecycle-vitest checkout step must set persist-credentials=false",
          "tunnel-lifecycle-vitest step 'Install root dependencies' env must not include NVIDIA_INFERENCE_API_KEY",
          "tunnel-lifecycle-vitest step 'Install root dependencies' env must not include NVIDIA_API_KEY",
          "step 'Install root dependencies' run script must include npm ci --ignore-scripts",
          "tunnel-lifecycle-vitest step 'Install and verify cloudflared prerequisite' env must not include NVIDIA_INFERENCE_API_KEY",
          "tunnel-lifecycle-vitest step 'Install and verify cloudflared prerequisite' env must not include NVIDIA_API_KEY",
          "tunnel-lifecycle-vitest cloudflared prerequisite step env must not include NVIDIA_INFERENCE_API_KEY",
          "tunnel-lifecycle-vitest cloudflared prerequisite step env must not include NVIDIA_API_KEY",
          "step 'Install and verify cloudflared prerequisite' run script must include test/e2e/lib/cloudflared-version-resolver.sh",
          "step 'Install and verify cloudflared prerequisite' run script must include sudo apt-get install -y",
          "step 'Install and verify cloudflared prerequisite' run script must include cloudflared=${cf_version}",
          "tunnel-lifecycle-vitest Vitest step must not run cloudflared APT installation with NVIDIA_INFERENCE_API_KEY in scope",
          "artifact upload path must include e2e-artifacts/vitest/tunnel-lifecycle/",
          "tunnel-lifecycle-vitest artifact upload must set include-hidden-files: false",
          "tunnel-lifecycle-vitest Docker auth cleanup must always run",
          "step 'Clean up Docker auth' run script must include docker logout docker.io",
          "step 'Clean up Docker auth' run script must include rm -rf \"${DOCKER_CONFIG}\"",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
