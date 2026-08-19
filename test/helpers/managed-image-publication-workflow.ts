// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { Action, Job, Step, Workflow } from "./managed-image-publication-workflow-types";

export const repoRoot = path.resolve(import.meta.dirname, "../..");

export const baseImagePublishers = [
  {
    agent: "hermes",
    displayName: "Hermes",
    dockerfile: "agents/hermes/Dockerfile.base",
    image: "nvidia/nemoclaw/hermes-sandbox-base",
    job: "build-and-push-hermes",
    amd64Job: "build-hermes-amd64",
    arm64Job: "build-hermes-arm64",
  },
  {
    agent: "langchain-deepagents-code",
    displayName: "Deep Agents Code",
    dockerfile: "agents/langchain-deepagents-code/Dockerfile.base",
    image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
    job: "build-and-push-dcode",
    amd64Job: "build-dcode-amd64",
    arm64Job: "build-dcode-arm64",
  },
  {
    agent: "openclaw",
    displayName: "OpenClaw",
    dockerfile: "Dockerfile.base",
    image: "nvidia/nemoclaw/sandbox-base",
    job: "build-and-push-openclaw",
    amd64Job: "build-openclaw-amd64",
    arm64Job: "build-openclaw-arm64",
  },
  {
    agent: "pi",
    displayName: "Pi",
    dockerfile: "agents/pi/Dockerfile.base",
    image: "nvidia/nemoclaw/pi-sandbox-base",
    job: "build-and-push-pi",
    amd64Job: "build-pi-amd64",
    arm64Job: "build-pi-arm64",
  },
] as const;

export const baseImagePlatformCallers = baseImagePublishers.flatMap(
  (publisher) =>
    [
      {
        ...publisher,
        arch: "amd64",
        job: publisher.amd64Job,
        openclawVersion:
          publisher.agent === "openclaw" ? "${{ inputs.openclaw_version }}" : undefined,
        platform: "linux/amd64",
        runner: "ubuntu-24.04",
      },
      {
        ...publisher,
        arch: "arm64",
        job: publisher.arm64Job,
        openclawVersion:
          publisher.agent === "openclaw" ? "${{ inputs.openclaw_version }}" : undefined,
        platform: "linux/arm64",
        runner: "ubuntu-24.04-arm",
      },
    ] as const,
);

export function readWorkflow(file: string): Workflow {
  return YAML.parse(
    fs.readFileSync(path.join(repoRoot, ".github", "workflows", file), "utf8"),
  ) as Workflow;
}

export function readAction(directory: string): Action {
  return YAML.parse(
    fs.readFileSync(path.join(repoRoot, ".github", "actions", directory, "action.yaml"), "utf8"),
  ) as Action;
}

export function required<T>(value: T | undefined, message: string): T {
  return (
    value ??
    (() => {
      throw new Error(message);
    })()
  );
}

export function step(job: Job, name: string, container = "managed-image workflow"): Step {
  return required(
    job.steps?.find((candidate) => candidate.name === name),
    `${container} is missing '${name}'`,
  );
}

export function managedPublisher(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["build-and-validate"],
    "managed-image workflow is missing its publisher",
  );
}

export function managedPromoter(workflow: Workflow): Job {
  return required(
    workflow.jobs?.promote,
    "managed-image workflow is missing its aggregate promoter",
  );
}
