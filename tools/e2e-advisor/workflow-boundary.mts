// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

interface AdvisorWorkflow {
  concurrency?: { group?: unknown };
  jobs?: { advise?: { if?: unknown } };
  on?: Record<string, unknown>;
}

const WORKFLOW_PATH = path.resolve(import.meta.dirname, "../../.github/workflows/e2e-advisor.yaml");

function readAdvisorWorkflow(): AdvisorWorkflow {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as AdvisorWorkflow;
}

/**
 * Validates the event split that keeps fork analysis on trusted workflow code.
 */
export function validateE2eAdvisorEventBoundary(
  workflow: AdvisorWorkflow = readAdvisorWorkflow(),
): string[] {
  const errors: string[] = [];
  const triggers = workflow.on ?? {};
  if (!Object.hasOwn(triggers, "pull_request")) {
    errors.push("E2E advisor must retain the pull_request trigger for first-party PRs");
  }
  if (!Object.hasOwn(triggers, "pull_request_target")) {
    errors.push("E2E advisor must retain the pull_request_target trigger for fork PRs");
  }

  const condition = workflow.jobs?.advise?.if;
  if (typeof condition !== "string") {
    errors.push("E2E advisor job must define an event trust-boundary condition");
  } else {
    for (const requiredFragment of [
      "github.repository == 'NVIDIA/NemoClaw'",
      "github.event_name == 'pull_request'",
      "github.event.pull_request.head.repo.full_name == 'NVIDIA/NemoClaw'",
      "github.event_name == 'pull_request_target'",
      "github.event.pull_request.head.repo.full_name != 'NVIDIA/NemoClaw'",
    ]) {
      if (!condition.includes(requiredFragment)) {
        errors.push(`E2E advisor job condition is missing: ${requiredFragment}`);
      }
    }
  }

  const concurrencyGroup = workflow.concurrency?.group;
  if (typeof concurrencyGroup !== "string" || !concurrencyGroup.includes("github.event_name")) {
    errors.push("E2E advisor concurrency must distinguish pull_request from pull_request_target");
  }
  return errors;
}
