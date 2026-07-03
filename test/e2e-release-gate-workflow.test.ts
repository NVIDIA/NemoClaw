// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

const e2eWorkflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(".github/workflows/e2e.yaml");

describe("release gate workflow resource contracts", () => {
  it("starts hosted agent proofs in the first wave after matrix generation", () => {
    const fullJob = e2eWorkflow.jobs["full-e2e"];
    const tuiJob = e2eWorkflow.jobs["openclaw-tui-chat-correlation"];

    expect(fullJob.needs).toBe("generate-matrix");
    expect(fullJob.if).not.toContain("always()");
    expect(fullJob.if).toContain(",full-e2e,");
    expect(tuiJob.needs).toBe("generate-matrix");
    expect(tuiJob.if).not.toContain("always()");
    expect(tuiJob.if).toContain(",openclaw-tui-chat-correlation,");
  });

  it("budgets cold Ollama pulls in the consolidated GPU lane", () => {
    const gpuJob = e2eWorkflow.jobs["gpu-e2e"];
    const liveTest = readFileSync(new URL("./e2e/live/gpu-e2e.test.ts", import.meta.url), "utf8");

    expect(gpuJob["timeout-minutes"]).toBe(90);
    expect(gpuJob.env?.NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe("2400");
    expect(liveTest).toContain("timeoutMs: 55 * 60_000");
  });

  it("authenticates Spark image pulls through the shared guarded steps", () => {
    const steps = e2eWorkflow.jobs["spark-install"].steps ?? [];
    const stepIndex = (name: string) => steps.findIndex((step) => step.name === name);
    const auth = steps.find((step) => step.name === "Authenticate to Docker Hub");
    const cleanup = steps.find((step) => step.name === "Clean up Docker auth");

    expect(steps.some((step) => step.name === "Configure isolated Docker auth directory")).toBe(
      false,
    );
    expect(auth?.uses).toBeUndefined();
    expect(auth?.if).toBeUndefined();
    expect(auth?.["continue-on-error"]).toBeUndefined();
    expect(auth?.env).toHaveProperty("DOCKERHUB_AUTH_REQUIRED");
    expect(auth?.run).toEqual(expect.any(String));
    expect(stepIndex("Authenticate to Docker Hub")).toBeLessThan(
      stepIndex("Prepare E2E workspace"),
    );
    expect(stepIndex("Authenticate to Docker Hub")).toBeLessThan(
      stepIndex("Run Spark install live test"),
    );
    expect(cleanup?.if).toBe("always()");
    expect(cleanup?.run).toBe("bash .github/scripts/docker-auth-cleanup.sh");
    expect(stepIndex("Run Spark install live test")).toBeLessThan(
      stepIndex("Clean up Docker auth"),
    );
  });
});
