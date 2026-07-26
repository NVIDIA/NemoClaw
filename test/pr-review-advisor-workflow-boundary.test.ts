// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { runPrReviewAdvisorAnalysis } from "../tools/pr-review-advisor/run-analysis.mts";
import {
  fetchLivePullFromGh,
  validateAdvisorArtifacts,
} from "../tools/pr-review-advisor/validate-artifacts.mts";
import { validatePrReviewAdvisorWorkflowBoundary } from "../tools/pr-review-advisor/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/pr-review-advisor.yaml");
const HEAD_SHA = "b".repeat(40);
const BASE_SHA = "a".repeat(40);
const CAN_CREATE_SYMLINKS = canCreateSymlinks();
const CAN_RUN_BASH = canRunBash();

type Workflow = {
  on?: { pull_request_target?: { types?: string[] } };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, { if?: string; steps?: Array<{ name?: string; run?: string }> }>;
};

function workflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

function workflowStepScript(job: string, name: string): string {
  const workflow = YAML.parse(workflowSource()) as Workflow;
  const step = workflow.jobs?.[job]?.steps?.find((candidate) => candidate.name === name);
  expect(step?.run).toEqual(expect.any(String));
  return step!.run!;
}

function validateMutation(mutate: (source: string) => string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-boundary-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  fs.writeFileSync(workflowPath, mutate(workflowSource()));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeFakeCommand(binDir: string, name: string): void {
  fs.writeFileSync(
    path.join(binDir, name),
    `#!/bin/bash\nprintf '${name} %s\\n' "$*" >> "$CALL_LOG"\n`,
    { mode: 0o755 },
  );
}

function writeOptionalFixture(omitted: boolean | undefined, write: () => void): void {
  const selectedWrite = omitted ? undefined : write;
  selectedWrite?.();
}

function restoreEnv(key: string, value: string | undefined): void {
  value === undefined ? delete process.env[key] : (process.env[key] = value);
}

function canCreateSymlinks(): boolean {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-symlink-check-"));
  try {
    const target = path.join(tmp, "target.txt");
    const link = path.join(tmp, "link.txt");
    fs.writeFileSync(target, "target");
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function canRunBash(): boolean {
  return spawnSync("/bin/bash", ["-c", "true"]).status === 0;
}

function mutateWorkflowSource(
  source: string,
  mutate: (workflow: Record<string, any>) => void,
): string {
  const workflow = YAML.parse(source) as Record<string, any>;
  mutate(workflow);
  return YAML.stringify(workflow);
}

function workflowTriggers(workflow: Record<string, any>): Record<string, any> {
  return (workflow.on ?? workflow.true) as Record<string, any>;
}

function addDownloadRunId(source: string, stepName: string): string {
  return mutateWorkflowSource(source, (workflow) => {
    const step = workflow.jobs.publish.steps.find(
      (candidate: { name?: string }) => candidate.name === stepName,
    );
    expect(step).toBeDefined();
    step.with = { ...(step.with ?? {}), "run-id": "${{ github.event.workflow_run.id }}" };
  });
}

function setPublishStepContinueOnError(
  source: string,
  stepName: string,
  continueOnError: boolean,
): string {
  return mutateWorkflowSource(source, (workflow) => {
    const step = workflow.jobs.publish.steps.find(
      (candidate: { name?: string }) => candidate.name === stepName,
    );
    expect(step).toBeDefined();
    step["continue-on-error"] = continueOnError;
  });
}

function runArtifactValidation(
  result: unknown,
  options: {
    analysisResult?: unknown;
    summary?: string;
    liveHead?: string;
    liveBase?: string;
    omitAnalysisResult?: boolean;
    omitSummary?: boolean;
    symlinkAnalysisResult?: boolean;
    symlinkResult?: boolean;
    secondaryResult?: unknown;
    secondaryAnalysisResult?: unknown;
    secondarySummary?: string;
    secondaryDownloadOutcome?: "success" | "failure" | "unexpected";
    omitSecondaryArtifact?: boolean;
    omitSecondarySummary?: boolean;
    symlinkSecondaryResult?: boolean;
  } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-publish-"));
  const artifactDir = path.join(tmp, "artifacts");
  const secondaryArtifactDir = path.join(tmp, "secondary-artifacts");
  const analysisResultPath = path.join(artifactDir, "pr-review-advisor-result.json");
  const analysisResultFixturePath = path.join(tmp, "analysis-result-fixture.json");
  const resultPath = path.join(artifactDir, "pr-review-advisor-final-result.json");
  const resultFixturePath = path.join(tmp, "result-fixture.json");
  const secondaryResult = options.secondaryResult ?? validPrimaryResult();
  const secondaryResultPath = path.join(
    secondaryArtifactDir,
    "pr-review-advisor-final-result.json",
  );
  const secondaryResultFixturePath = path.join(tmp, "secondary-result-fixture.json");
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(resultFixturePath, `${JSON.stringify(result)}\n`);
  options.symlinkResult
    ? fs.symlinkSync(resultFixturePath, resultPath)
    : fs.copyFileSync(resultFixturePath, resultPath);
  writeOptionalFixture(options.omitAnalysisResult, () => {
    fs.writeFileSync(
      analysisResultFixturePath,
      `${JSON.stringify(options.analysisResult ?? result)}\n`,
    );
    options.symlinkAnalysisResult
      ? fs.symlinkSync(analysisResultFixturePath, analysisResultPath)
      : fs.copyFileSync(analysisResultFixturePath, analysisResultPath);
  });
  writeOptionalFixture(options.omitSummary, () => {
    fs.writeFileSync(
      path.join(artifactDir, "pr-review-advisor-summary.md"),
      options.summary ?? "# PR Review Advisor\n",
    );
  });
  writeOptionalFixture(options.omitSecondaryArtifact, () => {
    fs.mkdirSync(secondaryArtifactDir);
    fs.writeFileSync(secondaryResultFixturePath, `${JSON.stringify(secondaryResult)}\n`);
    options.symlinkSecondaryResult
      ? fs.symlinkSync(secondaryResultFixturePath, secondaryResultPath)
      : fs.copyFileSync(secondaryResultFixturePath, secondaryResultPath);
    fs.writeFileSync(
      path.join(secondaryArtifactDir, "pr-review-advisor-result.json"),
      `${JSON.stringify(options.secondaryAnalysisResult ?? secondaryResult)}\n`,
    );
    writeOptionalFixture(options.omitSecondarySummary, () => {
      fs.writeFileSync(
        path.join(secondaryArtifactDir, "pr-review-advisor-summary.md"),
        options.secondarySummary ?? "# PR Review Advisor (second opinion)\n",
      );
    });
  });
  const output: string[] = [];
  const warnings: string[] = [];
  let error: unknown;
  const originalConsoleError = console.error;
  try {
    console.error = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    validateAdvisorArtifacts(
      {
        repository: "NVIDIA/NemoClaw",
        prNumber: "6736",
        expectedHeadSha: HEAD_SHA,
        expectedBaseSha: BASE_SHA,
        trustedWorkflowSha: "c".repeat(40),
        primaryArtifactDir: artifactDir,
        secondaryArtifactDir,
        secondaryArtifactOutcome: options.secondaryDownloadOutcome ?? "success",
        maxResultBytes: 2_097_152,
        maxSummaryBytes: 1_048_576,
      },
      {
        fetchLivePull: () => ({
          headSha: options.liveHead ?? HEAD_SHA,
          baseSha: options.liveBase ?? BASE_SHA,
        }),
        appendOutput: (key, value) => output.push(`${key}=${value}\n`),
      },
    );
  } catch (caught) {
    error = caught;
  } finally {
    console.error = originalConsoleError;
  }
  return {
    status: error ? 1 : 0,
    stderr: error instanceof Error ? error.message : warnings.join("\n"),
    stdout: error instanceof Error ? error.message : "",
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    githubOutput: output.join(""),
  };
}

function validPrimaryResult(): Record<string, unknown> {
  return {
    version: 1,
    baseRef: "target/base",
    headRef: "HEAD",
    headSha: HEAD_SHA,
    changedFiles: [],
    summary: validSummary(),
    findings: [],
    acceptanceCoverage: [],
    securityCategories: [],
    sourceOfTruthReview: [],
    e2e: {
      coverage: {
        classifiedDomains: [],
        requiredTests: [],
        optionalTests: [],
        newE2eRecommendations: [],
        noE2eReason: "No changed files require E2E coverage.",
        confidence: "high",
      },
      targets: {
        relevantChangedFiles: [],
        changedCredentialFreeTests: [],
        required: [],
        optional: [],
        noTargetE2eReason: "No changed files require target E2E coverage.",
        confidence: "high",
      },
    },
    testDepth: {
      verdict: "unit_sufficient",
      rationale: "Boundary helper coverage is sufficient for this fixture.",
      suggestedTests: [],
    },
    positives: [],
    reviewCompleteness: { limitations: [], requiresHumanReview: true },
  };
}

function validSummary(
  overrides: Partial<Record<"recommendation" | "confidence" | "oneLine", string>> = {},
) {
  return {
    recommendation: "info_only",
    confidence: "high",
    oneLine: "No actionable findings.",
    ...overrides,
  };
}

function validFinding(overrides: Record<string, unknown> = {}) {
  return {
    severity: "warning",
    category: "acceptance",
    file: "tools/pr-review-advisor/validate-artifacts.mts",
    line: 1,
    title: "Fixture finding",
    description: "Fixture finding description.",
    impact: "Fixture impact.",
    recommendation: "Fixture recommendation.",
    verificationHint: "Fixture verification.",
    missingRegressionTest: "Fixture regression test.",
    evidence: "Fixture evidence.",
    ...overrides,
  };
}

function advisorAnalysisInput(overrides: Record<string, string> = {}) {
  return {
    advisorDir: "/trusted-advisor",
    advisorWorkdir: ROOT,
    outDir: "/tmp/pr-review-advisor",
    baseRef: "target/base",
    headRef: "HEAD",
    model: "nvidia/nvidia/nemotron-3-ultra",
    title: "PR Review Advisor",
    runAnalysis: "1",
    ...overrides,
  };
}

function throwReadTextError(error: Error): never {
  throw error;
}

function readTextBySuffix(
  entries: ReadonlyArray<readonly [suffix: string, text: string | Error]>,
): (file: string) => string {
  return (file: string): string => {
    const text = entries.find(([suffix]) => file.endsWith(suffix))?.[1];
    return text instanceof Error
      ? throwReadTextError(text)
      : (text ?? throwReadTextError(new Error(`unexpected read: ${file}`)));
  };
}

function supportedAdvisorReadText(input: ReturnType<typeof advisorAnalysisInput>) {
  return readTextBySuffix([
    ["session.mts", input.model],
    ["analyze.mts", "PR_REVIEW_ADVISOR_MODEL"],
    ["comment.mts", "PR_REVIEW_ADVISOR_COMMENT_MARKER"],
  ]);
}

function missingSessionReadText() {
  return readTextBySuffix([
    ["session.mts", new Error("missing session.mts")],
    ["analyze.mts", "PR_REVIEW_ADVISOR_MODEL"],
    ["comment.mts", "PR_REVIEW_ADVISOR_COMMENT_MARKER"],
  ]);
}

describe("PR review advisor workflow boundary", () => {
  it("keeps the target-event workflow inside the split privilege boundary", () => {
    expect(validatePrReviewAdvisorWorkflowBoundary()).toEqual([]);
  });

  it("rejects trigger and trusted-workflow identity regressions", () => {
    const errors = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        const triggers = workflowTriggers(workflow);
        triggers.pull_request = triggers.pull_request_target;
        delete triggers.pull_request_target;
        for (const job of [workflow.jobs.review, workflow.jobs.publish]) {
          const checkout = job.steps.find((step: { with?: Record<string, unknown> }) =>
            JSON.stringify(step.with ?? {}).includes("${{ github.workflow_sha }}"),
          );
          checkout.with.ref = "main";
        }
      }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "workflow must run automatic reviews on pull_request_target",
        "workflow must not duplicate automatic reviews on pull_request",
        "step 'Checkout trusted advisor code (workflow revision)' expected with.ref=${{ github.workflow_sha }}",
        "step 'Checkout trusted comment publisher (workflow revision)' expected with.ref=${{ github.workflow_sha }}",
      ]),
    );
  });

  it("rejects privilege-domain collapse", () => {
    const errors = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs.review.permissions["pull-requests"] = "write";
        workflow.jobs.publish.env.PR_REVIEW_ADVISOR_API_KEY =
          "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}";
        workflow.jobs.publish.env.ADVISOR_WORKDIR = "/tmp/pr-workdir";
      }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "review job permissions.pull-requests must be read",
        "publish must be the only job with pull-requests: write",
        "publish job must not receive the advisor model credential",
        "publish job must not receive the untrusted analysis worktree",
      ]),
    );
  });

  it("requires every third-party action to be pinned to an immutable commit", () => {
    const errors = validateMutation((source) =>
      source.replace(
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        "actions/download-artifact@v8",
      ),
    );
    expect(errors.some((error) => error.includes("full commit SHA"))).toBe(true);
  });

  // source-shape-contract: security -- Only one advisor lane may write PR comments and neither privilege domain may gain other GitHub capabilities
  it("requires one advisor lane to publish the PR comment", () => {
    const source = fs.readFileSync(WORKFLOW_PATH, "utf8");
    const workflow = YAML.parse(source) as Workflow;
    const noPrimary = validateMutation((workflow) =>
      workflow.replace("publish_comment: true", "publish_comment: false"),
    );
    const twoPrimaries = validateMutation((workflow) =>
      workflow.replace("publish_comment: false", "publish_comment: true"),
    );
    const extraReviewPermission = validateMutation((workflow) =>
      mutateWorkflowSource(workflow, (parsed) => {
        parsed.jobs.review.permissions["id-token"] = "write";
      }),
    );
    const extraPublishPermission = validateMutation((workflow) =>
      mutateWorkflowSource(workflow, (parsed) => {
        parsed.jobs.publish.permissions.statuses = "write";
      }),
    );

    expect(source).toContain("publish_comment: true");
    expect(workflow.on?.pull_request_target?.types).toContain("edited");
    expect(workflow.concurrency?.group).toContain(
      "github.event_name != 'pull_request_target' || github.event.action != 'edited' || github.event.changes.base != null",
    );
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
    for (const jobName of ["review", "publish"]) {
      expect(workflow.jobs?.[jobName]?.if, jobName).toContain("github.event.action != 'edited'");
      expect(workflow.jobs?.[jobName]?.if, jobName).toContain("github.event.changes.base != null");
    }
    expect(noPrimary).toContain("advisor matrix must identify one primary artifact lane");
    expect(twoPrimaries).toContain("advisor matrix must identify one primary artifact lane");
    expect(extraReviewPermission).toContain("review job permissions.id-token is not allowed");
    expect(extraPublishPermission).toContain("publish job permissions.statuses is not allowed");
  });

  it("runs the isolated-workspace helper from the trusted checkout and binds event SHAs", () => {
    const droppedHelper = validateMutation((source) =>
      source.replace(
        '"$ADVISOR_DIR/tools/pr-review-advisor/prepare-target-pr.mts"',
        '"$ADVISOR_WORKDIR/tools/pr-review-advisor/prepare-target-pr.mts"',
      ),
    );
    expect(droppedHelper).toContain(
      "step 'Prepare isolated analysis workspace' must use the canonical trusted prepare helper command",
    );

    const decoyTrustedPrepare = validateMutation((source) =>
      source.replace(
        'node --experimental-strip-types \\\n            "$ADVISOR_DIR/tools/pr-review-advisor/prepare-target-pr.mts"',
        'printf "%s\\n" "$ADVISOR_DIR/tools/pr-review-advisor/prepare-target-pr.mts"\n          node --experimental-strip-types "${ADVISOR_WORKDIR}/tools/pr-review-advisor/prepare-target-pr.mts"',
      ),
    );
    expect(decoyTrustedPrepare).toEqual(
      expect.arrayContaining([
        "review step 'Prepare isolated analysis workspace' must not execute pr-review-advisor helpers from ADVISOR_WORKDIR",
        "step 'Prepare isolated analysis workspace' must use the canonical trusted prepare helper command",
      ]),
    );

    const droppedHead = validateMutation((source) =>
      source.replace(
        "EXPECTED_HEAD_SHA: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || '' }}",
        "EXPECTED_HEAD_SHA: ${{ github.event_name == 'pull_request_target' && '' || '' }}",
      ),
    );
    expect(droppedHead).toContain(
      "Prepare isolated analysis workspace must bind EXPECTED_HEAD_SHA to the triggering PR head",
    );

    const droppedBase = validateMutation((source) =>
      source.replace(
        "PR_BASE_SHA: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.base.sha || '' }}",
        "PR_BASE_SHA: ${{ github.event_name == 'pull_request_target' && '' || '' }}",
      ),
    );
    expect(droppedBase).toContain(
      "Prepare isolated analysis workspace must bind PR_BASE_SHA to the triggering PR base",
    );

    const enabledLfs = validateMutation((source) =>
      source.replace('GIT_LFS_SKIP_SMUDGE: "1"', 'GIT_LFS_SKIP_SMUDGE: "0"'),
    );
    expect(enabledLfs).toContain("Prepare isolated analysis workspace must disable LFS smudging");
  });

  it("rejects executing advisor helpers from the untrusted analysis worktree", () => {
    const errors = validateMutation((source) =>
      source.replace(
        '"$ADVISOR_DIR/tools/pr-review-advisor/run-analysis.mts"',
        '"$ADVISOR_DIR/tools/pr-review-advisor/run-analysis.mts"\n          node --experimental-strip-types "$ADVISOR_WORKDIR/tools/pr-review-advisor/run-analysis.mts"',
      ),
    );
    expect(errors).toContain(
      "review step 'Run PR review advisor' must not execute pr-review-advisor helpers from ADVISOR_WORKDIR",
    );

    const bracedWorkdir = validateMutation((source) =>
      source.replace(
        '"$ADVISOR_DIR/tools/pr-review-advisor/run-analysis.mts"',
        '"${ADVISOR_WORKDIR}/tools/pr-review-advisor/run-analysis.mts"',
      ),
    );
    expect(bracedWorkdir).toEqual(
      expect.arrayContaining([
        "review step 'Run PR review advisor' must not execute pr-review-advisor helpers from ADVISOR_WORKDIR",
        "step 'Run PR review advisor' must use the canonical trusted analysis command",
      ]),
    );

    const relativeAfterCd = validateMutation((source) =>
      source.replace(
        '"$ADVISOR_DIR/tools/pr-review-advisor/run-analysis.mts"',
        '"tools/pr-review-advisor/run-analysis.mts"',
      ),
    );
    expect(relativeAfterCd).toEqual(
      expect.arrayContaining([
        "review step 'Run PR review advisor' must not execute pr-review-advisor helpers from ADVISOR_WORKDIR",
        "step 'Run PR review advisor' must use the canonical trusted analysis command",
      ]),
    );
  });

  it.skipIf(!CAN_CREATE_SYMLINKS || !CAN_RUN_BASH)(
    "removes worktree symlinks without touching their targets",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-symlinks-"));
      const workdir = path.join(tmp, "workdir");
      const outside = path.join(tmp, "outside.txt");
      fs.mkdirSync(workdir);
      fs.writeFileSync(outside, "runner state");
      fs.writeFileSync(path.join(workdir, "regular.txt"), "repository data");
      fs.symlinkSync(outside, path.join(workdir, "escape"));
      try {
        const result = spawnSync(
          "/bin/bash",
          ["-c", workflowStepScript("review", "Remove symlinks from analysis workspace")],
          { encoding: "utf8", env: { ...process.env, ADVISOR_WORKDIR: workdir } },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(fs.existsSync(path.join(workdir, "escape"))).toBe(false);
        expect(fs.readFileSync(outside, "utf8")).toBe("runner state");
        expect(fs.readFileSync(path.join(workdir, "regular.txt"), "utf8")).toBe("repository data");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  // source-shape-contract: security -- Symlink cleanup must remove only intended links after every untrusted workspace selection and before model credentials
  it("rejects deleting or weakening analysis-workspace symlink removal", () => {
    type MutableWorkflow = {
      jobs: { review: { steps: Array<{ name?: string; run?: string; shell?: string }> } };
    };
    const source = YAML.parse(workflowSource()) as MutableWorkflow;
    const cases: Array<{
      expected: string;
      mutate: (workflow: MutableWorkflow) => void;
    }> = [
      {
        expected: "missing workflow step: Remove symlinks from analysis workspace",
        mutate: (workflow) => {
          workflow.jobs.review.steps = workflow.jobs.review.steps.filter(
            (step) => step.name !== "Remove symlinks from analysis workspace",
          );
        },
      },
      {
        expected: "Remove symlinks from analysis workspace must use the bash shell",
        mutate: (workflow) => {
          const step = workflow.jobs.review.steps.find(
            (candidate) => candidate.name === "Remove symlinks from analysis workspace",
          );
          step!.shell = "sh";
        },
      },
      {
        expected:
          "Remove symlinks from analysis workspace must use the canonical fail-closed cleanup script",
        mutate: (workflow) => {
          const step = workflow.jobs.review.steps.find(
            (candidate) => candidate.name === "Remove symlinks from analysis workspace",
          );
          step!.run = step!.run!.replace("-type l -print0", "-type f -print0");
        },
      },
      {
        expected:
          "Remove symlinks from analysis workspace must use the canonical fail-closed cleanup script",
        mutate: (workflow) => {
          const step = workflow.jobs.review.steps.find(
            (candidate) => candidate.name === "Remove symlinks from analysis workspace",
          );
          step!.run = step!.run!.replace('rm -- "$link"', 'rm -- "$link" || true');
        },
      },
      {
        expected:
          "Remove symlinks from analysis workspace must run after workspace-selection step 'Prepare isolated analysis workspace'",
        mutate: (workflow) => {
          const steps = workflow.jobs.review.steps;
          const cleanupIndex = steps.findIndex(
            (step) => step.name === "Remove symlinks from analysis workspace",
          );
          const cleanup = steps.splice(cleanupIndex, 1)[0]!;
          const prepareIndex = steps.findIndex(
            (step) => step.name === "Prepare isolated analysis workspace",
          );
          steps.splice(prepareIndex, 0, cleanup);
        },
      },
      {
        expected:
          "analysis workspace symlinks must be removed before the model credential is exposed",
        mutate: (workflow) => {
          const steps = workflow.jobs.review.steps;
          const cleanupIndex = steps.findIndex(
            (step) => step.name === "Remove symlinks from analysis workspace",
          );
          const cleanup = steps.splice(cleanupIndex, 1)[0]!;
          const analysisIndex = steps.findIndex((step) => step.name === "Run PR review advisor");
          steps.splice(analysisIndex + 1, 0, cleanup);
        },
      },
      {
        expected:
          "Remove symlinks from analysis workspace must run after workspace-selection step 'Set default advisor workdir'",
        mutate: (workflow) => {
          const steps = workflow.jobs.review.steps;
          const cleanupIndex = steps.findIndex(
            (step) => step.name === "Remove symlinks from analysis workspace",
          );
          const cleanup = steps.splice(cleanupIndex, 1)[0]!;
          const defaultIndex = steps.findIndex(
            (step) => step.name === "Set default advisor workdir",
          );
          steps.splice(defaultIndex, 0, cleanup);
        },
      },
    ];

    for (const { expected, mutate } of cases) {
      const workflow = structuredClone(source);
      mutate(workflow);
      expect(validateMutation(() => YAML.stringify(workflow))).toContain(expected);
    }
  });

  it.skipIf(!CAN_RUN_BASH)("installs and verifies the pinned search tools", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-install-"));
    const binDir = path.join(tmp, "bin");
    const callLog = path.join(tmp, "calls.log");
    fs.mkdirSync(binDir);
    fs.mkdirSync(path.join(tmp, "advisor"));
    writeFakeCommand(binDir, "npm");
    fs.writeFileSync(
      path.join(binDir, "dpkg-query"),
      `#!/bin/bash
printf 'dpkg-query %s\\n' "$*" >> "$CALL_LOG"
case "\${!#}" in
  fd-find) printf '%s' "$FD_FIND_VERSION" ;;
  ripgrep) printf '%s' "$RIPGREP_VERSION" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binDir, "fdfind"),
      "#!/bin/bash\nprintf 'fdfind %s\\n' \"$*\" >> \"$CALL_LOG\"\nprintf 'fdfind 9.0.0\\n'\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binDir, "rg"),
      "#!/bin/bash\nprintf 'rg %s\\n' \"$*\" >> \"$CALL_LOG\"\nprintf 'ripgrep 14.1.0\\n-SIMD -AVX\\n'\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binDir, "sudo"),
      `#!/bin/bash
printf 'sudo %s\\n' "$*" >> "$CALL_LOG"
`,
      { mode: 0o755 },
    );
    try {
      const result = spawnSync(
        "/bin/bash",
        ["-c", workflowStepScript("review", "Install Pi SDK")],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            ADVISOR_DIR: path.join(tmp, "advisor"),
            CALL_LOG: callLog,
            FD_FIND_VERSION: "9.0.0-1",
            PATH: binDir,
            PI_SDK_VERSION: "test-version",
            RIPGREP_VERSION: "14.1.0-1",
            RUNNER_TEMP: path.join(tmp, "runner"),
            TYPEBOX_VERSION: "test-typebox-version",
            VITEST_VERSION: "test-vitest-version",
            YAML_VERSION: "test-yaml-version",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(callLog, "utf8")).toContain(
        "sudo apt-get install -y --no-install-recommends fd-find=9.0.0-1 ripgrep=14.1.0-1",
      );
      expect(fs.readFileSync(callLog, "utf8")).toContain("dpkg-query -W -f=${Version} fd-find");
      expect(fs.readFileSync(callLog, "utf8")).toContain("dpkg-query -W -f=${Version} ripgrep");
      expect(fs.readFileSync(callLog, "utf8")).toContain("fdfind --version");
      expect(fs.readFileSync(callLog, "utf8")).toContain("rg --version");
      expect(fs.readFileSync(callLog, "utf8")).toContain(
        "npm ci --ignore-scripts --no-audit --no-fund",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits a schema-valid result when trusted advisor code is unavailable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-bootstrap-"));
    const artifactDir = path.join(tmp, "artifacts", "pr-review-advisor");
    try {
      runPrReviewAdvisorAnalysis(
        {
          advisorDir: path.join(tmp, "trusted-advisor-without-implementation"),
          advisorWorkdir: ROOT,
          outDir: artifactDir,
          baseRef: "origin/main",
          headRef: "HEAD",
          model: "azure/openai/gpt-5.6-terra",
          title: "PR Review Advisor",
          runAnalysis: "1",
        },
        { runGit: () => HEAD_SHA },
      );
      const schemaValidation = spawnSync(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs");
const Ajv2020 = require("ajv/dist/2020").default;
const schema = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);
const valid = validate(result);
valid || console.error(JSON.stringify(validate.errors));
process.exitCode = valid ? 0 : 1;`,
          path.join(ROOT, "tools/pr-review-advisor/schema.json"),
          path.join(artifactDir, "pr-review-advisor-final-result.json"),
        ],
        { cwd: ROOT, encoding: "utf8" },
      );

      expect(schemaValidation.status, schemaValidation.stderr).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not overwrite existing bootstrap result artifacts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-bootstrap-"));
    const artifactDir = path.join(tmp, "artifacts", "pr-review-advisor");
    const resultPath = path.join(artifactDir, "pr-review-advisor-result.json");
    try {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(resultPath, "existing artifact\n");

      expect(() =>
        runPrReviewAdvisorAnalysis(
          {
            advisorDir: path.join(tmp, "trusted-advisor-without-implementation"),
            advisorWorkdir: ROOT,
            outDir: artifactDir,
            baseRef: "origin/main",
            headRef: "HEAD",
            model: "azure/openai/gpt-5.6-terra",
            title: "PR Review Advisor",
            runAnalysis: "1",
          },
          { runGit: () => HEAD_SHA },
        ),
      ).toThrow(/EEXIST.*pr-review-advisor-result\.json/u);
      expect(fs.readFileSync(resultPath, "utf8")).toBe("existing artifact\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs analyze normally when the trusted checkout supports the advisor model", () => {
    const appendedEnv: Array<[string, string]> = [];
    const runCalls: Array<{
      script: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      cwd: string;
    }> = [];
    const input = advisorAnalysisInput({ runAnalysis: "0" });
    const analyzePath = path.join(input.advisorDir, "tools", "pr-review-advisor", "analyze.mts");
    const previousRunAnalysis = process.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS;
    process.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS = "1";

    try {
      runPrReviewAdvisorAnalysis(input, {
        fileExists: (file) => file === analyzePath,
        readText: supportedAdvisorReadText(input),
        runNode: (script, args, env, cwd) => {
          runCalls.push({ script, args, env, cwd });
          return 0;
        },
        appendEnv: (key, value) => appendedEnv.push([key, value]),
      });
    } finally {
      restoreEnv("PR_REVIEW_ADVISOR_RUN_ANALYSIS", previousRunAnalysis);
    }

    expect(appendedEnv).toEqual([["PR_REVIEW_ADVISOR_SUPPORTED", "1"]]);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({
      script: analyzePath,
      args: [
        "--base",
        input.baseRef,
        "--head",
        input.headRef,
        "--schema",
        path.join(input.advisorDir, "tools", "pr-review-advisor", "schema.json"),
        "--out-dir",
        input.outDir,
      ],
      cwd: input.advisorWorkdir,
    });
    expect(runCalls[0]!.env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON).toBeUndefined();
    expect(runCalls[0]!.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS).toBe("0");
  });

  it("appends support status only to an existing GitHub env file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-env-"));
    const envFile = path.join(tmp, "github-env");
    const input = advisorAnalysisInput({ envFile });
    const analyzePath = path.join(input.advisorDir, "tools", "pr-review-advisor", "analyze.mts");
    try {
      fs.writeFileSync(envFile, "");
      runPrReviewAdvisorAnalysis(input, {
        fileExists: (file) => file === analyzePath,
        readText: supportedAdvisorReadText(input),
        runNode: () => 0,
      });

      expect(fs.readFileSync(envFile, "utf8")).toBe("PR_REVIEW_ADVISOR_SUPPORTED=1\n");
      fs.rmSync(envFile);
      expect(() =>
        runPrReviewAdvisorAnalysis(input, {
          fileExists: (file) => file === analyzePath,
          readText: supportedAdvisorReadText(input),
          runNode: () => 0,
        }),
      ).toThrow();
      expect(fs.existsSync(envFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails the supported advisor lane when analyze exits non-zero", () => {
    const input = advisorAnalysisInput();
    const analyzePath = path.join(input.advisorDir, "tools", "pr-review-advisor", "analyze.mts");

    expect(() =>
      runPrReviewAdvisorAnalysis(input, {
        fileExists: (file) => file === analyzePath,
        readText: supportedAdvisorReadText(input),
        runNode: () => 17,
      }),
    ).toThrow("analyze.mts exited with status 17");
  });

  it("runs analyze in unavailable-result mode when the trusted checkout lacks model support", () => {
    const appendedEnv: Array<[string, string]> = [];
    const runCalls: Array<{
      script: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      cwd: string;
    }> = [];
    const input = advisorAnalysisInput();
    const analyzePath = path.join(input.advisorDir, "tools", "pr-review-advisor", "analyze.mts");

    runPrReviewAdvisorAnalysis(input, {
      fileExists: (file) => file === analyzePath,
      readText: (file) =>
        file.endsWith("session.mts") ? "legacy primary model only" : "trusted helper text",
      runNode: (script, args, env, cwd) => {
        runCalls.push({ script, args, env, cwd });
        return 0;
      },
      appendEnv: (key, value) => appendedEnv.push([key, value]),
    });

    expect(appendedEnv).toEqual([["PR_REVIEW_ADVISOR_SUPPORTED", "0"]]);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({
      script: analyzePath,
      args: [
        "--base",
        input.baseRef,
        "--head",
        input.headRef,
        "--schema",
        path.join(input.advisorDir, "tools", "pr-review-advisor", "schema.json"),
        "--out-dir",
        input.outDir,
      ],
      cwd: input.advisorWorkdir,
    });
    expect(runCalls[0]!.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS).toBe("0");
    expect(runCalls[0]!.env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON).toContain(input.model);
  });

  it("treats missing model-support probe files as unsupported rollout skew", () => {
    const appendedEnv: Array<[string, string]> = [];
    const runCalls: Array<{ env: NodeJS.ProcessEnv }> = [];
    const input = advisorAnalysisInput();
    const analyzePath = path.join(input.advisorDir, "tools", "pr-review-advisor", "analyze.mts");

    runPrReviewAdvisorAnalysis(input, {
      fileExists: (file) => file === analyzePath,
      readText: missingSessionReadText(),
      runNode: (_script, _args, env) => {
        runCalls.push({ env });
        return 0;
      },
      appendEnv: (key, value) => appendedEnv.push([key, value]),
    });

    expect(appendedEnv).toEqual([["PR_REVIEW_ADVISOR_SUPPORTED", "0"]]);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS).toBe("0");
    expect(runCalls[0]!.env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON).toContain(input.model);
  });

  it("fails unavailable artifact generation for unsupported model rollout skew", () => {
    const appendedEnv: Array<[string, string]> = [];
    expect(() =>
      runPrReviewAdvisorAnalysis(advisorAnalysisInput(), {
        fileExists: (file) => file.endsWith("analyze.mts"),
        readText: (file) =>
          file.endsWith("session.mts") ? "legacy primary model only" : "trusted helper text",
        runNode: () => 17,
        appendEnv: (key, value) => appendedEnv.push([key, value]),
      }),
    ).toThrow("PR review advisor unavailable-result generation exited with status 17");
    expect(appendedEnv).toEqual([["PR_REVIEW_ADVISOR_SUPPORTED", "0"]]);
  });

  it("accepts bounded same-head primary and secondary artifacts for publication", () => {
    const result = runArtifactValidation(validPrimaryResult());
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.githubOutput).toBe("secondary_artifact_validated=true\n");
    } finally {
      result.cleanup();
    }
  });

  it("fetches live PR head and base from one GitHub response snapshot", () => {
    const ghApiCalls: Array<{ command: string; args: string[] }> = [];
    const live = fetchLivePullFromGh("NVIDIA/NemoClaw", "6736", (command, args) => {
      ghApiCalls.push({ command, args });
      return JSON.stringify({ head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } });
    });

    expect(live).toEqual({ headSha: HEAD_SHA, baseSha: BASE_SHA });
    expect(ghApiCalls).toEqual([
      { command: "gh", args: ["api", "repos/NVIDIA/NemoClaw/pulls/6736"] },
    ]);
  });

  it("accepts a validated partial primary failure for publication", () => {
    const partialPrimary = {
      ...validPrimaryResult(),
      summary: validSummary({ confidence: "low", oneLine: "Partial primary result." }),
      findings: [validFinding({ title: "partial primary finding" })],
    };
    const result = runArtifactValidation(partialPrimary, {
      analysisResult: {
        failed: true,
        partial: true,
        reason: "provider stopped",
        findingCount: 1,
      },
    });
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.githubOutput).toBe("secondary_artifact_validated=true\n");
    } finally {
      result.cleanup();
    }
  });

  it("accepts failed, partial, skipped, and unavailable second-opinion outcomes", () => {
    const partialSecondary = {
      ...validPrimaryResult(),
      summary: validSummary({ confidence: "low", oneLine: "Partial secondary result." }),
      findings: [validFinding({ title: "partial second-opinion finding" })],
    };
    const cases = [
      {
        name: "failed partial",
        options: {
          secondaryResult: partialSecondary,
          secondaryAnalysisResult: {
            failed: true,
            partial: true,
            reason: "provider stopped",
            findingCount: 1,
          },
        },
        validated: true,
      },
      {
        name: "failed before findings",
        options: {
          secondaryAnalysisResult: { failed: true, reason: "provider stopped" },
        },
        validated: true,
      },
      {
        name: "skipped",
        options: {
          secondaryAnalysisResult: { skipped: true, reason: "model unavailable" },
        },
        validated: true,
      },
      {
        name: "artifact unavailable",
        options: {
          secondaryDownloadOutcome: "failure" as const,
          omitSecondaryArtifact: true,
        },
        validated: false,
      },
    ];
    for (const { name, options, validated } of cases) {
      const result = runArtifactValidation(validPrimaryResult(), options);
      try {
        expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(0);
        expect(result.githubOutput, name).toBe(`secondary_artifact_validated=${validated}\n`);
      } finally {
        result.cleanup();
      }
    }
  });

  it("rejects malformed, wrong-head, stale, and symlinked primary artifacts", () => {
    const missingAcceptanceCoverage = { ...validPrimaryResult() };
    delete missingAcceptanceCoverage.acceptanceCoverage;
    const cases = [
      { name: "version", artifact: { ...validPrimaryResult(), version: 2 } },
      { name: "head", artifact: { ...validPrimaryResult(), headSha: "d".repeat(40) } },
      { name: "findings", artifact: { ...validPrimaryResult(), findings: null } },
      { name: "e2e", artifact: { ...validPrimaryResult(), e2e: {} } },
      { name: "schema-required field", artifact: missingAcceptanceCoverage },
      {
        name: "unknown status",
        artifact: validPrimaryResult(),
        options: { analysisResult: { unexpected: true } },
      },
      {
        name: "missing status",
        artifact: validPrimaryResult(),
        options: { omitAnalysisResult: true },
      },
      {
        name: "missing summary",
        artifact: validPrimaryResult(),
        options: { omitSummary: true },
      },
      {
        name: "symlinked status",
        artifact: validPrimaryResult(),
        options: { symlinkAnalysisResult: true },
      },
      {
        name: "symlinked final result",
        artifact: validPrimaryResult(),
        options: { symlinkResult: true },
      },
      {
        name: "live head",
        artifact: validPrimaryResult(),
        options: { liveHead: "e".repeat(40) },
      },
      {
        name: "live base",
        artifact: validPrimaryResult(),
        options: { liveBase: "e".repeat(40) },
      },
    ];
    const runnableCases = cases.filter(
      ({ options }) =>
        CAN_CREATE_SYMLINKS || (!options?.symlinkAnalysisResult && !options?.symlinkResult),
    );
    for (const { name, artifact, options } of runnableCases) {
      const result = runArtifactValidation(artifact, options);
      try {
        expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(1);
      } finally {
        result.cleanup();
      }
    }
  });

  it("withholds every invalid secondary artifact without suppressing the primary", () => {
    const mismatchedAnalysisResult = {
      ...validPrimaryResult(),
      summary: validSummary({ confidence: "medium", oneLine: "Mismatched analysis result." }),
    };
    const cases = [
      {
        name: "wrong head",
        options: {
          secondaryResult: { ...validPrimaryResult(), headSha: "d".repeat(40) },
        },
      },
      {
        name: "unknown status",
        options: { secondaryAnalysisResult: { unexpected: true } },
      },
      {
        name: "conflicting status",
        options: {
          secondaryAnalysisResult: {
            failed: true,
            skipped: true,
            reason: "ambiguous status",
          },
        },
      },
      {
        name: "completed result mismatch",
        options: { secondaryAnalysisResult: mismatchedAnalysisResult },
      },
      {
        name: "partial count mismatch",
        options: {
          secondaryAnalysisResult: {
            failed: true,
            partial: true,
            reason: "provider stopped",
            findingCount: 1,
          },
        },
      },
      { name: "missing artifact", options: { omitSecondaryArtifact: true } },
      { name: "missing summary", options: { omitSecondarySummary: true } },
      { name: "symlinked final result", options: { symlinkSecondaryResult: true } },
    ];
    const runnableCases = cases.filter(
      ({ options }) => CAN_CREATE_SYMLINKS || !options.symlinkSecondaryResult,
    );
    for (const { name, options } of runnableCases) {
      const result = runArtifactValidation(validPrimaryResult(), options);
      try {
        expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(0);
        expect(result.githubOutput, name).toBe("secondary_artifact_validated=false\n");
        expect(result.stderr, name).toContain("Secondary advisor artifact failed validation");
      } finally {
        result.cleanup();
      }
    }
  });

  it("rejects an unrecognized trusted secondary download outcome", () => {
    const result = runArtifactValidation(validPrimaryResult(), {
      secondaryDownloadOutcome: "unexpected",
    });
    try {
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Invalid secondary advisor artifact outcome");
      expect(result.githubOutput).toBe("");
    } finally {
      result.cleanup();
    }
  });

  it("rejects cross-run artifact downloads and missing publication validation", () => {
    const primaryCrossRun = validateMutation((source) =>
      addDownloadRunId(source, "Download primary advisor artifact"),
    );
    expect(primaryCrossRun).toContain("Download primary advisor artifact must not set with.run-id");

    const secondaryCrossRun = validateMutation((source) =>
      addDownloadRunId(source, "Download secondary advisor artifact"),
    );
    expect(secondaryCrossRun).toContain(
      "Download secondary advisor artifact must not set with.run-id",
    );

    const blockingSecondary = validateMutation((source) =>
      setPublishStepContinueOnError(source, "Download secondary advisor artifact", false),
    );
    expect(blockingSecondary).toContain(
      "secondary advisor artifact download must remain non-blocking",
    );

    const missingHelper = validateMutation((source) =>
      source.replace(
        '"$ADVISOR_DIR/tools/pr-review-advisor/validate-artifacts.mts"',
        '"$ADVISOR_WORKDIR/tools/pr-review-advisor/validate-artifacts.mts"',
      ),
    );
    expect(missingHelper).toContain(
      "step 'Validate advisor artifacts' must use the canonical trusted validation command",
    );

    const missingPublisherInstall = validateMutation((source) =>
      source.replace(
        "\n      - name: Install trusted publisher dependencies\n        working-directory: advisor\n        run: npm ci --ignore-scripts --no-audit --no-fund\n",
        "\n",
      ),
    );
    expect(missingPublisherInstall).toEqual(
      expect.arrayContaining([
        "missing workflow step: Install trusted publisher dependencies",
        "trusted publisher Node and dependencies must be installed from the trusted checkout before artifact validation",
      ]),
    );

    const downgradedPublisherNode = validateMutation((source) =>
      source.replace(
        '      - name: Setup Node for trusted publisher\n        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version: "22"',
        '      - name: Setup Node for trusted publisher\n        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version: "20"',
      ),
    );
    expect(downgradedPublisherNode).toContain(
      "step 'Setup Node for trusted publisher' expected with.node-version=22",
    );
  });

  it("keeps publication best-effort while preserving the primary analysis failure", () => {
    const errors = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs.review["continue-on-error"] = true;
        workflow.jobs.publish["continue-on-error"] = false;
      }),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "review job failures must be non-blocking only for non-publishing advisor lanes",
        "publish job must be best-effort so it cannot mask the primary analysis outcome",
      ]),
    );
  });

  it("keeps advisor matrix artifacts isolated", () => {
    const errors = validateMutation((source) =>
      source
        .replace(
          "artifact_dir: pr-review-advisor-nemotron-ultra",
          "artifact_dir: pr-review-advisor",
        )
        .replace(
          "artifact_name: pr-review-advisor-nemotron-ultra",
          "artifact_name: pr-review-advisor",
        )
        .replace("model: nvidia/nvidia/nemotron-3-ultra", "model: azure/openai/gpt-5.6-terra"),
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        "advisor matrix field model must be unique: azure/openai/gpt-5.6-terra",
        "advisor matrix field artifact_dir must be unique: pr-review-advisor",
        "advisor matrix field artifact_name must be unique: pr-review-advisor",
      ]),
    );
  });

  it("keeps mutable review history disabled and runtime dependencies pinned", () => {
    const errors = validateMutation((source) =>
      source
        .replace('      FD_FIND_VERSION: "9.0.0-1"', '      FD_FIND_VERSION: "latest"')
        .replace('      VITEST_VERSION: "4.1.9"', '      VITEST_VERSION: "latest"')
        .replace('      YAML_VERSION: "2.8.3"', '      YAML_VERSION: "latest"')
        .replace(
          '      PR_REVIEW_ADVISOR_LOAD_PREVIOUS_REVIEW: "false"',
          "      PR_REVIEW_ADVISOR_LOAD_PREVIOUS_REVIEW: ${{ matrix.advisor.publish_comment }}",
        ),
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        "review job env.FD_FIND_VERSION must be 9.0.0-1",
        "review job env.VITEST_VERSION must be 4.1.9",
        "review job env.YAML_VERSION must be 2.8.3",
        "review job env.PR_REVIEW_ADVISOR_LOAD_PREVIOUS_REVIEW must be false",
      ]),
    );
  });

  it("rejects decoy lockfile-install text outside the npm invocation", () => {
    const errors = validateMutation((source) =>
      source.replace(
        "npm ci --ignore-scripts --no-audit --no-fund",
        "npm install --ignore-scripts\n            printf '%s\\n' 'npm ci --ignore-scripts --no-audit --no-fund' >/dev/null",
      ),
    );

    expect(errors).toContain(
      "step 'Install Pi SDK' must use the canonical lockfile-only npm ci command",
    );
  });

  it("rejects decoy publisher dependency install text outside the npm invocation", () => {
    const errors = validateMutation((source) =>
      source.replace(
        "      - name: Install trusted publisher dependencies\n        working-directory: advisor\n        run: npm ci --ignore-scripts --no-audit --no-fund",
        "      - name: Install trusted publisher dependencies\n        working-directory: advisor\n        run: |\n          npm install --ignore-scripts\n          printf '%s\\n' 'npm ci --ignore-scripts --no-audit --no-fund' >/dev/null",
      ),
    );

    expect(errors).toContain(
      "step 'Install trusted publisher dependencies' must use the canonical lockfile-only npm ci command",
    );

    const extraCommand = validateMutation((source) =>
      source.replace(
        "      - name: Install trusted publisher dependencies\n        working-directory: advisor\n        run: npm ci --ignore-scripts --no-audit --no-fund",
        "      - name: Install trusted publisher dependencies\n        working-directory: advisor\n        run: |\n          npm ci --ignore-scripts --no-audit --no-fund\n          echo done",
      ),
    );
    expect(extraCommand).toContain(
      "step 'Install trusted publisher dependencies' must use the canonical lockfile-only npm ci command",
    );
  });

  it("rejects drift in the trusted advisor runtime package lock", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-lock-"));
    const lockPath = path.join(tmp, "package-lock.json");
    fs.writeFileSync(lockPath, JSON.stringify({ packages: {} }));
    try {
      expect(
        validatePrReviewAdvisorWorkflowBoundary(
          path.join(ROOT, ".github", "workflows", "pr-review-advisor.yaml"),
          lockPath,
        ),
      ).toEqual(
        expect.arrayContaining([
          "advisor package lock must pin @earendil-works/pi-coding-agent@0.80.6",
          "advisor package lock must pin typebox@1.1.38",
          "advisor package lock must pin yaml@2.8.3",
          "advisor package lock must pin vitest@4.1.9",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports workflow parse failures through boundary errors", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-missing-"));
    const missingPath = path.join(tmp, "workflow.yaml");
    try {
      expect(validatePrReviewAdvisorWorkflowBoundary(missingPath)).toEqual([
        `failed to read or parse workflow: ${missingPath}`,
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
