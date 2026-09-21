// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

import { expect, it } from "vitest";

import { validatePrReviewAdvisorWorkflow } from "../../../tools/pr-review-advisor/workflow-boundary.mts";

const run = "${{ github.run_id }}";
const attempt = "${{ github.run_attempt }}";
const temp = "${{ runner.temp }}";
const matrix = "${{ matrix.advisor.artifact_name }}";

it("accepts the checked-in Advisor workflow", () => {
  expect(validatePrReviewAdvisorWorkflow()).toEqual([]);
});

const stages = [
  ["dispatchCheckout", "Checkout dispatch workspace (read-only data)"],
  ["defaultWorkdir", "Set default advisor workdir"],
  ["nodeSetup", "Setup Node"],
  ["npmSetup", "Install reviewed npm"],
  ["runtimeImage", "Load advisor runtime image"],
  ["preparation", "Prepare isolated analysis workspace"],
  ["removeSymlinks", "Remove symlinks from analysis workspace"],
  ["runtimeDownload", "Download trusted advisor runtime"],
  ["runtimeRestore", "Restore trusted advisor runtime"],
  ["contextDownload", "Download GitHub review context"],
  ["sandboxInputs", "Prepare advisor sandbox inputs"],
  ["openShellInstall", "Install OpenShell"],
  ["analysis", "Run advisor specialist lifecycle"],
];

it.each(stages.map(([stage]) => stage))(
  "publishes a host receipt from the workflow after %s failure",
  (failedStage) => {
    const directory = mkdtempSync(join(tmpdir(), "advisor-workflow-receipt-"));
    try {
      const job = YAML.parse(readFileSync(".github/workflows/pr-review-advisor.yaml", "utf8")).jobs[
        "review-specialists"
      ];
      const steps = job.steps as Array<{
        name: string;
        id?: string;
        if?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, string>;
      }>;
      const failure = steps.find((step) => step.name === "Preserve specialist failure status")!;
      const upload = steps.find((step) => step.name === "Upload specialist review")!;
      const expressions: Record<string, string> = {
        "${{ needs.require-green-checks.outputs.head_sha }}": "b".repeat(40),
      };
      const failedIndex = stages.findIndex(([stage]) => stage === failedStage);
      const expected = Object.fromEntries(
        stages.map(([stage], index) => [
          stage,
          index < failedIndex ? "success" : index === failedIndex ? "failure" : "skipped",
        ]),
      );
      Object.assign(
        expressions,
        Object.fromEntries(
          stages.flatMap(([stage, name]) => {
            const id = steps.find((step) => step.name === name)!.id;
            return [
              [`\${{ steps.${id}.outcome }}`, expected[stage]],
              [
                `\${{ steps.${id}.outputs.classification }}`,
                failedStage === "preparation" ? "superseded" : "",
              ],
            ];
          }),
        ),
      );
      expect(validatePrReviewAdvisorWorkflow()).toEqual([]);
      const artifact = "pr-review-specialist-test";
      const uploaded = join(
        directory,
        upload.with!.path.replace("${{ matrix.advisor.artifact_dir }}", artifact),
        "job-failure.json",
      );
      const result = spawnSync("/bin/bash", ["-c", failure.run! + ' && cat -- "$RECEIPT_PATH"'], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
        env: {
          PATH: dirname(process.execPath) + ":/usr/bin:/bin",
          ADVISOR_DIR: process.cwd(),
          GITHUB_WORKSPACE: directory,
          RECEIPT_PATH: uploaded,
          PR_REVIEW_ADVISOR_ARTIFACT_DIR: job.env.PR_REVIEW_ADVISOR_ARTIFACT_DIR.replace(
            "${{ matrix.advisor.artifact_dir }}",
            artifact,
          ),
          ...Object.fromEntries(
            Object.entries(failure.env!).map(([key, value]) => [key, expressions[value]]),
          ),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "failed",
        classification: failedStage === "preparation" ? "superseded" : "failed",
        expectedHeadSha: "b".repeat(40),
        steps: expected,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  [
    "failure receipt selection",
    "if: ${{ failure() }}",
    "if: ${{ success() }}",
    "Unified advisor failure receipt must run before upload after a failed step",
  ],
  [
    "failure receipt command",
    'run: node --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/failure-artifacts.mts"',
    'run: echo "$ADVISOR_DIR/tools/pr-review-advisor/failure-artifacts.mts"',
    "Unified advisor failure receipt must run before upload after a failed step",
  ],
  [
    "empty failure receipt command",
    'run: node --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/failure-artifacts.mts"',
    'run: ""',
    "Unified advisor failure receipt must run before upload after a failed step",
  ],
  [
    "failure receipt lifecycle outcome",
    "ADVISOR_ANALYSIS_OUTCOME: ${{ steps.specialist-analysis.outcome }}",
    "ADVISOR_ANALYSIS_OUTCOME: ${{ steps.prepare-analysis.outcome }}",
    "Unified advisor failure receipt must run before upload after a failed step",
  ],
  [
    "missing failure receipt lifecycle outcome",
    "          ADVISOR_ANALYSIS_OUTCOME: ${{ steps.specialist-analysis.outcome }}\n",
    "",
    "Unified advisor failure receipt must run before upload after a failed step",
  ],
  [
    "failed specialist upload",
    "if: ${{ always() && matrix.advisor.interest != '' }}",
    "if: ${{ success() }}",
    "Unified advisor failure receipt must run before upload after a failed step",
  ],
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
        id: sandbox-inputs
        env:
          BASE_REF: \${{ needs.require-green-checks.outputs.pr_number != '' && 'target/base' || needs.require-green-checks.outputs.base_sha }}
          HEAD_REF: \${{ needs.require-green-checks.outputs.pr_number != '' && 'HEAD' || needs.require-green-checks.outputs.head_sha }}`,
    `      - name: Prepare advisor sandbox inputs
        id: sandbox-inputs
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
    "coordinator shadow dependency",
    "needs: [require-green-checks, build-advisor-runtime, review-specialists, advisor-blockers]",
    "needs: [require-green-checks, build-advisor-runtime, review-specialists]",
    "Unified advisor coordinator shadow must remain read-only and exact-head bound",
  ],
  [
    "coordinator shadow evidence",
    'run: node --no-warnings "$ADVISOR_DIR/tools/pr-review-coordinator/shadow.mts"',
    'run: echo "$ADVISOR_DIR/tools/pr-review-coordinator/shadow.mts"',
    "Unified advisor coordinator shadow must consume exact-attempt trusted evidence",
  ],
  [
    "coordinator upload step",
    "- name: Upload coordinator shadow decision",
    "- name: Upload coordinator result",
    "Unified advisor coordinator shadow must retain its decision artifact",
  ],
  [
    "coordinator upload action",
    "uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: pr-review-coordinator-shadow-",
    "uses: actions/download-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: pr-review-coordinator-shadow-",
    "Unified advisor coordinator shadow must retain its decision artifact",
  ],
  [
    "coordinator upload name",
    "name: pr-review-coordinator-shadow-${{ github.run_attempt }}",
    "name: pr-review-coordinator-result-${{ github.run_attempt }}",
    "Unified advisor coordinator shadow must retain its decision artifact",
  ],
  [
    "coordinator upload path",
    "path: artifacts/pr-review-coordinator-shadow/decision.json",
    "path: artifacts/pr-review-coordinator-shadow/missing.json",
    "Unified advisor coordinator shadow must retain its decision artifact",
  ],
  [
    "coordinator upload absence",
    "path: artifacts/pr-review-coordinator-shadow/decision.json\n          if-no-files-found: error",
    "path: artifacts/pr-review-coordinator-shadow/decision.json\n          if-no-files-found: warn",
    "Unified advisor coordinator shadow must retain its decision artifact",
  ],
  [
    "publisher after blocker gate",
    "needs: [require-green-checks, review-specialists, advisor-blockers, coordinator-shadow]",
    "needs: [require-green-checks, review-specialists, coordinator-shadow]",
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
