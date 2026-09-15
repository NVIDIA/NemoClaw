// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { validatePrReviewAdvisorWorkflow } from "../../../tools/pr-review-advisor/workflow-boundary.mts";

const run = "${{ github.run_id }}";
const attempt = "${{ github.run_attempt }}";
const temp = "${{ runner.temp }}";
const matrix = "${{ matrix.advisor.artifact_name }}";

it("accepts the checked-in Advisor workflow", () => {
  expect(validatePrReviewAdvisorWorkflow()).toEqual([]);
});

it.each([
  [
    "context attempt suffix",
    `pr-review-advisor-context-${run}\n`,
    `pr-review-advisor-context-${run}-${attempt}\n`,
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "context name attempt suffix",
    `name: pr-review-advisor-context-${run}\n          path: ${temp}`,
    `name: pr-review-advisor-context-${run}-${attempt}\n          path: ${temp}`,
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "context overwrite",
    "overwrite: true",
    "overwrite: false",
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "specialist attempt suffix",
    `${matrix}-${attempt}`,
    matrix,
    "Unified advisor specialist artifacts must be unique per rerun attempt",
  ],
  [
    "successful CI requirement",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.conclusion == 'failure'",
    "Unified advisor green checks gate must require",
  ],
  [
    "successful CI bypass",
    "endsWith(github.event.workflow_run.display_title, ' gate true')))",
    "(endsWith(github.event.workflow_run.display_title, ' gate true') || true)))",
    "Unified advisor green checks gate must require",
  ],
  [
    "dependent job bypass",
    "if: ${{ github.repository == 'NVIDIA/NemoClaw' }}",
    "if: ${{ always() && github.repository == 'NVIDIA/NemoClaw' }}",
    "Unified advisor entry jobs must retain fail-closed conditions",
  ],
  [
    "source run identity",
    "format('Advisor after {0}', github.event.workflow_run.display_title)",
    "'Advisor after an unknown run'",
    "Unified advisor must retain completed CI / Pull Request identity",
  ],
  [
    "manual revision output",
    "steps.target.outputs.head_sha || steps.manual-target.outputs.head_sha",
    "steps.target.outputs.head_sha",
    "Unified advisor green checks gate must expose the checked PR revision",
  ],
  [
    "manual PR identity",
    '.state == "open" and .base.repo.full_name == $repo and .base.ref == $base',
    '.state == "open"',
    "Unified advisor manual dispatch must retain",
  ],
  [
    "gate dependency",
    "needs: require-green-checks",
    "needs: []",
    "Unified advisor entry jobs must depend on the green checks gate",
  ],
  [
    "source commit binding",
    ".head.sha == $sha",
    ".head.sha != $sha",
    "Unified advisor green checks gate must retain .head.sha == $sha",
  ],
  [
    "source base binding",
    ".base.sha == $base_sha",
    ".base.sha != $base_sha",
    "Unified advisor green checks gate must retain .base.sha == $base_sha",
  ],
  [
    "analysis commit binding",
    "needs.require-green-checks.outputs.head_sha || ''",
    "needs.require-green-checks.outputs.base_sha || ''",
    "Unified advisor must prepare the resolved PR revision",
  ],
  [
    "manual PR base binding",
    "needs.require-green-checks.outputs.pr_number != '' && needs.require-green-checks.outputs.base_sha || ''",
    "github.event_name == 'workflow_run' && needs.require-green-checks.outputs.base_sha || ''",
    "Unified advisor must prepare the resolved PR revision",
  ],
  [
    "manual PR head binding",
    "needs.require-green-checks.outputs.pr_number != '' && needs.require-green-checks.outputs.head_sha || ''",
    "github.event_name == 'workflow_run' && needs.require-green-checks.outputs.head_sha || ''",
    "Unified advisor must prepare the resolved PR revision",
  ],
  [
    "ref dispatch checkout",
    "ref: ${{ needs.require-green-checks.outputs.head_sha }}",
    "ref: ${{ github.sha }}",
    "Unified advisor ref dispatch must check out the resolved head SHA",
  ],
  [
    "ref dispatch base analysis",
    "needs.require-green-checks.outputs.pr_number != '' && 'target/base' || needs.require-green-checks.outputs.base_sha",
    "needs.require-green-checks.outputs.pr_number != '' && 'target/base' || inputs.base_ref",
    "Unified advisor specialists must analyze the resolved revisions",
  ],
  [
    "ref dispatch head analysis",
    "needs.require-green-checks.outputs.pr_number != '' && 'HEAD' || needs.require-green-checks.outputs.head_sha",
    "needs.require-green-checks.outputs.pr_number != '' && 'HEAD' || inputs.head_ref",
    "Unified advisor specialists must analyze the resolved revisions",
  ],
  [
    "ref dispatch sandbox inputs",
    `      - name: Prepare advisor sandbox inputs
        env:
          BASE_REF: \${{ needs.require-green-checks.outputs.pr_number != '' && 'target/base' || needs.require-green-checks.outputs.base_sha }}
          HEAD_REF: \${{ needs.require-green-checks.outputs.pr_number != '' && 'HEAD' || needs.require-green-checks.outputs.head_sha }}`,
    `      - name: Prepare advisor sandbox inputs
        env:
          BASE_REF: \${{ needs.require-green-checks.outputs.pr_number != '' && 'target/base' || needs.require-green-checks.outputs.base_sha }}
          HEAD_REF: \${{ needs.require-green-checks.outputs.pr_number != '' && 'HEAD' || inputs.head_ref }}`,
    "Unified advisor specialists must analyze the resolved revisions",
  ],
  [
    "blocker gate dependency",
    "needs: [require-green-checks, build-advisor-runtime, review-specialists]",
    "needs: [require-green-checks, build-advisor-runtime]",
    "Unified advisor blocker gate must fail closed after every specialist",
  ],
  [
    "blocker artifact attempt binding",
    "pattern: pr-review-specialist-*-${{ github.run_attempt }}",
    "pattern: pr-review-specialist-*",
    "Unified advisor blocker gate must validate exact-attempt specialist evidence",
  ],
  [
    "blocker artifact input",
    "PR_REVIEW_ADVISOR_ARTIFACTS: ${{ runner.temp }}/pr-review-specialists",
    "PR_REVIEW_ADVISOR_ARTIFACTS: ''",
    "Unified advisor blocker gate must validate exact-attempt specialist evidence",
  ],
  [
    "blocker executable command",
    'run: node --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/blocker-gate.mts" --attempt "$GITHUB_RUN_ATTEMPT"',
    'run: echo "$ADVISOR_DIR/tools/pr-review-advisor/blocker-gate.mts"',
    "Unified advisor blocker gate must validate exact-attempt specialist evidence",
  ],
  [
    "publisher after blocker gate",
    "needs: [require-green-checks, review-specialists, advisor-blockers]",
    "needs: [require-green-checks, review-specialists]",
    "Unified advisor publisher must run after a red blocker gate",
  ],
  [
    "publisher always condition",
    "if: ${{ always() && github.event_name == 'workflow_run' && needs.review-specialists.result == 'success' }}",
    "if: ${{ github.event_name == 'workflow_run' && needs.review-specialists.result == 'success' }}",
    "Unified advisor publisher must run after a red blocker gate",
  ],
])("rejects an unsafe Advisor %s mutation", (_case, before, after, error) => {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-pr-review-advisor-"));
  const advisorPath = join(directory, "advisor.yaml");
  try {
    const source = readFileSync(
      join(process.cwd(), ".github/workflows/pr-review-advisor.yaml"),
      "utf8",
    );
    writeFileSync(advisorPath, source.replace(before, after));
    expect(validatePrReviewAdvisorWorkflow(advisorPath)).toEqual(
      expect.arrayContaining([expect.stringContaining(error)]),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
