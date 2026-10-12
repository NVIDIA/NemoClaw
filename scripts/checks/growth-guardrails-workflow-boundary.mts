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
const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const TEST_COMMAND =
  "set -euo pipefail\nnpx vitest run --project integration test/automation/pull-requests/growth-guardrails.test.ts";
const STATIC_COMMAND =
  "npx prek run --all-files --stage pre-commit \\\n  --skip source-shape-test-budget \\\n  --skip test-skills-yaml";

export const APPROVAL_REFRESH_START = `const record = value => typeof value === "string" && value.includes("NemoClaw-E2E-Growth:");
const isComment = context.eventName === "issue_comment";
if (!isComment && context.eventName !== "pull_request_target") throw new Error("Unexpected approval event");
if (isComment && !record(context.payload.comment?.body) && !record(context.payload.changes?.body?.from)) return;
const number = isComment ? context.payload.issue?.number : context.payload.pull_request?.number;
if ((isComment && !context.payload.issue?.pull_request) || !Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid approval PR identity");
if (context.repo.owner !== "NVIDIA" || context.repo.repo !== "NemoClaw") throw new Error("Unexpected approval repository");
const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
if (pr.state !== "open") return;
if (pr.base.repo.full_name !== "NVIDIA/NemoClaw" || pr.base.ref !== context.payload.repository.default_branch) throw new Error("Unexpected approval base");
if (!/^[a-f0-9]{40}$/.test(pr.head.sha) || !/^[a-f0-9]{40}$/.test(pr.base.sha)) throw new Error("Invalid approval commit");
await github.rest.repos.createCommitStatus({
  ...context.repo, sha: pr.head.sha, context: "checks", state: "pending",
  description: "Independent growth policy is being checked",
  target_url: context.serverUrl + "/" + context.repo.owner + "/" + context.repo.repo + "/actions/runs/" + context.runId,
});
core.setOutput("pr_number", String(number));
core.setOutput("base_sha", pr.base.sha);
core.setOutput("head_sha", pr.head.sha);
`;

export const APPROVAL_REFRESH_FINISH = `const sha = process.env.APPROVAL_HEAD_SHA;
if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Invalid approval status commit");
const passed = process.env.APPROVAL_CHECK_OUTCOME === "success";
await github.rest.repos.createCommitStatus({
  ...context.repo, sha, context: "checks", state: passed ? "success" : "failure",
  description: passed ? "Current budget approval and growth checks passed" : "Budget approval refresh failed or did not complete",
  target_url: context.serverUrl + "/" + context.repo.owner + "/" + context.repo.repo + "/actions/runs/" + context.runId,
});
`;

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
      issue_comment: {
        types: ["created", "edited", "deleted"],
      },
      pull_request_target: {
        types: ["opened", "reopened", "synchronize", "ready_for_review", "edited"],
      },
    },
    permissions: {
      contents: "read",
      "pull-requests": "read",
    },
    jobs: {
      "codebase-growth-guardrails": {
        if: "${{ (github.event_name == 'pull_request_target' && github.event.pull_request.base.ref == github.event.repository.default_branch) || (github.event_name == 'issue_comment' && github.event.issue.pull_request && (contains(github.event.comment.body, 'NemoClaw-E2E-Growth:') || contains(github.event.changes.body.from, 'NemoClaw-E2E-Growth:'))) }}",
        concurrency: {
          group:
            "growth-guardrails-${{ github.event.pull_request.number || github.event.issue.number }}",
          "cancel-in-progress": false,
        },
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        permissions: {
          contents: "read",
          "pull-requests": "read",
          statuses: "write",
        },
        steps: [
          {
            name: "Invalidate the required independent growth status",
            id: "approval",
            uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
            with: {
              script: APPROVAL_REFRESH_START,
            },
          },
          {
            name: "Check out the trusted base revision",
            if: "${{ steps.approval.outputs.head_sha != '' }}",
            uses: CHECKOUT,
            with: {
              ref: "${{ steps.approval.outputs.base_sha }}",
              "persist-credentials": false,
            },
          },
          {
            name: "Set up Node.js",
            if: "${{ steps.approval.outputs.head_sha != '' }}",
            uses: SETUP_NODE,
            with: {
              "node-version": "24.18.1",
            },
          },
          {
            name: "Install reviewed npm",
            if: "${{ steps.approval.outputs.head_sha != '' }}",
            uses: "./.github/actions/setup-reviewed-npm",
          },
          {
            name: "Install trusted dependencies",
            if: "${{ steps.approval.outputs.head_sha != '' }}",
            run: "npm ci --ignore-scripts --no-audit --no-fund",
          },
          {
            name: "Recheck current budget approval and growth",
            id: "growth",
            if: "${{ steps.approval.outputs.head_sha != '' }}",
            env: {
              GH_TOKEN: "${{ github.token }}",
              PR_NUMBER: "${{ steps.approval.outputs.pr_number }}",
              BASE_SHA: "${{ steps.approval.outputs.base_sha }}",
              HEAD_SHA: "${{ steps.approval.outputs.head_sha }}",
            },
            run: TEST_COMMAND + "\n",
          },
          {
            name: "Report the refreshed budget approval status",
            if: "${{ always() && steps.approval.outputs.head_sha != '' }}",
            uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
            env: {
              APPROVAL_HEAD_SHA: "${{ steps.approval.outputs.head_sha }}",
              APPROVAL_CHECK_OUTCOME: "${{ steps.growth.outcome }}",
            },
            with: {
              script: APPROVAL_REFRESH_FINISH,
            },
          },
        ],
        name: "codebase-growth-guardrails",
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
