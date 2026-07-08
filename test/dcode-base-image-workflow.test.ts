// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: { push?: { paths?: string[] } };
  jobs?: Record<string, WorkflowJob>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("Deep Agents Code base-image publication", () => {
  it("publishes the multi-arch base image whenever its inputs change (#6456)", () => {
    const workflow = YAML.parse(
      fs.readFileSync(path.join(repoRoot, ".github", "workflows", "base-image.yaml"), "utf8"),
    ) as Workflow;
    expect(workflow.on?.push?.paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/base-image.yaml",
        "agents/langchain-deepagents-code/Dockerfile.base",
        "agents/langchain-deepagents-code/requirements.lock",
      ]),
    );

    const job = workflow.jobs?.["build-and-push-langchain-deepagents-code"];
    expect(job).toMatchObject({
      if: "github.repository == 'NVIDIA/NemoClaw'",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 45,
    });
    const steps = job?.steps ?? [];
    const step = (name: string) => steps.find((candidate) => candidate.name === name);
    const metadata = step("Extract metadata");
    expect(metadata?.with).toMatchObject({
      images: "${{ env.REGISTRY }}/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
      tags: expect.stringContaining("type=ref,event=tag"),
    });
    expect(metadata?.with?.tags).toEqual(expect.stringContaining("type=raw,value=latest"));
    expect(metadata?.with?.tags).toEqual(expect.stringContaining("type=sha,prefix=,format=short"));

    const guardIndex = steps.findIndex(
      (candidate) => candidate.name === "Validate Deep Agents Code production Docker build args",
    );
    const buildIndex = steps.findIndex((candidate) => candidate.name === "Build and push");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(buildIndex);
    expect(steps[guardIndex]?.run).toContain("scripts/check-production-build-args.sh");
    expect(steps[buildIndex]).toMatchObject({
      uses: "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
      with: {
        context: ".",
        file: "agents/langchain-deepagents-code/Dockerfile.base",
        platforms: "linux/amd64,linux/arm64",
        push: true,
        tags: "${{ steps.meta.outputs.tags }}",
        labels: "${{ steps.meta.outputs.labels }}",
      },
    });
  });
});
