// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "codebase-growth-guardrails.yaml");
const STATIC_ACTION_PATH = join(ROOT, ".github", "actions", "ci-static-checks", "action.yaml");
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const TEST_COMMAND =
  "set -euo pipefail\nnpx vitest run --project integration test/automation/pull-requests/growth-guardrails.test.ts";
const STATIC_COMMAND =
  "npx prek run --all-files --stage pre-commit \\\n  --skip source-shape-test-budget \\\n  --skip test-skills-yaml";

type Value = Record<string, unknown>;

function object(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function same(value: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(value, expected);
}

export function validateGrowthGuardrailsWorkflowBoundary(
  workflowSource = readFileSync(WORKFLOW_PATH, "utf8"),
  staticActionSource = readFileSync(STATIC_ACTION_PATH, "utf8"),
): string[] {
  let workflow: Value;
  let action: Value;
  try {
    workflow = object(YAML.parse(workflowSource));
    action = object(YAML.parse(staticActionSource));
  } catch {
    return ["growth guardrail workflow configuration must be valid YAML"];
  }

  const expectedWorkflow = {
    name: "Governance / Enforce Codebase Growth Limits",
    on: {
      pull_request_target: { types: ["opened", "reopened", "synchronize", "ready_for_review"] },
    },
    permissions: { contents: "read", "pull-requests": "read" },
    jobs: {
      "codebase-growth-guardrails": {
        name: "codebase-growth-guardrails",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [
          {
            name: "Check out the trusted base revision",
            uses: CHECKOUT,
            with: {
              ref: "${{ github.event.pull_request.base.sha }}",
              "persist-credentials": false,
            },
          },
          {
            name: "Install trusted dependencies",
            run: "npm ci --ignore-scripts --no-audit --no-fund",
          },
          {
            name: "Test codebase growth guardrails",
            env: {
              NEMOCLAW_GROWTH_PR: "1",
              GH_TOKEN: "${{ github.token }}",
              PR_NUMBER: "${{ github.event.pull_request.number }}",
              REPO: "${{ github.repository }}",
              BASE_SHA: "${{ github.event.pull_request.base.sha }}",
              HEAD_REPO: "${{ github.event.pull_request.head.repo.full_name }}",
              HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
            },
            run: TEST_COMMAND + "\n",
          },
        ],
      },
    },
  };
  const normalizedWorkflow: Value = { ...workflow, on: workflow.on ?? workflow.true };
  delete normalizedWorkflow.true;
  const errors: string[] = [];
  if (!same(normalizedWorkflow, expectedWorkflow)) {
    errors.push("growth guardrail workflow must match the reviewed trust boundary");
  }

  const staticSteps = array(object(action.runs).steps).map(object);
  const namedStaticSteps = staticSteps.filter((step) => step.name === "Run static hook checks");
  if (
    namedStaticSteps.length !== 1 ||
    !same(namedStaticSteps[0], {
      name: "Run static hook checks",
      shell: "bash",
      run: STATIC_COMMAND + "\n",
    })
  ) {
    errors.push("static action must retain the reviewed hook-check step");
  }
  if (JSON.stringify(action).includes("test-size:check")) {
    errors.push("static checks must not recursively invoke test-size:check");
  }
  return errors;
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] === currentModule) {
  const errors = validateGrowthGuardrailsWorkflowBoundary();
  if (errors.length > 0) {
    errors.forEach((error) => console.error(error));
    process.exit(1);
  }
  console.log("Codebase growth guardrail workflow boundary passed.");
}
