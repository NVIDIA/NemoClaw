// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

// These modules resolve relative to the trusted advisor implementation, not
// the analyzed PR worktree. PR-provided TypeScript is never imported.
import { getTarget, listTargets } from "../../test/e2e/registry/registry.ts";
import { liveTargetSupport } from "../../test/e2e/registry/runtime-support.ts";
import { moduleTagDeclarations } from "../e2e/module-tags.mts";
import { dropUndefinedValues, enumValue, recordItems, stringOrUndefined } from "./json.mts";
import { buildRiskPlan, type RiskPlan } from "./risk-plan.mts";

const E2E_WORKFLOW = "e2e.yaml";
const E2E_WORKFLOW_PATH = `.github/workflows/${E2E_WORKFLOW}`;
const TRUSTED_REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const E2E_ALL_ID = "e2e-all";
const CREDENTIAL_FREE_TEST_TAG = "e2e/credential-free";
const SHARED_E2E_JOB_ID = "shared-e2e";
const REGISTRY_LIVE_ENTRYPOINT = "test/e2e/live/registry-targets.test.ts";
const FREE_STANDING_LIVE_TEST_PATTERN = /^test\/e2e\/live\/[^/]+\.test\.ts$/;
const FREE_STANDING_LIVE_FILE_PATTERN = /^test\/e2e\/live\/[^/]+\.ts$/;
const ALLOWED_WORKFLOWS = new Set<string>([E2E_WORKFLOW]);
const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CONFIDENCES = ["low", "medium", "high"] as const;
const CLOUD_ONBOARD_E2E_PATTERNS: readonly RegExp[] = [
  /^src\/lib\/onboard(?:\.ts|\/)/,
  /^src\/lib\/trace\.ts$/,
  /^scripts\/scorecard\/analyze-trace-timing\.ts$/,
  /^ci\/onboard-performance-budget\.json$/,
  /^scripts\/e2e\/sanitize-trace-timing\.py$/,
  /^\.github\/actions\/(?:prepare-e2e|upload-e2e-artifacts)\//,
  /^\.github\/workflows\/e2e\.yaml$/,
  /^test\/e2e\/live\/cloud-onboard\.test\.ts$/,
];

export type E2eConfidence = (typeof CONFIDENCES)[number];
export type E2eSelectorType = "all" | "target" | "job";

export type E2eCoverageDomain = {
  domain?: string;
  reason?: string;
  confidence: E2eConfidence;
  matchedFiles: string[];
};

export type E2eCoverageTest = {
  id?: string;
  reason?: string;
  workflow?: string;
  job?: string;
  script?: string;
  cost?: string;
  runner?: string;
};

export type E2eNewRecommendation = {
  domain?: string;
  reason?: string;
  suggestedTest?: string;
  priority: E2eConfidence;
};

export type E2eCoverageResult = {
  classifiedDomains: E2eCoverageDomain[];
  requiredTests: E2eCoverageTest[];
  optionalTests: E2eCoverageTest[];
  newE2eRecommendations: E2eNewRecommendation[];
  noE2eReason: string | null;
  confidence: E2eConfidence;
};

export type E2eTargetRecommendation = {
  id: string;
  workflow: string;
  selectorType: E2eSelectorType;
  target?: string;
  suiteFilter?: string;
  required: boolean;
  reason: string;
};

export type E2eWorkflowJob = {
  id: string;
  liveTestFiles: string[];
};

export type E2eTargetAdvisorResult = {
  version: 1;
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  relevantChangedFiles: string[];
  required: E2eTargetRecommendation[];
  optional: E2eTargetRecommendation[];
  noTargetE2eReason: string | null;
  confidence: E2eConfidence;
};

export type E2eRecommendationMetadata = {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
};

export type TrustedE2eRecommendationInventory = {
  workflow: "e2e.yaml";
  fanoutId: "e2e-all";
  selectorTypes: E2eSelectorType[];
  allowedJobIds: string[];
  liveSupportedTargetIds: string[];
};

type E2eTargetNormalizationContext = {
  e2eWorkflowText?: string;
  freeStandingJobs: E2eWorkflowJob[];
  allowedJobIds: Set<string>;
  liveTestToJobs: Map<string, string[]>;
};

type CredentialFreeTestRow = {
  id: string;
  file: string;
};

export function trustedE2eRecommendationInventory(): TrustedE2eRecommendationInventory {
  return {
    workflow: E2E_WORKFLOW,
    fanoutId: E2E_ALL_ID,
    selectorTypes: ["all", "target", "job"],
    allowedJobIds: trustedAllowedJobIds(),
    liveSupportedTargetIds: listTargets()
      .filter((target) => liveTargetSupport(target).supported)
      .map((target) => target.id)
      .sort(),
  };
}

export function normalizeE2eCoverageResult(
  value: unknown,
  metadata: E2eRecommendationMetadata,
  riskPlan = buildRiskPlan({ headSha: "coverage-normalize", changedFiles: metadata.changedFiles }),
): E2eCoverageResult {
  const object = isRecord(value) ? value : {};
  const requiredTests = sanitizeCoverageTests(object.requiredTests);
  const requiredIds = new Set(
    requiredTests.flatMap((test) =>
      [test.id, test.job].filter((item): item is string => Boolean(item)),
    ),
  );
  for (const job of riskPlan.requiredJobs) {
    if (requiredIds.has(job.id)) continue;
    requiredIds.add(job.id);
    requiredTests.push({
      id: job.id,
      workflow: E2E_WORKFLOW,
      job: job.id,
      cost: job.tier === 3 ? "high" : "medium",
      reason: job.reasons.join(" "),
    });
  }
  if (requiresCloudOnboardE2e(metadata.changedFiles) && !requiredIds.has("cloud-onboard")) {
    requiredIds.add("cloud-onboard");
    requiredTests.push({
      id: "cloud-onboard",
      workflow: E2E_WORKFLOW,
      job: "cloud-onboard",
      script: "test/e2e/live/cloud-onboard.test.ts",
      cost: "high",
      runner: "ubuntu-latest",
      reason:
        "Changed onboard, trace timing, scorecard, or E2E workflow code can affect cloud onboard wall-clock behavior and should refresh the trusted cloud-onboard trace timing signal.",
    });
  }

  const classifiedDomains = sanitizeCoverageDomains(object.classifiedDomains);
  const classifiedNames = new Set(classifiedDomains.map((domain) => domain.domain));
  for (const family of riskPlan.families) {
    if (classifiedNames.has(family.id)) continue;
    classifiedNames.add(family.id);
    classifiedDomains.push({
      domain: family.id,
      reason: family.summary,
      confidence: "high",
      matchedFiles: family.matchedFiles,
    });
  }

  const requestedConfidence = enumValue(object.confidence, CONFIDENCES, "medium");
  return {
    classifiedDomains,
    requiredTests,
    optionalTests: sanitizeCoverageTests(object.optionalTests).filter(
      (test) => ![test.id, test.job].some((item) => item && requiredIds.has(item)),
    ),
    newE2eRecommendations: sanitizeNewRecommendations(object.newE2eRecommendations),
    noE2eReason:
      requiredTests.length > 0
        ? null
        : typeof object.noE2eReason === "string" || object.noE2eReason === null
          ? object.noE2eReason
          : null,
    confidence:
      (requiredTests.length > 0 || riskPlan.families.length > 0) && requestedConfidence === "low"
        ? "medium"
        : requestedConfidence,
  };
}

function sanitizeCoverageDomains(value: unknown): E2eCoverageDomain[] {
  return recordItems(value)
    .map((item) => ({
      domain: stringOrUndefined(item.domain),
      reason: stringOrUndefined(item.reason),
      confidence: enumValue(item.confidence, CONFIDENCES, "medium"),
      matchedFiles: stringArray(item.matchedFiles),
    }))
    .filter((item) => item.domain && item.reason)
    .slice(0, 50);
}

function sanitizeCoverageTests(value: unknown): E2eCoverageTest[] {
  return recordItems(value)
    .map((item) =>
      dropUndefinedValues({
        id: stringOrUndefined(item.id),
        reason: stringOrUndefined(item.reason),
        workflow: stringOrUndefined(item.workflow),
        job: stringOrUndefined(item.job),
        script: stringOrUndefined(item.script),
        cost: stringOrUndefined(item.cost),
        runner: stringOrUndefined(item.runner),
      }),
    )
    .filter((item) => item.id && item.reason)
    .slice(0, 50);
}

function sanitizeNewRecommendations(value: unknown): E2eNewRecommendation[] {
  return recordItems(value)
    .map((item) => ({
      domain: stringOrUndefined(item.domain),
      reason: stringOrUndefined(item.reason),
      suggestedTest: stringOrUndefined(item.suggestedTest),
      priority: enumValue(item.priority, CONFIDENCES, "medium"),
    }))
    .filter((item) => item.domain && item.reason && item.suggestedTest)
    .slice(0, 50);
}

function requiresCloudOnboardE2e(changedFiles: string[]): boolean {
  return changedFiles.some((file) =>
    CLOUD_ONBOARD_E2E_PATTERNS.some((pattern) => pattern.test(file)),
  );
}

export function normalizeE2eTargetAdvisorResult(
  result: unknown,
  metadata: E2eRecommendationMetadata,
  options: {
    changedFileSources?: Readonly<Record<string, string | null>>;
    e2eWorkflowText?: string;
    riskPlan?: RiskPlan;
  } = {},
): E2eTargetAdvisorResult {
  if (!isRecord(result)) throw new Error("Target advisor returned a non-object result");
  const context = buildE2eTargetNormalizationContext(
    options.e2eWorkflowText,
    metadata.changedFiles,
    options.changedFileSources,
  );
  const unwiredTests = findUnwiredFreeStandingLiveTests(metadata.changedFiles, context);
  const suppressFanout = shouldSuppressFanoutForUnwiredLiveTests(
    metadata.changedFiles,
    unwiredTests,
  );
  const focusedJobs = deterministicFreeStandingJobRecommendations(metadata.changedFiles, context);
  const riskPlan =
    options.riskPlan ??
    buildRiskPlan({ headSha: "target-normalize", changedFiles: metadata.changedFiles });
  const deterministicRequired = mergeRecommendations(
    deterministicRiskJobRecommendations(riskPlan, context),
    focusedJobs,
  );
  const required = suppressFanout
    ? deterministicRequired
    : mergeRecommendations(
        deterministicRequired,
        suppressFanoutForFocusedJobs(
          sanitizeTargetRecommendations(result.required, true, context),
          deterministicRequired,
          metadata.changedFiles,
        ),
      );
  const optional = suppressFanout
    ? []
    : suppressFanoutForFocusedJobs(
        sanitizeTargetRecommendations(result.optional, false, context),
        focusedJobs,
        metadata.changedFiles,
      );
  const noTargetE2eReason = targetReason(
    result.noTargetE2eReason,
    required,
    optional,
    unwiredTests,
    suppressFanout,
  );
  const requestedConfidence = enumValue(result.confidence, CONFIDENCES, "medium");
  return {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    changedFiles: metadata.changedFiles,
    relevantChangedFiles: uniqueStrings([
      ...stringArrayWithinChanged(result.relevantChangedFiles, metadata.changedFiles),
      ...riskPlan.families.flatMap((family) => family.matchedFiles),
    ]),
    required,
    optional: optional.filter(
      (candidate) =>
        !required.some(
          (item) => item.id === candidate.id && item.selectorType === candidate.selectorType,
        ),
    ),
    noTargetE2eReason,
    confidence:
      required.length > 0 && requestedConfidence === "low" ? "medium" : requestedConfidence,
  };
}

function targetReason(
  value: unknown,
  required: E2eTargetRecommendation[],
  optional: E2eTargetRecommendation[],
  unwiredTests: string[],
  suppressFanout: boolean,
): string | null {
  if (suppressFanout && required.length === 0) return missingLiveWiringReason(unwiredTests);
  if (typeof value === "string" && value.trim() && required.length === 0 && optional.length === 0) {
    return value.trim();
  }
  if (required.length > 0 || optional.length > 0) return null;
  return unwiredTests.length > 0
    ? missingLiveWiringReason(unwiredTests)
    : "Advisor reported no E2E target impact.";
}

function readE2eWorkflowText(): string | undefined {
  try {
    return fs.readFileSync(path.join(process.cwd(), E2E_WORKFLOW_PATH), "utf8");
  } catch {
    return undefined;
  }
}

function readTrustedE2eWorkflowText(): string {
  return fs.readFileSync(path.join(TRUSTED_REPO_ROOT, E2E_WORKFLOW_PATH), "utf8");
}

function buildE2eTargetNormalizationContext(
  e2eWorkflowText = readE2eWorkflowText(),
  changedFiles: readonly string[] = [],
  changedFileSources?: Readonly<Record<string, string | null>>,
): E2eTargetNormalizationContext {
  const trustedWorkflowText = readTrustedE2eWorkflowText();
  const trustedCredentialFreeTests = discoverTrustedCredentialFreeTests();
  const allowedJobIds = new Set(
    extractAllowedE2eJobIds(trustedWorkflowText, trustedCredentialFreeTests),
  );
  // The analyzed workflow is untrusted input. It may explain why a changed test is
  // unwired, but it must never introduce a selector that CI could later dispatch.
  const freeStandingJobs = extractFreeStandingE2eJobs(trustedWorkflowText).filter((job) =>
    allowedJobIds.has(job.id),
  );
  const liveTestToJobs = new Map<string, string[]>();
  const changedCredentialFreeProjects = new Map(
    changedFiles.flatMap((file) => {
      const project = credentialFreeTestProjectForFile(file);
      return project ? [[file, project] as const] : [];
    }),
  );
  for (const job of freeStandingJobs) {
    for (const file of job.liveTestFiles) addMapValue(liveTestToJobs, file, job.id);
  }
  for (const row of trustedCredentialFreeTests) {
    if (changedCredentialFreeProjects.has(row.file)) {
      allowedJobIds.delete(row.id);
      continue;
    }
    addMapValue(liveTestToJobs, row.file, row.id);
  }
  for (const [file, project] of changedCredentialFreeProjects) {
    const source = changedSource(file, changedFileSources);
    const row = source ? credentialFreeTestRow(file, source) : undefined;
    if (!row || !project) continue;
    addMapValue(liveTestToJobs, row.file, row.id);
    allowedJobIds.add(row.id);
  }
  return { e2eWorkflowText, freeStandingJobs, allowedJobIds, liveTestToJobs };
}

function credentialFreeTestProjectForFile(file: string): "e2e-live" | "integration" | undefined {
  if (/^test\/e2e\/live\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.ts$/.test(file)) {
    return "e2e-live";
  }
  if (/^test\/(?!e2e\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.(?:js|ts)$/.test(file)) {
    return "integration";
  }
  return undefined;
}

function credentialFreeTestRow(file: string, source: string): CredentialFreeTestRow | undefined {
  if (!credentialFreeTestProjectForFile(file)) return undefined;
  const declarations = moduleTagDeclarations(source);
  if (
    declarations.some(({ tag }) => tag.startsWith("e2e/") && tag !== CREDENTIAL_FREE_TEST_TAG) ||
    declarations.filter(({ tag }) => tag === CREDENTIAL_FREE_TEST_TAG).length !== 1
  ) {
    return undefined;
  }
  const id = path.posix.basename(file).replace(/\.test\.(?:js|ts)$/, "");
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? { id, file } : undefined;
}

function discoverTrustedCredentialFreeTests(): CredentialFreeTestRow[] {
  const rows: CredentialFreeTestRow[] = [];
  const testRoot = path.join(TRUSTED_REPO_ROOT, "test");
  const pending = [testRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.test\.(?:js|ts)$/.test(entry.name)) continue;
      const file = path.relative(TRUSTED_REPO_ROOT, absolute).split(path.sep).join("/");
      const row = credentialFreeTestRow(file, fs.readFileSync(absolute, "utf8"));
      if (row) rows.push(row);
    }
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function trustedAllowedJobIds(): string[] {
  return extractAllowedE2eJobIds(
    readTrustedE2eWorkflowText(),
    discoverTrustedCredentialFreeTests(),
  );
}

function extractAllowedE2eJobIds(
  workflowText: string,
  credentialFreeTests: readonly CredentialFreeTestRow[],
): string[] {
  const jobs = e2eWorkflowJobs(workflowText);
  const allowed = jobs
    .filter(({ body }) => /^\s{6}E2E_JOB:\s*["']1["']\s*$/mu.test(body))
    .map(({ id }) => id);
  if (jobs.some(({ id }) => id === SHARED_E2E_JOB_ID)) {
    allowed.push(...credentialFreeTests.map(({ id }) => id));
  }
  return [...new Set(allowed)].sort();
}

function changedSource(
  file: string,
  changedFileSources?: Readonly<Record<string, string | null>>,
): string | undefined {
  if (changedFileSources && Object.hasOwn(changedFileSources, file)) {
    return changedFileSources[file] ?? undefined;
  }
  try {
    return fs.readFileSync(path.join(process.cwd(), file), "utf8");
  } catch {
    return undefined;
  }
}

function addMapValue(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  if (!values.includes(value)) values.push(value);
  map.set(key, values);
}

export function extractFreeStandingE2eJobs(workflowText: string): E2eWorkflowJob[] {
  const jobs: E2eWorkflowJob[] = [];
  for (const { id, body } of e2eWorkflowJobs(workflowText)) {
    if (!body.includes("inputs.jobs") || !body.includes(`,${id},`)) continue;
    const liveTestFiles = uniqueStrings(
      [...body.matchAll(/test\/e2e\/live\/[A-Za-z0-9._-]+\.test\.ts/g)].map((item) => item[0]),
    ).filter((file) => file !== REGISTRY_LIVE_ENTRYPOINT);
    if (liveTestFiles.length > 0) jobs.push({ id, liveTestFiles });
  }
  return jobs.sort((left, right) => left.id.localeCompare(right.id));
}

function e2eWorkflowJobs(workflowText: string): Array<{ id: string; body: string }> {
  const jobsBlockStart = workflowText.search(/^jobs:\s*$/m);
  if (jobsBlockStart === -1) return [];
  const lines = workflowText.slice(jobsBlockStart).split(/\r?\n/);
  const jobs: Array<{ id: string; body: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (!match?.[1]) continue;
    const bodyLines: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[bodyIndex])) break;
      bodyLines.push(lines[bodyIndex]);
    }
    jobs.push({ id: match[1], body: bodyLines.join("\n") });
  }
  return jobs;
}

function findUnwiredFreeStandingLiveTests(
  changedFiles: string[],
  context: E2eTargetNormalizationContext,
): string[] {
  return changedFiles.filter(
    (file) =>
      FREE_STANDING_LIVE_TEST_PATTERN.test(file) &&
      file !== REGISTRY_LIVE_ENTRYPOINT &&
      !context.liveTestToJobs.has(file) &&
      !(context.e2eWorkflowText ?? "").includes(file),
  );
}

function shouldSuppressFanoutForUnwiredLiveTests(
  changedFiles: string[],
  unwiredTests: string[],
): boolean {
  if (unwiredTests.length === 0) return false;
  return changedFiles
    .filter(isE2eTargetRelevantFile)
    .every((file) => unwiredTests.includes(file) || file === E2E_WORKFLOW_PATH);
}

function isE2eTargetRelevantFile(file: string): boolean {
  return file === E2E_WORKFLOW_PATH || file.startsWith("test/e2e/") || file.startsWith("tools/e2e");
}

function missingLiveWiringReason(files: string[]): string {
  const fileList = files.map((file) => `\`${file}\``).join(", ");
  return `New E2E test ${fileList} is not wired into \`${E2E_WORKFLOW_PATH}\`, so the E2E workflow cannot dispatch it yet. Add the credential-free tag, a discrete job, or a typed live target before treating the PR as E2E-runnable.`;
}

function deterministicFreeStandingJobRecommendations(
  changedFiles: string[],
  context: E2eTargetNormalizationContext,
): E2eTargetRecommendation[] {
  const output: E2eTargetRecommendation[] = [];
  const seen = new Set<string>();
  for (const file of changedFiles.filter((item) => context.liveTestToJobs.has(item))) {
    for (const job of context.liveTestToJobs.get(file) ?? []) {
      if (seen.has(job)) continue;
      seen.add(job);
      output.push({
        id: job,
        workflow: E2E_WORKFLOW,
        selectorType: "job",
        required: true,
        reason: `Focused free-standing E2E selector wired for changed test \`${file}\`.`,
      });
    }
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

function deterministicRiskJobRecommendations(
  riskPlan: RiskPlan,
  context: E2eTargetNormalizationContext,
): E2eTargetRecommendation[] {
  return riskPlan.requiredJobs
    .filter((job) => context.allowedJobIds.has(job.id))
    .map((job) => ({
      id: job.id,
      workflow: E2E_WORKFLOW,
      selectorType: "job" as const,
      required: true,
      reason: job.reasons.join(" "),
    }));
}

function suppressFanoutForFocusedJobs(
  recommendations: E2eTargetRecommendation[],
  deterministicJobs: E2eTargetRecommendation[],
  changedFiles: string[],
): E2eTargetRecommendation[] {
  if (deterministicJobs.length === 0) return recommendations;
  const onlyFocusedChange = changedFiles
    .filter(isE2eTargetRelevantFile)
    .every(
      (file) =>
        file === E2E_WORKFLOW_PATH ||
        FREE_STANDING_LIVE_FILE_PATTERN.test(file) ||
        file.startsWith("test/e2e/support/") ||
        file.startsWith("tools/e2e/"),
    );
  return onlyFocusedChange
    ? recommendations.filter((item) => item.selectorType !== "all")
    : recommendations;
}

function mergeRecommendations(
  first: E2eTargetRecommendation[],
  second: E2eTargetRecommendation[],
): E2eTargetRecommendation[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => {
    const key = `${item.selectorType}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeTargetRecommendations(
  value: unknown,
  required: boolean,
  context: E2eTargetNormalizationContext,
): E2eTargetRecommendation[] {
  const seen = new Set<string>();
  const output: E2eTargetRecommendation[] = [];
  for (const item of recordItems(value)) {
    const id = stringOrUndefined(item.id);
    const reason = stringOrUndefined(item.reason);
    const workflow = stringOrUndefined(item.workflow);
    if (!id || !reason || !workflow || !ALLOWED_WORKFLOWS.has(workflow)) continue;
    const selectorType = normalizeSelectorType(item.selectorType, id, context.allowedJobIds);
    if (!selectorType) continue;
    if (selectorType === "all" && id !== E2E_ALL_ID) continue;
    if (selectorType === "job" && !context.allowedJobIds.has(id)) continue;
    if (selectorType !== "job" && !TARGET_ID_PATTERN.test(id)) continue;
    const targetDefinition = selectorType === "target" ? getTarget(id) : undefined;
    if (
      selectorType === "target" &&
      (!targetDefinition || !liveTargetSupport(targetDefinition).supported)
    ) {
      continue;
    }
    const key = `${selectorType}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(
      dropUndefinedValues({
        id,
        workflow,
        selectorType,
        target: stringOrUndefined(item.target),
        suiteFilter: stringOrUndefined(item.suiteFilter),
        required,
        reason,
      }) as E2eTargetRecommendation,
    );
  }
  return output;
}

function normalizeSelectorType(
  value: unknown,
  id: string,
  allowedJobIds: ReadonlySet<string>,
): E2eSelectorType | null {
  if (value === "all" || value === "target" || value === "job") return value;
  if (id === E2E_ALL_ID) return "all";
  if (allowedJobIds.has(id)) return "job";
  return "target";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringArrayWithinChanged(value: unknown, changedFiles: string[]): string[] {
  const allowed = new Set(changedFiles);
  return stringArray(value).filter((file) => allowed.has(file));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
