// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { Action, Job, Step, Workflow } from "./managed-image-publication-workflow-types";

export const repoRoot = path.resolve(import.meta.dirname, "../..");

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

export function step(job: Job, name: string): Step {
  return required(
    job.steps?.find((candidate) => candidate.name === name),
    `managed-image workflow is missing '${name}'`,
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
