// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

describe("Hermes E2E workflow boundary", () => {
  it("rejects hosted Hermes model and hermetic GPU-startup boundary drift", () => {
    const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8"));
    workflow.jobs["hermes-e2e"].env.NEMOCLAW_MODEL = "minimaxai/minimax-m2.7";
    const gpuJob = workflow.jobs["hermes-gpu-startup"];
    gpuJob["runs-on"] = "ubuntu-latest";
    gpuJob.if = "${{ always() }}";
    gpuJob.env.NEMOCLAW_DOCKER_GPU_PATCH = "1";
    gpuJob.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE = "1";
    gpuJob.env.UNRELATED_SECRET = "${{ github.ref == 'refs/heads/main' && secrets.FOO || '' }}";
    const gpuRun = gpuJob.steps.find(
      (step: { name?: string }) => step.name === "Run Hermes GPU startup live Vitest test",
    );
    gpuRun.env = {
      COMPATIBLE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    };
    gpuRun.run = "npx vitest run --project e2e-live test/e2e/live/hermes-e2e.test.ts";
    gpuJob.steps.push({
      name: "Unexpected hosted test",
      run: "npx vitest run --project e2e-live test/e2e/live/hermes-e2e.test.ts",
      with: { token: "${{ github.ref == 'refs/heads/main' && secrets.FOO || '' }}" },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    try {
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "hermes-e2e job must use the shared hosted-compatible model default",
          "hermes-gpu-startup job must run on the native RTX PRO 6000 GPU runner",
          "hermes-gpu-startup job must remain explicit-only behind generate-matrix",
          "hermes-gpu-startup job must leave NEMOCLAW_DOCKER_GPU_PATCH unset to exercise auto routing",
          "hermes-gpu-startup job env must not expose NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
          "hermes-gpu-startup job env must not consume repository secrets",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose COMPATIBLE_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NVIDIA_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NVIDIA_INFERENCE_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not consume repository secrets",
          "hermes-gpu-startup step must run the dedicated Hermes GPU startup test",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not run the hosted Hermes E2E test",
          "hermes-gpu-startup step 'Unexpected hosted test' must not run the hosted Hermes E2E test",
          "hermes-gpu-startup step 'Unexpected hosted test' must not consume repository secrets",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
