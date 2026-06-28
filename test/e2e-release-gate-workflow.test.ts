// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  loadE2eWorkflowContract,
  readYaml,
  type WorkflowJob,
} from "./helpers/e2e-workflow-contract";

const { nightlyWorkflow } = loadE2eWorkflowContract();
const vitestWorkflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(
  ".github/workflows/e2e-vitest-scenarios.yaml",
);

describe("release gate workflow resource contracts", () => {
  it("serializes hosted agent proofs after peak hosted lifecycle jobs", () => {
    const cloudJob = nightlyWorkflow.jobs["cloud-e2e"];
    const tuiJob = nightlyWorkflow.jobs["openclaw-tui-chat-correlation-e2e"];
    const peakDependencies = [
      "token-rotation-e2e",
      "channels-stop-start-openclaw-e2e",
      "channels-stop-start-hermes-e2e",
    ];

    expect(cloudJob.needs).toEqual(expect.arrayContaining(peakDependencies));
    expect(cloudJob.needs).toHaveLength(peakDependencies.length);
    expect(cloudJob.if).toContain("always()");
    expect(cloudJob.if).toContain(",cloud-e2e,");
    const tuiDependencies = [...peakDependencies, "cloud-e2e"];
    expect(tuiJob.needs).toEqual(expect.arrayContaining(tuiDependencies));
    expect(tuiJob.needs).toHaveLength(tuiDependencies.length);
    expect(tuiJob.if).toContain("always()");
    expect(tuiJob.if).toContain(",openclaw-tui-chat-correlation-e2e,");
    for (const dependency of tuiDependencies)
      expect(nightlyWorkflow.jobs).toHaveProperty(dependency);
  });

  it("budgets cold Ollama pulls in both retained and Vitest GPU lanes", () => {
    const nightlyJob = nightlyWorkflow.jobs["gpu-e2e"];
    const vitestJob = vitestWorkflow.jobs["gpu-e2e-vitest"];
    const liveTest = readFileSync(
      new URL("./e2e-scenario/live/gpu-e2e.test.ts", import.meta.url),
      "utf8",
    );

    expect(nightlyJob["timeout-minutes"]).toBe(60);
    expect(nightlyJob.env?.NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe("2400");
    expect(vitestJob["timeout-minutes"]).toBe(90);
    expect(vitestJob.env?.NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe("2400");
    expect(liveTest).toContain("timeoutMs: 55 * 60_000");
  });

  it("authenticates Spark image pulls with an isolated Docker config", () => {
    const steps = vitestWorkflow.jobs["spark-install-vitest"].steps ?? [];
    const stepIndex = (name: string) => steps.findIndex((step) => step.name === name);
    const configure = steps.find(
      (step) => step.name === "Configure isolated Docker auth directory",
    );
    const auth = steps.find((step) => step.name === "Authenticate to Docker Hub");
    const cleanup = steps.find((step) => step.name === "Clean up Docker auth");

    expect(configure?.run).toBe(
      'echo "DOCKER_CONFIG=${RUNNER_TEMP}/docker-config-spark-install" >> "$GITHUB_ENV"',
    );
    expect(auth?.uses).toBe("docker/login-action@650006c6eb7dba73a995cc03b0b2d7f5ca915bee");
    expect(auth?.if).toBe("github.ref == 'refs/heads/main'");
    expect(auth?.["continue-on-error"]).toBe(true);
    expect(auth?.with).toMatchObject({
      registry: "docker.io",
      username: "${{ secrets.DOCKERHUB_USERNAME }}",
      password: "${{ secrets.DOCKERHUB_TOKEN }}",
    });
    expect(auth?.env).toBeUndefined();
    expect(auth?.run).toBeUndefined();
    expect(stepIndex("Configure isolated Docker auth directory")).toBeLessThan(
      stepIndex("Authenticate to Docker Hub"),
    );
    expect(stepIndex("Authenticate to Docker Hub")).toBeLessThan(
      stepIndex("Run Spark install live test"),
    );
    expect(cleanup?.if).toBe("always()");
    expect(cleanup?.run).toContain(
      '"${DOCKER_CONFIG}" == "${RUNNER_TEMP}/docker-config-spark-install"',
    );
    expect(cleanup?.run).toContain("docker logout docker.io || true");
    expect(cleanup?.run).toContain('rm -rf -- "${DOCKER_CONFIG}"');
  });
});
