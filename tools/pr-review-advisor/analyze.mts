#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
import { parseArgs, parsePositiveInt, readJson, writeJson } from "../advisors/io.mts";
import {
  enumValue,
  isObjectRecord,
  recordItems,
  stringArray,
  stringOrDefault,
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
import { artifactPaths, type ArtifactPaths } from "./artifacts.mts";
import { buildChallengeAndRecordTurn } from "./challenge-and-record-turn.mts";
import {
  collectDeterministicContext,
  type DeterministicReviewContext,
} from "./deterministic-context.mts";
import { buildInvestigateTurn } from "./investigate-turn.mts";
import { validateSpecialistSessionDirectory } from "./specialist-sessions.mts";
import { buildSynthesisTurn } from "./synthesis-turn.mts";
import { renderSummary } from "./render-result.mts";
import {
  buildCorrectnessTurnContext,
  buildOperationsTurnContext,
  buildReconciliationTurnContext,
  buildScopeRiskTurnContext,
  buildSecurityTurnContext,
  buildTestsTurnContext,
} from "./turn-context.mts";
import {
  buildSystemPrompt,
  readParsedTrustedSecurityRubric,
  readSecurityCategoryNames,
  readTrustedControlledWords,
} from "./trusted-guidance.mts";
import {
  collectGitHubReviewContext,
  hasOpenPrReplacement,
  type GitHubReviewContext,
  readPreparedGitHubContext,
} from "./github-context.mts";
import {
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_SIMPLIFICATION_TAGS,
} from "./review-ledger.mts";
import {
  createReviewSubmissionController,
  type ReviewSubmissionController,
} from "./review-submission.mts";
import {
  createTerminologyToolController,
  TERMINOLOGY_CHANGES,
  TERMINOLOGY_DISPOSITIONS,
  TERMINOLOGY_SEMANTIC_IMPACTS,
  TERMINOLOGY_TRACE_TOOL,
  type TerminologyReview,
} from "./terminology.mts";

const root = process.cwd();
const ADVISOR_PROVIDER = DEFAULT_ADVISOR_PROVIDER;
const ADVISOR_MODEL = process.env.PR_REVIEW_ADVISOR_MODEL || DEFAULT_ADVISOR_MODEL;
const ADVISOR_CREDENTIAL_ENV = ["PR", "REVIEW", "ADVISOR", "API", "KEY"].join("_");
const RISK_CONTEXT_PATH_SAMPLE_LIMIT = 20;
const RISK_CONTEXT_PATH_CHARACTER_LIMIT = 240;
const METADATA_CHANGED_FILE_LIMIT = 20;
const METADATA_CHANGED_FILE_BYTE_LIMIT = 8192;
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
const ACCEPTANCE_STATUSES = ["met", "partial", "missing", "unknown"] as const;
const SECURITY_VERDICTS = ["pass", "warning", "fail"] as const;
const SOURCE_OF_TRUTH_STATUSES = [
  "not_applicable",
  "satisfied",
  "needs_followup",
  "missing",
] as const;
const TERMINOLOGY_STATUSES = ["clear", "candidates", "limited"] as const;
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

export type ReviewAdvisorResult = {
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
  const { systemPrompt, promptTurns, securityCategoryNames, resultLimitations } =
    preparePromptArtifacts({
      artifacts,
      metadata,
      diff,
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
      timeoutMs,
      heartbeatMs,
      maxCaptureBytes,
      logPrefix: "pr-review-advisor",
      baseRef,
      headRef,
      metadata,
      schema,
      securityCategoryNames,
    });
    sdkResult = conversation.run;
    submission = conversation.submission;
    logProgress(`PR review advisor conversation finished: turns=${sdkResult.turnTexts.length}`);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    writeFailure(reason);
    process.exit(1);
  }

  let result: ReviewAdvisorResult;
  try {
    result = persistSuccessfulReview(
      advisorExecutionErrors(sdkResult),
      submission!,
      artifacts,
      undefined,
      resultLimitations,
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    writeFailure(reason);
    process.exit(1);
  }
  const summary = renderSummary(result);
  fs.writeFileSync(artifacts.summary, summary);
  console.log(summary);
}

export function persistSuccessfulReview(
  executionErrors: readonly string[],
  submission: ReviewSubmissionController,
  artifacts: ArtifactPaths,
  write: (path: string, value: unknown) => void = writeJson,
  requiredLimitations: readonly string[] = [],
): ReviewAdvisorResult {
  if (executionErrors.length > 0) {
    throw new Error(`PR review advisor SDK execution failed: ${executionErrors.join("; ")}`);
  }
  const submitted = submission.result();
  if (!submitted) {
    throw new Error("PR review advisor did not atomically submit a review result");
  }
  const submittedResult = submitted as ReviewAdvisorResult;
  const result =
    requiredLimitations.length === 0
      ? submittedResult
      : {
          ...submittedResult,
          reviewCompleteness: {
            ...submittedResult.reviewCompleteness,
            limitations: [
              ...new Set([
                ...submittedResult.reviewCompleteness.limitations,
                ...requiredLimitations,
              ]),
            ],
          },
        };
  write(artifacts.result, result);
  write(artifacts.finalResult, result);
  return result;
}

export function preparePromptArtifacts({
  artifacts,
  metadata,
  diff,
}: {
  artifacts: ArtifactPaths;
  metadata: ReviewMetadata;
  diff: string;
}): {
  systemPrompt: string;
  promptTurns: AdvisorPromptTurn[];
  securityCategoryNames: string[];
  resultLimitations: string[];
} {
  try {
    const securityRubric = readParsedTrustedSecurityRubric();
    const systemPrompt = buildSystemPrompt(securityRubric);
    const specialistSessionDirectory = process.env.PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR;
    const specialistInventory = specialistSessionDirectory
      ? validateSpecialistSessionDirectory(specialistSessionDirectory)
      : undefined;
    const promptTurns = specialistInventory
      ? [buildSynthesisTurn(specialistInventory), buildChallengeAndRecordTurn()]
      : buildPromptTurns({ metadata, diff });
    const resultLimitations =
      specialistInventory?.missing.map(
        (interest) =>
          `Specialist trace unavailable: ${interest}; synthesis did not receive dedicated ${interest} review.`,
      ) ?? [];
    return {
      systemPrompt,
      promptTurns,
      securityCategoryNames: securityRubric.categories,
      resultLimitations,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    writeFailureArtifacts(artifacts, metadata, reason);
    throw error;
  }
}

function writeUnavailableArtifacts(
  paths: ArtifactPaths,
  metadata: ReviewMetadata,
  reason: string,
  failed: boolean,
): void {
  const result = unavailableResult(metadata, reason, failed);
  writeJson(paths.result, failed ? { failed: true, reason } : { skipped: true, reason });
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
  timeoutMs: number;
  heartbeatMs: number;
  maxCaptureBytes: number;
  logPrefix: string;
  baseRef: string;
  headRef: string;
  metadata: ReviewMetadata;
  schema: Record<string, unknown>;
  securityCategoryNames: readonly string[];
};

type AdvisorConversationResult = {
  run: RunAdvisorResult;
  submission: ReviewSubmissionController;
};

async function runAdvisorConversation(
  options: AdvisorConversationOptions,
): Promise<AdvisorConversationResult> {
  const terminologyTools = createTerminologyToolController({
    baseRef: options.baseRef,
    headRef: options.headRef,
  });
  const submission = createReviewSubmissionController({
    metadata: {
      baseRef: options.metadata.baseRef,
      headRef: options.metadata.headRef,
      headSha: options.metadata.headSha,
      changedFiles: options.metadata.changedFiles,
      deterministic: {
        testDepth: options.metadata.deterministic.testDepth,
        hasOpenPrReplacement: hasOpenPrReplacement(
          options.metadata.deterministic.github?.openPrOverlaps,
        ),
      },
    },
    schema: options.schema,
    repositoryRoot: root,
    securityCategoryNames: options.securityCategoryNames,
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
    onTurnComplete: (turn) => applyReviewSubmissionTurn(submission, turn),
  });
  return { run: result, submission };
}

export function applyReviewSubmissionTurn(
  submission: ReviewSubmissionController,
  turn: AdvisorCompletedTurn,
): void {
  try {
    if (turn.status === "completed" && turn.name === "challenge-and-record") {
      submission.finalize();
    } else if (turn.status !== "completed") {
      submission.discard();
    }
  } catch (error) {
    submission.discard();
    throw error;
  }
}

export function advisorExecutionErrors(result: RunAdvisorResult): string[] {
  return advisorRunErrors(result);
}

export async function collectGitHubContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitHubReviewContext | null> {
  return collectGitHubReviewContext(env);
}

export function buildPromptTurns({
  metadata,
  diff,
}: {
  metadata: ReviewMetadata;
  diff: string;
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
