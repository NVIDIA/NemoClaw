#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  E2E_RENDER_LIMIT,
  type E2eChangedCredentialFreeTest,
  type E2eCoverageResult,
  type E2eTargetAdvisorResult,
  normalizeE2eCoverageResult,
  normalizeE2eTargetAdvisorResult,
  trustedE2eRecommendationInventory,
} from "../advisors/e2e-recommendations.mts";
import { getChangedFiles, getDiff, getHeadSha } from "../advisors/git.mts";
import { githubRest } from "../advisors/github.mts";
import { parseArgs, parsePositiveInt, readJson, writeJson } from "../advisors/io.mts";
import {
  enumValue,
  getPath,
  isObjectRecord,
  recordItems,
  stringArray,
  stringOrDefault,
  stringOrUndefined,
} from "../advisors/json.mts";
import { buildRiskPlan } from "../advisors/risk-plan.mts";
import {
  type AdvisorCompletedTurn,
  type AdvisorContextToolResult,
  type AdvisorPromptTurn,
  advisorRunErrors,
  createAdvisorContextToolResult,
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_ADVISOR_PROVIDER,
  type RunAdvisorResult,
  runReadOnlyAdvisor,
} from "../advisors/session.mts";
import {
  artifactPaths,
  type ArtifactPaths,
  writePromptArtifacts,
  writeTurnArtifact,
} from "./artifacts.mts";
export { artifactPaths, writePromptArtifacts, writeTurnArtifact } from "./artifacts.mts";
import { buildChallengeAndRecordTurn } from "./challenge-and-record-turn.mts";
import {
  collectDeterministicContext,
  type DeterministicReviewContext,
} from "./deterministic-context.mts";
export {
  classifyTestDepth,
  collectStaticTestInventory,
  detectLocalizedPatchSignals,
  detectSimplificationSignals,
  type DeterministicReviewContext,
  type SimplificationSignal,
  type StaticTestInventory,
} from "./deterministic-context.mts";
import { buildInvestigateTurn } from "./investigate-turn.mts";
import { renderDetailedReview, renderSummary } from "./render-result.mts";
export { renderDetailedReview, renderSummary } from "./render-result.mts";
import {
  buildCorrectnessTurnContext,
  buildDriftTurnContext,
  buildOperationsTurnContext,
  buildReconciliationTurnContext,
  buildRiskPlanReviewContext,
  buildScopeRiskTurnContext,
  buildSecurityTurnContext,
  buildTestsTurnContext,
  buildValidationTurnContext,
} from "./turn-context.mts";
export { buildRiskPlanReviewContext } from "./turn-context.mts";
import {
  buildSystemPrompt,
  readSecurityCategoryNames,
  readTrustedCodeChangeConsiderations,
  readTrustedControlledWords,
  readTrustedSecurityRubric,
  readTrustedWritingGuide,
} from "./trusted-guidance.mts";
export {
  buildSystemPrompt,
  readSecurityCategoryNames,
  readTrustedCodeChangeConsiderations,
  readTrustedControlledWords,
  readTrustedSecurityRubric,
  readTrustedWritingGuide,
} from "./trusted-guidance.mts";
import {
  collectGitHubReviewContext,
  extractIssueRefs,
  type GitHubReviewContext,
  type PreviousAdvisorReview,
  readPreparedGitHubContext,
} from "./github-context.mts";
import {
  createReviewFindingLedger,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_SIMPLIFICATION_TAGS,
  type ReviewFindingLedger,
} from "./review-ledger.mts";
import {
  createReviewSubmissionController,
  RECORD_FINDINGS_TOOL,
  RECORD_REVIEW_RECEIPT_TOOL,
  RECOMMEND_E2E_TOOL,
  SUBMIT_REVIEW_TOOL,
  type ReviewSubmissionController,
} from "./review-submission.mts";
import {
  createTerminologyLedger,
  createTerminologyToolController,
  TERMINOLOGY_CHANGES,
  TERMINOLOGY_DISPOSITIONS,
  TERMINOLOGY_SEMANTIC_IMPACTS,
  TERMINOLOGY_TRACE_TOOL,
  type TerminologyLedger,
  type TerminologyReview,
} from "./terminology.mts";

export type { GitHubReviewContext, PreviousAdvisorReview };
export { extractIssueRefs, readPreparedGitHubContext };

const root = process.cwd();
export const DEFAULT_ADVISOR_COMMENT_MARKER = "<!-- nemoclaw-pr-review-advisor -->";
export const DEFAULT_ADVISOR_WORKFLOW_NAME = "PR Review / Advisor";
export const DEFAULT_ADVISOR_WORKFLOW_PATH = ".github/workflows/pr-review-advisor.yaml";
const ADVISOR_PROVIDER = DEFAULT_ADVISOR_PROVIDER;
const ADVISOR_MODEL = process.env.PR_REVIEW_ADVISOR_MODEL || DEFAULT_ADVISOR_MODEL;
const ADVISOR_COMMENT_MARKER =
  process.env.PR_REVIEW_ADVISOR_COMMENT_MARKER || DEFAULT_ADVISOR_COMMENT_MARKER;
const ADVISOR_WORKFLOW_NAME =
  process.env.PR_REVIEW_ADVISOR_WORKFLOW_NAME || DEFAULT_ADVISOR_WORKFLOW_NAME;
const ADVISOR_WORKFLOW_PATH =
  process.env.PR_REVIEW_ADVISOR_WORKFLOW_PATH || DEFAULT_ADVISOR_WORKFLOW_PATH;
const ADVISOR_CREDENTIAL_ENV = ["PR", "REVIEW", "ADVISOR", "API", "KEY"].join("_");
const RISK_CONTEXT_PATH_SAMPLE_LIMIT = 20;
const RISK_CONTEXT_PATH_CHARACTER_LIMIT = 240;
const METADATA_CHANGED_FILE_LIMIT = 20;
const METADATA_CHANGED_FILE_BYTE_LIMIT = 8192;
const SECURITY_RUBRIC_PATH = ".agents/skills/_shared/security-rubric.md";
const TRUSTED_SECURITY_RUBRIC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  SECURITY_RUBRIC_PATH,
);
const TRUSTED_WRITING_GUIDE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "WRITING.md",
);
const TRUSTED_CONTROLLED_WORDS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".agents/skills/_shared/controlled-words.md",
);
const TRUSTED_CODE_CHANGE_CONSIDERATIONS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".agents/skills/_shared/code-change-considerations.md",
);
const CONFIDENCES = ["low", "medium", "high"] as const;
const SUMMARY_RECOMMENDATIONS = [
  "merge_as_is",
  "merge_after_fixes",
  "needs_rework",
  "blocked",
  "superseded",
  "info_only",
] as const;
const TEST_DEPTH_VERDICTS = [
  "unknown",
  "unit_sufficient",
  "mocks_recommended",
  "runtime_validation_recommended",
] as const;
const ACCEPTANCE_STATUSES = ["satisfied", "partial", "missing", "unknown"] as const;
const SECURITY_VERDICTS = ["pass", "warning", "fail", "not_applicable"] as const;
const SOURCE_OF_TRUTH_STATUSES = ["sound", "needs_followup", "missing", "not_applicable"] as const;
const TERMINOLOGY_STATUSES = ["clear", "candidates", "limited"] as const;
const SECURITY_CATEGORY_COUNT = 9;
const SECURITY_CATEGORY_SECTION_NAMES = ["Meaning", "Questions", "Expected evidence"] as const;
const FINDING_CATEGORIES = REVIEW_FINDING_CATEGORIES;
const SIMPLIFICATION_TAGS = REVIEW_FINDING_SIMPLIFICATION_TAGS;
type FindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];
type Confidence = (typeof CONFIDENCES)[number];
type SummaryRecommendation = (typeof SUMMARY_RECOMMENDATIONS)[number];
type FindingCategory = (typeof FINDING_CATEGORIES)[number];
type TestDepthVerdict = (typeof TEST_DEPTH_VERDICTS)[number];
type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];
type SecurityVerdict = (typeof SECURITY_VERDICTS)[number];
type SourceOfTruthStatus = (typeof SOURCE_OF_TRUTH_STATUSES)[number];
type SimplificationTag = (typeof SIMPLIFICATION_TAGS)[number];

export type ReviewMetadata = {
  baseRef: string;
  headRef: string;
  headSha: string;
  changedFiles: string[];
  deterministic: DeterministicReviewContext;
};

type Finding = {
  severity: "blocker" | "warning" | "suggestion";
  category: FindingCategory;
  file: string | null;
  line: number | null;
  title: string;
  description: string;
  impact: string;
  recommendation: string;
  verificationHint: string;
  missingRegressionTest: string;
  evidence: string;
  simplification?: SimplificationFinding;
};

type SimplificationFinding = {
  tag: SimplificationTag;
  cut: string;
  replacement: string;
  estimatedNetLines: number | null;
  safetyBoundary: string;
};

type AcceptanceCoverage = {
  clause: string;
  status: AcceptanceStatus;
  evidence: string;
};

type SecurityCategory = {
  category: string;
  verdict: SecurityVerdict;
  justification: string;
};

type SourceOfTruthReview = {
  surface: string;
  status: SourceOfTruthStatus;
  findingId: string | null;
  invalidState: string;
  sourceBoundary: string;
  whyNotSourceFix: string;
  regressionTest: string;
  removalCondition: string;
  evidence: string;
};

export type CombinedE2eResult = {
  coverage: E2eCoverageResult;
  targets: Pick<
    E2eTargetAdvisorResult,
    "relevantChangedFiles" | "required" | "optional" | "noTargetE2eReason" | "confidence"
  > & {
    changedCredentialFreeTests: Array<E2eChangedCredentialFreeTest & { headSha: string }>;
  };
};

type ReviewAdvisorResult = {
  version: 1;
  baseRef: string;
  headRef: string;
  headSha: string;
  changedFiles: string[];
  summary: {
    recommendation: SummaryRecommendation;
    confidence: Confidence;
    oneLine: string;
    topItem?: string;
    sinceLastReview?: {
      resolved: number;
      stillApplies: number;
      newItems: number;
    };
  };
  findings: Finding[];
  terminologyReview: TerminologyReview;
  acceptanceCoverage: AcceptanceCoverage[];
  securityCategories: SecurityCategory[];
  sourceOfTruthReview: SourceOfTruthReview[];
  e2e: CombinedE2eResult;
  testDepth: {
    verdict: TestDepthVerdict;
    rationale: string;
    suggestedTests: string[];
  };
  positives: string[];
  reviewCompleteness: {
    limitations: string[];
    requiresHumanReview: boolean;
  };
};

function preSessionFailureMetadata({
  baseRef,
  headRef,
  headSha,
  changedFiles,
  reason,
}: {
  baseRef: string;
  headRef: string;
  headSha: string;
  changedFiles: string[];
  reason: string;
}): ReviewMetadata {
  return {
    baseRef,
    headRef,
    headSha,
    changedFiles,
    deterministic: {
      diffStat: "<diff stat unavailable>",
      commits: [],
      riskyAreas: [],
      riskPlan: buildRiskPlan({ headSha, changedFiles }),
      testDepth: { verdict: "unknown", rationale: reason, suggestedTests: [] },
      staticTestInventory: {
        changedTestFiles: [],
        nearbyTestNames: [],
        candidateExistingCoverage: [],
      },
      simplificationSignals: [],
      workflowSignals: [],
      localizedPatchSignals: [],
      driftEvidence: [],
      previousAdvisorReview: null,
      github: null,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.outDir || "artifacts/pr-review-advisor";
  const baseRef = args.base || process.env.BASE_REF || "origin/main";
  const headRef = args.head || process.env.HEAD_REF || "HEAD";
  const schemaPath = args.schema || "tools/pr-review-advisor/schema.json";
  const artifacts = artifactPaths(outDir);
  const configDir =
    process.env.PR_REVIEW_ADVISOR_CONFIG_DIR ||
    path.join("/tmp", `nemoclaw-pr-review-advisor-config-${process.pid}`);
  const timeoutMs = parsePositiveInt(process.env.PR_REVIEW_ADVISOR_TIMEOUT_MS, 900000);
  const heartbeatMs = parsePositiveInt(process.env.PR_REVIEW_ADVISOR_HEARTBEAT_MS, 60000);
  const maxCaptureBytes = parsePositiveInt(
    process.env.PR_REVIEW_ADVISOR_MAX_CAPTURE_BYTES,
    5 * 1024 * 1024,
  );

  fs.mkdirSync(outDir, { recursive: true });

  logProgress(
    `Starting PR review advisor analysis: base=${baseRef} head=${headRef} outDir=${outDir}`,
  );
  let schema: Record<string, unknown>;
  let changedFiles: string[] = [];
  let headSha = "";
  let diff: string;
  let deterministic: DeterministicReviewContext;
  try {
    schema = readJson<Record<string, unknown>>(schemaPath);
    changedFiles = getChangedFiles(baseRef, headRef);
    headSha = getHeadSha(headRef);
    diff = getDiff(baseRef, headRef);
    deterministic = await collectDeterministicContext(
      { baseRef, headRef, headSha, changedFiles, diff },
      { collectGitHubContext: () => collectGitHubContext({ baseRef, headRef, headSha }) },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!headSha) {
      try {
        headSha = getHeadSha(headRef);
      } catch {
        headSha = "unavailable";
      }
    }
    try {
      writeUnavailableArtifacts(
        artifacts,
        preSessionFailureMetadata({ baseRef, headRef, headSha, changedFiles, reason }),
        reason,
        true,
      );
    } catch (artifactError) {
      console.error(
        `Could not write PR review advisor pre-session failure artifacts: ${artifactError instanceof Error ? artifactError.message : String(artifactError)}`,
      );
    }
    throw error;
  }
  // GitHub context is fully materialized before the model session starts. Keep
  // repository credentials out of the environment inherited by read-only tools.
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const metadata = { baseRef, headRef, headSha, changedFiles, deterministic };
  writeDeterministicContextArtifacts(artifacts, deterministic, diff);
  const findingLedger = createReviewFindingLedger();
  const terminologyLedger = createTerminologyLedger(headSha);
  const { systemPrompt, promptTurns } = preparePromptArtifacts({
    artifacts,
    metadata,
    diff,
    schema,
    findingLedger,
    terminologyLedger,
  });

  const writeFailure = (reason: string): void => writeFailureArtifacts(artifacts, metadata, reason);
  const writeUnavailable = (reason: string): void =>
    writeUnavailableArtifacts(artifacts, metadata, reason, false);

  if (process.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS === "0") {
    writeUnavailable(
      process.env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON || "PR_REVIEW_ADVISOR_RUN_ANALYSIS=0",
    );
    process.exit(0);
  }

  logProgress(
    `Launching PR review advisor SDK: provider=${ADVISOR_PROVIDER} model=${ADVISOR_MODEL}`,
  );
  let sdkResult: RunAdvisorResult | undefined;
  let submission: ReviewSubmissionController | undefined;
  try {
    const conversation = await runAdvisorConversation({
      promptTurns,
      systemPrompt,
      configDir,
      htmlExportPath: artifacts.sessionHtml,
      turnDir: artifacts.turnDir,
      timeoutMs,
      heartbeatMs,
      maxCaptureBytes,
      logPrefix: "pr-review-advisor",
      findingLedger,
      findingLedgerPath: artifacts.findingLedger,
      terminologyLedger,
      terminologyLedgerPath: artifacts.terminologyLedger,
      baseRef,
      headRef,
      metadata,
      schema,
    });
    sdkResult = conversation.run;
    submission = conversation.submission;
    fs.writeFileSync(artifacts.raw, sdkResult.raw);
    logProgress(`PR review advisor conversation finished: turns=${sdkResult.turnTexts.length}`);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!sdkResult) {
      fs.writeFileSync(artifacts.raw, `PR review advisor SDK execution failed: ${reason}\n`);
    }
    writeFailure(reason);
    process.exit(1);
  }

  const executionErrors = advisorExecutionErrors(sdkResult);
  if (executionErrors.length > 0) {
    writeFailure(`PR review advisor SDK execution failed: ${executionErrors.join("; ")}`);
    process.exit(1);
  }

  const submitted = submission?.result();
  if (!submitted) {
    writeFailure("PR review advisor did not atomically submit a review result");
    process.exit(1);
  }
  const result = submitted as ReviewAdvisorResult;
  writeJson(artifacts.findingLedger, submission!.findingSnapshot());
  writeJson(artifacts.terminologyLedger, submission!.terminologySnapshot());

  writeJson(artifacts.result, result);
  writeJson(artifacts.finalResult, result);
  const summary = renderSummary(result);
  fs.writeFileSync(artifacts.summary, summary);
  fs.writeFileSync(
    path.join(outDir, "pr-review-advisor-detailed-review.md"),
    renderDetailedReview(result),
  );
  console.log(summary);
}

export function preparePromptArtifacts({
  artifacts,
  metadata,
  diff,
  schema,
  findingLedger,
  terminologyLedger,
}: {
  artifacts: ArtifactPaths;
  metadata: ReviewMetadata;
  diff: string;
  schema: Record<string, unknown>;
  findingLedger: ReviewFindingLedger;
  terminologyLedger: TerminologyLedger;
}): { systemPrompt: string; promptTurns: AdvisorPromptTurn[] } {
  writeJson(artifacts.findingLedger, findingLedger.snapshot());
  writeJson(artifacts.terminologyLedger, terminologyLedger.snapshot());
  try {
    const systemPrompt = buildSystemPrompt();
    const promptTurns = buildPromptTurns({ metadata, diff, schema });
    writePromptArtifacts({ promptDir: artifacts.promptDir, systemPrompt, promptTurns });
    return { systemPrompt, promptTurns };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    writeFailureArtifacts(artifacts, metadata, reason);
    throw error;
  }
}

export function writeDeterministicContextArtifacts(
  paths: { contextDir: string },
  context: DeterministicReviewContext,
  diff: string,
): void {
  fs.rmSync(paths.contextDir, { recursive: true, force: true });
  fs.mkdirSync(paths.contextDir, { recursive: true });
  writeJson(path.join(paths.contextDir, "drift-context.json"), buildDriftTurnContext(context));
  writeJson(
    path.join(paths.contextDir, "security-context.json"),
    buildSecurityTurnContext(context),
  );
  writeJson(
    path.join(paths.contextDir, "validation-context.json"),
    buildValidationTurnContext(context),
  );
  fs.writeFileSync(path.join(paths.contextDir, "pr.diff"), diff || "");
  if (context.previousAdvisorReview?.body) {
    fs.writeFileSync(
      path.join(paths.contextDir, "previous-advisor-review.md"),
      context.previousAdvisorReview.body,
    );
  }
}

function writeUnavailableArtifacts(
  paths: ArtifactPaths,
  metadata: ReviewMetadata,
  reason: string,
  failed: boolean,
): void {
  const result = unavailableResult(metadata, reason, failed);
  writeJson(
    paths.result,
    failed
      ? { failed: true, reason, promptPath: paths.promptDir, rawPath: paths.raw }
      : { skipped: true, reason, promptPath: paths.promptDir },
  );
  writeJson(paths.finalResult, result);
  fs.writeFileSync(paths.summary, renderSummary(result));
  if (failed) {
    console.error(`PR review advisor analysis failed: ${reason}`);
  }
}

function writeFailureArtifacts(
  paths: ArtifactPaths,
  metadata: ReviewMetadata,
  reason: string,
): void {
  writeUnavailableArtifacts(paths, metadata, reason, true);
}

function logProgress(message: string): void {
  console.log(`[pr-review-advisor] ${new Date().toISOString()} ${message}`);
}

type AdvisorConversationOptions = {
  promptTurns: AdvisorPromptTurn[];
  systemPrompt: string;
  configDir: string;
  htmlExportPath: string;
  turnDir: string;
  timeoutMs: number;
  heartbeatMs: number;
  maxCaptureBytes: number;
  logPrefix: string;
  findingLedger: ReviewFindingLedger;
  findingLedgerPath: string;
  terminologyLedger: TerminologyLedger;
  terminologyLedgerPath: string;
  baseRef: string;
  headRef: string;
  metadata: ReviewMetadata;
  schema: Record<string, unknown>;
};

type AdvisorConversationResult = {
  run: RunAdvisorResult;
  submission: ReviewSubmissionController;
};

async function runAdvisorConversation(
  options: AdvisorConversationOptions,
): Promise<AdvisorConversationResult> {
  fs.rmSync(options.turnDir, { recursive: true, force: true });
  fs.mkdirSync(options.turnDir, { recursive: true });
  const terminologyTools = createTerminologyToolController({
    ledger: options.terminologyLedger,
    baseRef: options.baseRef,
    headRef: options.headRef,
  });
  const submission = createReviewSubmissionController({
    metadata: {
      baseRef: options.metadata.baseRef,
      headRef: options.metadata.headRef,
      headSha: options.metadata.headSha,
      changedFiles: options.metadata.changedFiles,
    },
    schema: options.schema,
    terminologyTraces: () => terminologyTools.traces(),
    normalizeE2e: (value) => normalizeCombinedE2eResult(value, options.metadata),
  });
  const result = await runReadOnlyAdvisor({
    cwd: root,
    promptTurns: options.promptTurns,
    systemPrompt: options.systemPrompt,
    configDir: options.configDir,
    htmlExportPath: options.htmlExportPath,
    timeoutMs: options.timeoutMs,
    heartbeatMs: options.heartbeatMs,
    maxCaptureBytes: options.maxCaptureBytes,
    provider: ADVISOR_PROVIDER,
    modelId: ADVISOR_MODEL,
    credentialEnv: ADVISOR_CREDENTIAL_ENV,
    logPrefix: options.logPrefix,
    logProgress,
    customTools: [...submission.tools, ...terminologyTools.tools],
    onTurnStart: (turn) => {
      terminologyTools.setStage(turn.name);
    },
    onTurnComplete: (turn) => {
      writeTurnArtifact(options.turnDir, turn);
      writeJson(options.findingLedgerPath, submission.findingSnapshot());
      writeJson(options.terminologyLedgerPath, submission.terminologySnapshot());
    },
  });
  return { run: result, submission };
}

export function advisorExecutionErrors(result: RunAdvisorResult): string[] {
  return advisorRunErrors(result);
}

export function reviewQualityIssues(result: ReviewAdvisorResult): string[] {
  const issues: string[] = [];
  const placeholderValues = new Set([
    "No description provided.",
    "Review manually.",
    "No evidence provided.",
    "No impact provided.",
    "No verification hint provided.",
    "No regression test recommendation provided.",
  ]);
  for (const [index, finding] of result.findings.entries()) {
    const prefix = `findings[${index + 1}] ${finding.title}`;
    for (const field of [
      "description",
      "impact",
      "recommendation",
      "verificationHint",
      "missingRegressionTest",
      "evidence",
    ] as const) {
      if (!finding[field].trim() || placeholderValues.has(finding[field])) {
        issues.push(`${prefix} has placeholder ${field}`);
      }
    }
  }
  if (
    result.securityCategories.some((category) =>
      category.justification.startsWith("Advisor did not provide a category-specific verdict"),
    )
  ) {
    issues.push("securityCategories were defaulted because the advisor omitted verdicts");
  }
  return issues.slice(0, 20);
}

export async function collectGitHubContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubReviewContext | null> {
  return collectGitHubReviewContext(env, {
    collectPreviousReview: ({ currentBaseSha, issueComments, prNumber, repo, token }) =>
      collectTrustedPreviousAdvisorReview(repo, token, issueComments, {
        marker: ADVISOR_COMMENT_MARKER,
        workflowName: ADVISOR_WORKFLOW_NAME,
        workflowPath: ADVISOR_WORKFLOW_PATH,
        prNumber,
        currentBaseSha,
      }),
  });
}

export function extractPreviousAdvisorReview(
  issueComments: unknown[],
  trustedCommentIds: ReadonlySet<string>,
  options: AdvisorReviewProvenanceOptions = {},
): PreviousAdvisorReview | null {
  const candidates = previousAdvisorCandidates(issueComments, advisorCommentMarker(options)).filter(
    (candidate) => trustedCommentIds.has(candidate.metadata.commentId),
  );
  const candidate = candidates.at(-1);
  return candidate ? { headSha: candidate.metadata.headSha, body: candidate.body } : null;
}

export type AdvisorReviewProvenanceOptions = {
  marker?: string;
  workflowName?: string;
  workflowPath?: string;
  prNumber?: number;
  currentBaseSha?: string;
};

export async function collectTrustedPreviousAdvisorReview(
  repo: string,
  token: string,
  issueComments: unknown[],
  options: AdvisorReviewProvenanceOptions = {},
): Promise<PreviousAdvisorReview | null> {
  // Kept with the deterministic context collector for now: the provenance
  // decision depends on GitHub issue comments, Actions-run metadata, and the
  // previous-review body that is injected into prompt context.
  //
  // Source-of-truth model: issue comments are mutable, replayable PR context.
  // A previous advisor comment is accepted only when its hidden metadata is
  // bound to the actual comment id and to the PR Review / Advisor workflow
  // path, attempt, event contract, and time window. Legacy pull_request runs
  // bind run.head_sha directly to the analyzed head. pull_request_target runs
  // instead bind the trusted workflow SHA and require one run.pull_requests
  // association whose PR number, head SHA, and base SHA match the current PR
  // context.
  // This intentionally accepts the residual same-run boundary: another
  // repository workflow would need to post a marker-bearing github-actions[bot]
  // comment during the same PR Review / Advisor run window while knowing the
  // run metadata. That is not a realistic cross-PR/user spoof, and preventing
  // it fully requires a durable GitHub comment-to-workflow ownership link that
  // the REST API does not currently expose. Remove this local provenance check
  // only if such a stronger ownership signal becomes available.

  const marker = advisorCommentMarker(options);
  const workflowName = advisorWorkflowName(options);
  const workflowPath = advisorWorkflowPath(options);
  const candidates = previousAdvisorCandidates(issueComments, marker);
  const trustedCommentIds = new Set<string>();
  for (const candidate of candidates) {
    if (
      await isTrustedAdvisorRun(repo, token, candidate, {
        workflowName,
        workflowPath,
        prNumber: options.prNumber,
        currentBaseSha: options.currentBaseSha,
      })
    ) {
      trustedCommentIds.add(candidate.metadata.commentId);
    }
  }
  return extractPreviousAdvisorReview(issueComments, trustedCommentIds, { marker });
}

type AdvisorCommentMetadata = {
  headSha: string;
  runId: string;
  runAttempt: string;
  commentId: string;
  recommendation: SummaryRecommendation;
  event?: string;
  prNumber?: string;
  workflowSha?: string;
  baseSha?: string;
  workflowPath?: string;
};

type PreviousAdvisorCandidate = {
  body: string;
  updatedAt: string;
  metadata: AdvisorCommentMetadata;
};

function previousAdvisorCandidates(
  issueComments: unknown[],
  marker: string,
): PreviousAdvisorCandidate[] {
  return issueComments.flatMap((comment) => {
    if (!hasAdvisorCommentAuthor(comment)) return [];
    const body = stringOrUndefined(getPath<unknown>(comment, ["body"]));
    if (!body?.includes(marker)) return [];
    const metadata = advisorHiddenMetadata(body);
    const commentId = getPath<number>(comment, ["id"]);
    const updatedAt = stringOrUndefined(getPath<unknown>(comment, ["updated_at"]));
    if (!metadata || String(commentId) !== metadata.commentId || !updatedAt) return [];
    return [{ body: body.slice(0, 12000), updatedAt, metadata }];
  });
}

function advisorHiddenMetadata(body: string): AdvisorCommentMetadata | undefined {
  const metadataComment = body.match(
    /<!--\s*head_sha:\s*([^;\s>]+)(?:;\s*recommendation:\s*([^;\s>]+))?(?:;\s*run_id:\s*([^;\s>]+))?(?:;\s*run_attempt:\s*([^;\s>]+))?(?:;\s*comment_id:\s*([^;\s>]+))?(?:;\s*event:\s*([^;\s>]+))?(?:;\s*pr_number:\s*([^;\s>]+))?(?:;\s*workflow_sha:\s*([^;\s>]+))?(?:;\s*base_sha:\s*([^;\s>]+))?(?:;\s*workflow_path:\s*([^;\s>]+))?\s*-->/i,
  );
  const headSha = metadataComment?.[1];
  const recommendation = metadataComment?.[2];
  const runId = metadataComment?.[3];
  const runAttempt = metadataComment?.[4];
  const commentId = metadataComment?.[5];
  const event = metadataComment?.[6];
  const prNumber = metadataComment?.[7];
  const workflowSha = metadataComment?.[8];
  const baseSha = metadataComment?.[9];
  const workflowPath = metadataComment?.[10];
  if (!headSha || !/^[0-9a-f]{7,40}$/i.test(headSha)) return undefined;
  if (
    !recommendation ||
    !SUMMARY_RECOMMENDATIONS.includes(recommendation as SummaryRecommendation)
  ) {
    return undefined;
  }
  if (!runId || !/^\d+$/.test(runId)) return undefined;
  if (!runAttempt || !/^\d+$/.test(runAttempt)) return undefined;
  if (!commentId || !/^\d+$/.test(commentId)) return undefined;
  if (event && event !== "pull_request_target") return undefined;
  if (prNumber && !/^\d+$/.test(prNumber)) return undefined;
  if (workflowSha && !/^[0-9a-f]{40}$/i.test(workflowSha)) return undefined;
  if (baseSha && !/^[0-9a-f]{40}$/i.test(baseSha)) return undefined;
  if (workflowPath && !isSafeWorkflowPath(workflowPath)) return undefined;
  return {
    headSha,
    recommendation: recommendation as SummaryRecommendation,
    runId,
    runAttempt,
    commentId,
    event,
    prNumber,
    workflowSha,
    baseSha,
    workflowPath,
  };
}

function isSafeWorkflowPath(value: string): boolean {
  return (
    value === normalizeWorkflowPath(value) &&
    value.startsWith(".github/workflows/") &&
    !value.includes("..") &&
    /^[A-Za-z0-9._/-]+$/u.test(value)
  );
}

function hasAdvisorCommentAuthor(comment: unknown): boolean {
  const author = stringOrUndefined(getPath<unknown>(comment, ["user", "login"]));
  return author === "github-actions[bot]";
}

function advisorCommentMarker(options: AdvisorReviewProvenanceOptions): string {
  return options.marker || DEFAULT_ADVISOR_COMMENT_MARKER;
}

function advisorWorkflowName(options: AdvisorReviewProvenanceOptions): string {
  return options.workflowName || DEFAULT_ADVISOR_WORKFLOW_NAME;
}

function advisorWorkflowPath(options: AdvisorReviewProvenanceOptions): string {
  return normalizeWorkflowPath(options.workflowPath || DEFAULT_ADVISOR_WORKFLOW_PATH);
}

function normalizeWorkflowPath(value: string): string {
  return value.split("@", 1)[0].replace(/\\/g, "/").replace(/^\/+/, "");
}

async function isTrustedAdvisorRun(
  repo: string,
  token: string,
  candidate: PreviousAdvisorCandidate,
  options: {
    workflowName: string;
    workflowPath: string;
    prNumber?: number;
    currentBaseSha?: string;
  },
): Promise<boolean> {
  try {
    const run = await githubRest<unknown>(
      `repos/${repo}/actions/runs/${candidate.metadata.runId}`,
      token,
    );
    const name = stringOrUndefined(getPath<unknown>(run, ["name"]));
    const headSha = stringOrUndefined(getPath<unknown>(run, ["head_sha"]));
    const event = stringOrUndefined(getPath<unknown>(run, ["event"]));
    const workflowPath = stringOrUndefined(getPath<unknown>(run, ["path"]));
    const runAttempt = getPath<number>(run, ["run_attempt"]);
    const startedAt =
      stringOrUndefined(getPath<unknown>(run, ["run_started_at"])) ||
      stringOrUndefined(getPath<unknown>(run, ["created_at"]));
    const updatedAt = stringOrUndefined(getPath<unknown>(run, ["updated_at"]));
    if (!startedAt || !updatedAt || !headSha || !workflowPath) return false;
    if (
      name !== options.workflowName ||
      normalizeWorkflowPath(workflowPath) !== options.workflowPath ||
      String(runAttempt) !== candidate.metadata.runAttempt ||
      !isTimestampWithin(candidate.updatedAt, startedAt, updatedAt)
    ) {
      return false;
    }
    if (event === "pull_request") {
      return headSha === candidate.metadata.headSha && !hasTargetEventMetadata(candidate.metadata);
    }
    if (event !== "pull_request_target") return false;
    if (
      !hasCompleteTargetEventMetadata(candidate.metadata) ||
      !options.prNumber ||
      !options.currentBaseSha
    ) {
      return false;
    }
    if (
      candidate.metadata.event !== event ||
      candidate.metadata.prNumber !== String(options.prNumber) ||
      candidate.metadata.workflowSha !== headSha ||
      candidate.metadata.baseSha !== options.currentBaseSha ||
      normalizeWorkflowPath(candidate.metadata.workflowPath) !== options.workflowPath
    ) {
      return false;
    }
    return hasUniquePullRequestAssociation(
      run,
      options.prNumber,
      candidate.metadata.headSha,
      candidate.metadata.baseSha,
    );
  } catch {
    return false;
  }
}

function hasTargetEventMetadata(metadata: AdvisorCommentMetadata): boolean {
  return Boolean(
    metadata.event ||
    metadata.prNumber ||
    metadata.workflowSha ||
    metadata.baseSha ||
    metadata.workflowPath,
  );
}

function hasCompleteTargetEventMetadata(
  metadata: AdvisorCommentMetadata,
): metadata is AdvisorCommentMetadata & {
  event: "pull_request_target";
  prNumber: string;
  workflowSha: string;
  baseSha: string;
  workflowPath: string;
} {
  return Boolean(
    metadata.event === "pull_request_target" &&
    metadata.prNumber &&
    metadata.workflowSha &&
    metadata.baseSha &&
    metadata.workflowPath,
  );
}

function hasUniquePullRequestAssociation(
  run: unknown,
  prNumber: number,
  headSha: string,
  baseSha: string,
): boolean {
  const pullRequests = recordItems(getPath<unknown>(run, ["pull_requests"]));
  if (pullRequests.length !== 1) return false;
  const pullRequest = pullRequests[0];
  return (
    getPath<number>(pullRequest, ["number"]) === prNumber &&
    stringOrUndefined(getPath<unknown>(pullRequest, ["head", "sha"])) === headSha &&
    stringOrUndefined(getPath<unknown>(pullRequest, ["base", "sha"])) === baseSha
  );
}

function isTimestampWithin(value: string, start: string, end: string): boolean {
  const valueTime = Date.parse(value);
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (![valueTime, startTime, endTime].every(Number.isFinite)) return false;
  return valueTime >= startTime && valueTime <= endTime;
}

export function parseSecurityRubric(rubric: string): {
  content: string;
  categories: string[];
} {
  const headings = [...rubric.matchAll(/^## Category (\d+): (.+)$/gmu)];
  if (headings.length !== SECURITY_CATEGORY_COUNT) {
    throw new Error(
      `Security rubric must define exactly ${SECURITY_CATEGORY_COUNT} categories; found ${headings.length}`,
    );
  }

  const categories = headings.map((heading, index) => {
    const number = Number(heading[1]);
    const name = heading[2]?.trim() ?? "";
    if (number !== index + 1 || !name) {
      throw new Error(`Security rubric category ${index + 1} has a malformed heading`);
    }
    const sectionStart = heading.index ?? 0;
    const sectionEnd = headings[index + 1]?.index ?? rubric.length;
    const section = rubric.slice(sectionStart, sectionEnd);
    const subsectionMatches = [...section.matchAll(/^### (.+)$/gmu)];
    const subsectionNames = subsectionMatches.map((match) => match[1]?.trim() ?? "");
    if (
      subsectionNames.length !== SECURITY_CATEGORY_SECTION_NAMES.length ||
      !SECURITY_CATEGORY_SECTION_NAMES.every(
        (sectionName, index) => sectionName === subsectionNames[index],
      )
    ) {
      throw new Error(
        `Security rubric category ${number} must define Meaning, Questions, and Expected evidence in order`,
      );
    }
    for (const [sectionIndex, sectionName] of SECURITY_CATEGORY_SECTION_NAMES.entries()) {
      const contentStart =
        (subsectionMatches[sectionIndex]?.index ?? section.length) + `### ${sectionName}`.length;
      const contentEnd = subsectionMatches[sectionIndex + 1]?.index ?? section.length;
      if (!section.slice(contentStart, contentEnd).trim()) {
        throw new Error(`Security rubric category ${number} has empty ${sectionName}`);
      }
    }
    return name;
  });

  if (new Set(categories).size !== categories.length) {
    throw new Error("Security rubric category names must be unique");
  }
  if (categories.at(-1) !== "System Security") {
    throw new Error("Security rubric category 9 must be System Security");
  }
  return { content: rubric, categories };
}

export function buildPromptTurns({
  metadata,
  diff,
}: {
  metadata: ReviewMetadata;
  diff: string;
  schema: Record<string, unknown>;
}): AdvisorPromptTurn[] {
  const context = metadata.deterministic;
  return [
    buildInvestigateTurn({
      metadata: metadataFields(metadata),
      scopeRisk: buildScopeRiskTurnContext(context),
      diff,
      controlledWords: readTrustedControlledWords(),
      terminology: {
        issueReferenceLines: context.github?.issueReferenceLines ?? [],
        linkedIssues: context.github?.linkedIssues ?? [],
        githubFetchError: context.github?.fetchError,
      },
      correctness: buildCorrectnessTurnContext(context),
      security: buildSecurityTurnContext(context),
      tests: buildTestsTurnContext(context),
      operations: buildOperationsTurnContext(context),
      reconciliation: buildReconciliationTurnContext(context),
    }),
    buildChallengeAndRecordTurn(),
  ];
}

function metadataFields(metadata: ReviewMetadata): string {
  const changedFiles = JSON.stringify(metadata.changedFiles);
  const bounded =
    metadata.changedFiles.length <= METADATA_CHANGED_FILE_LIMIT &&
    Buffer.byteLength(changedFiles, "utf8") <= METADATA_CHANGED_FILE_BYTE_LIMIT;
  return [
    "- version: 1",
    `- baseRef: ${JSON.stringify(metadata.baseRef)}`,
    `- headRef: ${JSON.stringify(metadata.headRef)}`,
    `- headSha: ${JSON.stringify(metadata.headSha)}`,
    bounded
      ? `- changedFiles: ${changedFiles}`
      : `- changedFiles: [] (return an empty array; the runner restores all ${metadata.changedFiles.length} deterministic changed-file path(s) after parsing)`,
  ].join("\n");
}

export function normalizeReviewResult(
  result: unknown,
  metadata: ReviewMetadata,
): ReviewAdvisorResult {
  if (!isObjectRecord(result)) throw new Error("PR review advisor returned a non-object result");
  const object = result as Record<string, unknown>;
  const sourceOfTruthReview = sanitizeSourceOfTruthReview(object.sourceOfTruthReview);
  return {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    headSha: metadata.headSha,
    changedFiles: metadata.changedFiles,
    summary: sanitizeSummary(object.summary),
    findings: sanitizeFindings(object.findings),
    terminologyReview: sanitizeTerminologyReview(object.terminologyReview, metadata.headSha),
    acceptanceCoverage: sanitizeAcceptanceCoverage(object.acceptanceCoverage),
    securityCategories: sanitizeSecurityCategories(object.securityCategories),
    sourceOfTruthReview,
    e2e: normalizeCombinedE2eResult(object.e2e, metadata),
    testDepth: sanitizeTestDepth(object.testDepth, metadata.deterministic.testDepth),
    positives: stringArray(object.positives).slice(0, 12),
    reviewCompleteness: sanitizeReviewCompleteness(object.reviewCompleteness),
  };
}

function sanitizeTerminologyReview(value: unknown, headSha: string): TerminologyReview {
  const object = isObjectRecord(value) ? value : {};
  const decisions = recordItems(object.decisions)
    .slice(0, 20)
    .map((item, index) => {
      const source = isObjectRecord(item.source) ? item.source : {};
      const contrast = stringOrUndefined(item.contrast);
      const existingTerm = stringOrUndefined(item.existingTerm);
      return {
        id: /^T-[0-9]+$/u.test(stringOrDefault(item.id, ""))
          ? stringOrDefault(item.id, "")
          : `T-${String(index + 1).padStart(3, "0")}`,
        term: stringOrDefault(item.term, "unspecified term"),
        change: enumValue(item.change, TERMINOLOGY_CHANGES, "introduced"),
        disposition: enumValue(item.disposition, TERMINOLOGY_DISPOSITIONS, "define"),
        meaning: stringOrDefault(item.meaning, "Meaning was not supplied."),
        contrast: contrast ?? null,
        existingTerm: existingTerm ?? null,
        semanticImpact: enumValue(item.semanticImpact, TERMINOLOGY_SEMANTIC_IMPACTS, "none"),
        recommendation: stringOrDefault(item.recommendation, "Clarify the term."),
        traceId: stringOrDefault(item.traceId, "missing-trace"),
        source: {
          file: stringOrDefault(source.file, "unknown"),
          line: Math.max(1, Number.isInteger(source.line) ? Number(source.line) : 1),
          headSha,
        },
      };
    });
  const status = enumValue(
    object.status,
    TERMINOLOGY_STATUSES,
    decisions.length > 0 ? "candidates" : "limited",
  );
  return {
    status,
    decisions,
    noChangesReason: stringOrUndefined(object.noChangesReason) ?? null,
  };
}

export function normalizeCombinedE2eResult(
  value: unknown,
  metadata: ReviewMetadata,
): CombinedE2eResult {
  const object = isObjectRecord(value) ? value : {};
  const recommendationMetadata = {
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    changedFiles: metadata.changedFiles,
  };
  const coverage = normalizeE2eCoverageResult(
    object.coverage,
    recommendationMetadata,
    metadata.deterministic.riskPlan,
  );
  const inventory = trustedE2eRecommendationInventory();
  const selectorTypes = new Map<string, "job" | "target">([
    ...inventory.allowedJobIds.map((id) => [id, "job"] as const),
    ...inventory.manualOnlyJobIds.map((id) => [id, "job"] as const),
    ...inventory.liveSupportedTargetIds.map((id) => [id, "target"] as const),
  ]);
  const targetInput = isObjectRecord(object.targets) ? object.targets : {};
  const coverageTargets = (
    tests: E2eCoverageResult["requiredTests"],
    required: boolean,
  ): Array<Record<string, unknown>> =>
    tests.flatMap((test) => {
      const selectorType = selectorTypes.get(test.id);
      return selectorType
        ? [
            {
              id: test.id,
              workflow: inventory.workflow,
              selectorType,
              required,
              reason: "Align this trusted selector with the normalized coverage decision.",
            },
          ]
        : [];
    });
  const normalizedTargets = normalizeE2eTargetAdvisorResult(
    {
      ...targetInput,
      required: [
        ...recordItems(targetInput.required),
        ...coverageTargets(coverage.requiredTests, true),
      ],
      optional: [
        ...recordItems(targetInput.optional),
        ...coverageTargets(coverage.optionalTests, false),
      ],
    },
    recommendationMetadata,
    { riskPlan: metadata.deterministic.riskPlan },
  );
  return reconcileCombinedE2eResult({
    coverage,
    targets: {
      relevantChangedFiles: normalizedTargets.relevantChangedFiles,
      changedCredentialFreeTests: normalizedTargets.changedCredentialFreeTests.map((test) => ({
        ...test,
        headSha: metadata.headSha,
      })),
      required: normalizedTargets.required,
      optional: normalizedTargets.optional,
      noTargetE2eReason: normalizedTargets.noTargetE2eReason,
      confidence: normalizedTargets.confidence,
    },
  });
}

function reconcileCombinedE2eResult(result: CombinedE2eResult): CombinedE2eResult {
  const inventory = trustedE2eRecommendationInventory();
  const regularIds = new Set([
    ...inventory.allowedJobIds,
    ...inventory.manualOnlyJobIds,
    ...inventory.liveSupportedTargetIds,
  ]);
  const requiredIds = [
    ...new Set([
      ...result.coverage.requiredTests.map((item) => item.id),
      ...result.targets.required.filter((item) => regularIds.has(item.id)).map((item) => item.id),
    ]),
  ];
  const requiredIdSet = new Set(requiredIds);
  const optionalIds = [
    ...new Set([
      ...result.coverage.optionalTests.map((item) => item.id),
      ...result.targets.optional.filter((item) => regularIds.has(item.id)).map((item) => item.id),
    ]),
  ].filter((id) => !requiredIdSet.has(id));
  const coverageById = new Map(
    [...result.coverage.requiredTests, ...result.coverage.optionalTests].map((item) => [
      item.id,
      item,
    ]),
  );
  const alignedCoverage = (ids: readonly string[]): E2eCoverageResult["requiredTests"] =>
    ids.map(
      (id) =>
        coverageById.get(id) ?? {
          id,
          reason: `Selected from the trusted checked-in E2E coverage inventory.`,
        },
    );
  const requiredCoverage = alignedCoverage(requiredIds);
  const optionalCoverage = alignedCoverage(optionalIds);
  return {
    coverage: {
      ...result.coverage,
      requiredTests: requiredCoverage,
      optionalTests: optionalCoverage,
      noE2eReason:
        requiredCoverage.length > 0 || optionalCoverage.length > 0
          ? null
          : "No deterministic or trusted-inventory E2E coverage was selected.",
      confidence:
        requiredCoverage.length > 0 && result.coverage.confidence === "low"
          ? "medium"
          : result.coverage.confidence,
    },
    targets: result.targets,
  };
}

function sanitizeSummary(value: unknown): ReviewAdvisorResult["summary"] {
  const object = isObjectRecord(value) ? value : {};
  return {
    recommendation: enumValue(object.recommendation, SUMMARY_RECOMMENDATIONS, "info_only"),
    confidence: enumValue(object.confidence, CONFIDENCES, "medium"),
    oneLine: stringOrDefault(object.oneLine, "PR review advisor completed with limited summary."),
    topItem:
      typeof object.topItem === "string" && object.topItem.trim()
        ? object.topItem.trim()
        : undefined,
    sinceLastReview: sanitizeSinceLastReview(object.sinceLastReview),
  };
}

function sanitizeSinceLastReview(
  value: unknown,
): ReviewAdvisorResult["summary"]["sinceLastReview"] {
  if (!isObjectRecord(value)) return undefined;
  return {
    resolved: nonNegativeInteger(value.resolved),
    stillApplies: nonNegativeInteger(value.stillApplies),
    newItems: nonNegativeInteger(value.newItems),
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function sanitizeFindings(value: unknown): Finding[] {
  return recordItems(value)
    .map((item) => ({
      severity: enumValue(
        item.severity,
        ["blocker", "warning", "suggestion"] as const,
        "suggestion",
      ),
      category: enumValue(item.category, FINDING_CATEGORIES, "correctness"),
      file: typeof item.file === "string" ? item.file : null,
      line:
        typeof item.line === "number" && Number.isInteger(item.line) && item.line > 0
          ? item.line
          : null,
      title: stringOrDefault(item.title, "Review finding"),
      description: stringOrDefault(item.description, "No description provided."),
      impact: stringOrDefault(item.impact, "No impact provided."),
      recommendation: stringOrDefault(item.recommendation, "Review manually."),
      verificationHint: stringOrDefault(item.verificationHint, "No verification hint provided."),
      missingRegressionTest: stringOrDefault(
        item.missingRegressionTest,
        "No regression test recommendation provided.",
      ),
      evidence: stringOrDefault(item.evidence, "No evidence provided."),
      simplification: sanitizeSimplification(item.simplification),
    }))
    .slice(0, 50);
}

function sanitizeSimplification(value: unknown): SimplificationFinding | undefined {
  if (!isObjectRecord(value)) return undefined;
  const tag = enumValue(value.tag, SIMPLIFICATION_TAGS, "shrink");
  return {
    tag,
    cut: stringOrDefault(value.cut, "Unspecified code to simplify."),
    replacement: stringOrDefault(value.replacement, "Use the simpler existing path."),
    estimatedNetLines:
      typeof value.estimatedNetLines === "number" && Number.isInteger(value.estimatedNetLines)
        ? value.estimatedNetLines
        : null,
    safetyBoundary: stringOrDefault(
      value.safetyBoundary,
      "Do not remove validation, security, data-loss prevention, or required test coverage.",
    ),
  };
}

function sanitizeAcceptanceCoverage(value: unknown): AcceptanceCoverage[] {
  return recordItems(value)
    .map((item) => ({
      clause: stringOrDefault(item.clause, "Unspecified acceptance clause"),
      status: enumValue(item.status, ACCEPTANCE_STATUSES, "unknown"),
      evidence: stringOrDefault(item.evidence, "No evidence provided."),
    }))
    .slice(0, 100);
}

function sanitizeSecurityCategories(value: unknown): SecurityCategory[] {
  const securityCategories = readSecurityCategoryNames();
  const provided = new Map(
    recordItems(value).flatMap((item) => {
      const category = stringOrDefault(item.category, "");
      if (!securityCategories.includes(category)) return [];
      return [
        [
          category,
          {
            category,
            verdict: enumValue(item.verdict, SECURITY_VERDICTS, "warning"),
            justification: stringOrDefault(item.justification, "No justification provided."),
          },
        ] as const,
      ];
    }),
  );
  return securityCategories.map((category) => ({
    ...(provided.get(category) ?? {
      category,
      verdict: "warning" as const,
      justification:
        "Advisor did not provide a category-specific verdict; maintainer review required.",
    }),
  }));
}

function sanitizeSourceOfTruthReview(value: unknown): SourceOfTruthReview[] {
  return recordItems(value)
    .map((item, index) => ({
      surface: stringOrDefault(item.surface, "Unspecified localized patch surface"),
      status: enumValue(item.status, SOURCE_OF_TRUTH_STATUSES, "not_applicable"),
      findingId: sourceOfTruthFindingId(item, index),
      invalidState: stringOrDefault(item.invalidState, "Not specified."),
      sourceBoundary: stringOrDefault(item.sourceBoundary, "Not specified."),
      whyNotSourceFix: stringOrDefault(item.whyNotSourceFix, "Not specified."),
      regressionTest: stringOrDefault(item.regressionTest, "Not specified."),
      removalCondition: stringOrDefault(item.removalCondition, "Not specified."),
      evidence: stringOrDefault(item.evidence, "No evidence provided."),
    }))
    .slice(0, 50);
}

function sourceOfTruthFindingId(item: Record<string, unknown>, index: number): string | null {
  if (!Object.hasOwn(item, "findingId")) {
    throw new Error(`sourceOfTruthReview[${index + 1}] must include findingId`);
  }
  if (item.findingId === null) return null;
  if (typeof item.findingId === "string" && /^F-\d+$/u.test(item.findingId.trim())) {
    return item.findingId.trim();
  }
  throw new Error(`sourceOfTruthReview[${index + 1}].findingId must be null or an F-... ID`);
}

export function sanitizeTestDepth(
  value: unknown,
  fallback: ReviewAdvisorResult["testDepth"],
): ReviewAdvisorResult["testDepth"] {
  const object = isObjectRecord(value) ? value : {};
  const requestedVerdict = enumValue(object.verdict, TEST_DEPTH_VERDICTS, fallback.verdict);
  const verdictRank: Record<TestDepthVerdict, number> = {
    unknown: 0,
    unit_sufficient: 1,
    mocks_recommended: 2,
    runtime_validation_recommended: 3,
  };
  const enforceDeterministicFloor = verdictRank[fallback.verdict] >= verdictRank.mocks_recommended;
  const verdict =
    enforceDeterministicFloor && verdictRank[requestedVerdict] < verdictRank[fallback.verdict]
      ? fallback.verdict
      : requestedVerdict;
  const requestedRationale = stringOrDefault(object.rationale, fallback.rationale);
  const requestedTests = stringArray(object.suggestedTests);
  const deterministicTests = enforceDeterministicFloor ? fallback.suggestedTests : [];
  const deterministicUnique = deterministicTests
    .filter((test, index, tests) => tests.indexOf(test) === index)
    .slice(0, 20);
  const requestedUnique = requestedTests
    .filter((test) => !deterministicUnique.includes(test))
    .filter((test, index, tests) => tests.indexOf(test) === index)
    .slice(0, Math.max(0, 20 - deterministicUnique.length));
  const suggestedTests = Array.from(
    { length: Math.max(deterministicUnique.length, requestedUnique.length) },
    (_value, index) => [deterministicUnique[index], requestedUnique[index]],
  )
    .flat()
    .filter((test): test is string => Boolean(test))
    .slice(0, 20);
  return {
    verdict,
    rationale: enforceDeterministicFloor
      ? [...new Set([fallback.rationale, requestedRationale])].join(" ")
      : requestedRationale,
    suggestedTests,
  };
}

function sanitizeReviewCompleteness(value: unknown): ReviewAdvisorResult["reviewCompleteness"] {
  const object = isObjectRecord(value) ? value : {};
  const limitations = stringArray(object.limitations);
  return {
    limitations:
      limitations.length > 0 ? limitations : ["A maintainer must review this PR before merge."],
    requiresHumanReview: true,
  };
}

function unavailableResult(
  metadata: ReviewMetadata,
  reason: string,
  failed: boolean,
): ReviewAdvisorResult {
  return {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    headSha: metadata.headSha,
    changedFiles: metadata.changedFiles,
    summary: {
      recommendation: "info_only",
      confidence: "low",
      oneLine: failed
        ? `PR review advisor failed: ${reason}`
        : `PR review advisor skipped: ${reason}`,
    },
    findings: [],
    terminologyReview: {
      status: "limited",
      decisions: [],
      noChangesReason: failed
        ? `Advisor execution failed: ${reason}`
        : `Advisor execution skipped: ${reason}`,
    },
    acceptanceCoverage: [],
    securityCategories: [],
    sourceOfTruthReview: [],
    e2e: normalizeCombinedE2eResult({}, metadata),
    testDepth: metadata.deterministic.testDepth,
    positives: [],
    reviewCompleteness: {
      limitations: [
        failed ? `Advisor execution failed: ${reason}` : `Advisor execution skipped: ${reason}`,
      ],
      requiresHumanReview: true,
    },
  };
}
