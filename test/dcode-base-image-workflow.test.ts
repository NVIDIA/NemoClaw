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
const workflow = YAML.parse(
  fs.readFileSync(path.join(repoRoot, ".github", "workflows", "base-image.yaml"), "utf8"),
) as Workflow;
const dcodeManifest = YAML.parse(
  fs.readFileSync(
    path.join(repoRoot, "agents", "langchain-deepagents-code", "manifest.yaml"),
    "utf8",
  ),
) as { expected_version?: string };
const dcodeRequirementsLock = fs.readFileSync(
  path.join(repoRoot, "agents", "langchain-deepagents-code", "requirements.lock"),
  "utf8",
);

const publishers = [
  {
    jobName: "build-and-push",
    image: "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}",
    dockerfile: "Dockerfile.base",
    guardName: "Validate production Docker build args",
  },
  {
    jobName: "build-and-push-hermes",
    image: "${{ env.REGISTRY }}/nvidia/nemoclaw/hermes-sandbox-base",
    dockerfile: "agents/hermes/Dockerfile.base",
    guardName: "Validate Hermes production Docker build args",
  },
  {
    jobName: "build-and-push-langchain-deepagents-code",
    image: "${{ env.REGISTRY }}/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
    dockerfile: "agents/langchain-deepagents-code/Dockerfile.base",
    guardName: "Validate Deep Agents Code production Docker build args",
  },
] as const;

describe("Deep Agents Code base-image publication", () => {
  it("triggers its publisher whenever the DCode base inputs change (#6456)", () => {
    expect(workflow.on?.push?.paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/base-image.yaml",
        "agents/langchain-deepagents-code/Dockerfile.base",
        "agents/langchain-deepagents-code/manifest.yaml",
        "agents/langchain-deepagents-code/requirements.lock",
      ]),
    );
  });

  it("keeps DCode manifest expected_version in sync with the base-image lockfile and workflow trigger", () => {
    const lockedVersion = dcodeRequirementsLock.match(/^deepagents-code==([^\s\\]+)/m)?.[1];
    expect(lockedVersion).toBeDefined();
    expect(dcodeManifest.expected_version).toBe(lockedVersion);
    expect(workflow.on?.push?.paths).toContain("agents/langchain-deepagents-code/manifest.yaml");
  });

  it.each(publishers)("keeps $jobName as an independently guarded multi-arch publisher (#6456)", ({
    jobName,
    image,
    dockerfile,
    guardName,
  }) => {
    const job = workflow.jobs?.[jobName];
    expect(job).toMatchObject({
      if: "github.repository == 'NVIDIA/NemoClaw'",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 45,
    });
    const steps = job?.steps ?? [];
    const step = (name: string) => steps.find((candidate) => candidate.name === name);
    const metadata = step("Extract metadata");
    expect(metadata?.with).toMatchObject({
      images: image,
      tags: expect.stringContaining("type=ref,event=tag"),
    });
    expect(metadata?.with?.tags).toEqual(expect.stringContaining("type=raw,value=latest"));
    expect(metadata?.with?.tags).toEqual(expect.stringContaining("type=sha,prefix=,format=short"));
    for (const actionStep of steps.filter((candidate) => candidate.uses?.startsWith("docker/"))) {
      expect(actionStep.uses).toMatch(/^docker\/[^@]+@[0-9a-f]{40}$/);
    }

    const guardIndex = steps.findIndex((candidate) => candidate.name === guardName);
    const buildIndex = steps.findIndex((candidate) => candidate.name === "Build and push");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(buildIndex);
    expect(steps[guardIndex]?.run).toContain("scripts/check-production-build-args.sh");
    expect(steps[buildIndex]).toMatchObject({
      uses: "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
      with: {
        context: ".",
        file: dockerfile,
        platforms: "linux/amd64,linux/arm64",
        push: true,
        tags: "${{ steps.meta.outputs.tags }}",
        labels: "${{ steps.meta.outputs.labels }}",
      },
    });
  });
});
