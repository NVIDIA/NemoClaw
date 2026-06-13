#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Intentionally resolves relative to the trusted advisor checkout, not the
// analyzed PR workdir. The workflow runs this script from trusted `main` while
// `process.cwd()` points at inert PR data, so normalization must not execute
// PR-local registry/runtime-support code. PRs that add or newly wire scenarios
// should use the fan-out recommendation until the trusted checkout knows their
// targeted IDs are live-supported.
import { getScenario } from "../../test/e2e-scenario/scenarios/registry.ts";
import { liveScenarioSupport } from "../../test/e2e-scenario/scenarios/runtime-support.ts";
import { getChangedFiles, getDiff } from "../advisors/git.mts";
import {
  type AdvisorArtifactPaths,
  advisorArtifactPaths,
  parseArgs,
  parsePositiveInt,
  readJson,
  writeJson,
} from "../advisors/io.mts";
import {
  dropUndefinedValues,
  enumValue,
  extractJson,
  recordItems,
  stringOrUndefined,
} from "../advisors/json.mts";
import {
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_ADVISOR_PROVIDER,
  READ_ONLY_TOOLS,
  type RunAdvisorResult,
  runReadOnlyAdvisor,
} from "../advisors/session.mts";

const root = process.cwd();
const ADVISOR_PROVIDER = DEFAULT_ADVISOR_PROVIDER;
const ADVISOR_MODEL = DEFAULT_ADVISOR_MODEL;
const ADVISOR_CREDENTIAL_ENV = ["E2E", "ADVISOR", "API", "KEY"].join("_");
const SCENARIO_WORKFLOW = "e2e-vitest-scenarios.yaml";
const SCENARIO_WORKFLOW_PATH = `.github/workflows/${SCENARIO_WORKFLOW}`;
const SCENARIO_ALL_ID = "e2e-scenarios-all";
const REGISTRY_LIVE_ENTRYPOINT = "test/e2e-scenario/live/registry-scenarios.test.ts";
const FREE_STANDING_LIVE_TEST_PATTERN = /^test\/e2e-scenario\/live\/[^/]+\.test\.ts$/;
const FREE_STANDING_LIVE_FILE_PATTERN = /^test\/e2e-scenario\/live\/[^/]+\.ts$/;
const ALLOWED_WORKFLOWS = new Set<string>([SCENARIO_WORKFLOW]);
// Scenario IDs and job IDs are embedded into the dispatch command we hand to
// users; restrict them to shell-safe allowlists so a hallucinated id can never
// inject metacharacters or non-canonical tokens into the dispatch line.
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type ScenarioSelectorType = "all" | "scenario" | "job";

export function canonicalDispatchCommand(
  workflow: string,
  id: string,
  selectorType: ScenarioSelectorType = id === SCENARIO_ALL_ID ? "all" : "scenario",
): string {
  if (workflow !== SCENARIO_WORKFLOW) {
    throw new Error(`Unknown scenario workflow: ${workflow}`);
  }
  if (selectorType === "all") {
    if (id !== SCENARIO_ALL_ID) throw new Error(`Invalid fan-out selector id: ${id}`);
    return `gh workflow run ${SCENARIO_WORKFLOW} --ref <pr-head-ref>`;
  }
  if (selectorType === "job") {
    if (!JOB_ID_PATTERN.test(id)) throw new Error(`Invalid Vitest job id: ${id}`);
    return `gh workflow run ${SCENARIO_WORKFLOW} --ref <pr-head-ref> --field jobs=${id}`;
  }
  return `gh workflow run ${SCENARIO_WORKFLOW} --ref <pr-head-ref> --field scenarios=${id}`;
}

type ArtifactPaths = AdvisorArtifactPaths;
type AdvisorSchema = Record<string, unknown>;
type Confidence = "low" | "medium" | "high";

type AdvisorMetadata = {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
};

export type ScenarioRecommendation = {
  id: string;
  workflow: string;
  selectorType: ScenarioSelectorType;
  scenario?: string;
  suiteFilter?: string;
  required: boolean;
  reason: string;
  dispatchCommand: string;
};

export type VitestWorkflowJob = {
  id: string;
  liveTestFiles: string[];
};

type ScenarioNormalizationContext = {
  vitestWorkflowText?: string;
  freeStandingJobs: VitestWorkflowJob[];
  liveTestToJobs: Map<string, string[]>;
};

export type ScenarioAdvisorResult = {
  version: 1;
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  relevantChangedFiles: string[];
  required: ScenarioRecommendation[];
  optional: ScenarioRecommendation[];
  noScenarioE2eReason: string | null;
  confidence: Confidence;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.outDir || "artifacts/e2e-advisor";
  const baseRef = args.base || process.env.BASE_REF || "origin/main";
  const headRef = args.head || process.env.HEAD_REF || "HEAD";
  const schemaPath = args.schema || "tools/e2e-advisor/scenarios-schema.json";
  const artifacts = artifactPaths(outDir);
  // Keep generated advisor credential config outside uploaded artifacts.
  const configDir =
    process.env.E2E_SCENARIO_ADVISOR_CONFIG_DIR ||
    path.join("/tmp", `nemoclaw-e2e-scenario-advisor-config-${process.pid}`);
  const timeoutMs = parsePositiveInt(process.env.E2E_SCENARIO_ADVISOR_TIMEOUT_MS, 900000);
  const heartbeatMs = parsePositiveInt(process.env.E2E_SCENARIO_ADVISOR_HEARTBEAT_MS, 60000);
  const maxCaptureBytes = parsePositiveInt(
    process.env.E2E_SCENARIO_ADVISOR_MAX_CAPTURE_BYTES,
    5 * 1024 * 1024,
  );

  fs.mkdirSync(outDir, { recursive: true });

  logProgress(
    `Starting scenario advisor analysis: base=${baseRef} head=${headRef} outDir=${outDir}`,
  );
  const schema = readJson<AdvisorSchema>(schemaPath);
  const changedFiles = getChangedFiles(baseRef, headRef);
  logProgress(`Detected ${changedFiles.length} changed file(s)`);
  const diff = getDiff(baseRef, headRef, 120000);
  logProgress(`Collected diff: ${diff.length} character(s) after truncation`);
  const systemPrompt = buildSystemPrompt(schema);
  const prompt = buildPrompt({ baseRef, headRef, changedFiles, diff });
  fs.writeFileSync(artifacts.prompt, prompt);
  logProgress(
    `Wrote scenario advisor prompt: ${prompt.length} character(s) at ${artifacts.prompt}`,
  );

  const metadata = { baseRef, headRef, changedFiles };
  const writeFailure = (reason: string): void =>
    writeUnavailableArtifacts(artifacts, metadata, reason, true);
  const writeUnavailable = (reason: string): void =>
    writeUnavailableArtifacts(artifacts, metadata, reason, false);

  if (process.env.E2E_SCENARIO_ADVISOR_RUN_ANALYSIS === "0") {
    writeUnavailable("E2E_SCENARIO_ADVISOR_RUN_ANALYSIS=0");
    process.exit(0);
  }

  logProgress(`Launching advisor SDK: provider=${ADVISOR_PROVIDER} model=${ADVISOR_MODEL}`);
  logProgress(
    `Advisor tools enabled: ${READ_ONLY_TOOLS.join(",")}; repository commands remain disabled by prompt policy`,
  );

  let sdkResult: RunAdvisorResult | undefined;
  try {
    sdkResult = await runReadOnlyAdvisor({
      cwd: root,
      promptTurns: [{ name: "scenario-analysis", prompt }],
      systemPrompt,
      configDir,
      htmlExportPath: artifacts.sessionHtml,
      timeoutMs,
      heartbeatMs,
      maxCaptureBytes,
      credentialEnv: ADVISOR_CREDENTIAL_ENV,
      logPrefix: "e2e-scenario-advisor",
      logProgress,
    });
    fs.writeFileSync(artifacts.raw, sdkResult.raw);
    logProgress(
      `Advisor SDK finished: textBytes=${Buffer.byteLength(sdkResult.text, "utf8")} rawBytes=${Buffer.byteLength(
        sdkResult.raw,
        "utf8",
      )}`,
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(artifacts.raw, `Scenario advisor SDK execution failed: ${reason}\n`);
    writeFailure(reason);
    process.exit(1);
  }

  let result: ScenarioAdvisorResult;
  try {
    result = normalizeScenarioAdvisorResult(
      extractJson(sdkResult.text || sdkResult.raw, artifacts.raw, "e2e_scenario_advisor_json"),
      metadata,
      { vitestWorkflowText: readVitestWorkflowText() },
    );
  } catch (error: unknown) {
    writeFailure(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  writeJson(artifacts.result, result);
  writeJson(artifacts.finalResult, result);
  const summary = renderScenarioSummary(result);
  fs.writeFileSync(artifacts.summary, summary);
  console.log(summary);
}

function artifactPaths(outDir: string): ArtifactPaths {
  return advisorArtifactPaths(outDir, "e2e-scenario-advisor");
}

function writeUnavailableArtifacts(
  paths: ArtifactPaths,
  metadata: AdvisorMetadata,
  reason: string,
  failed: boolean,
): void {
  const result = unavailableResult(metadata, reason, failed);
  writeJson(
    paths.result,
    failed
      ? { failed: true, reason, promptPath: paths.prompt, rawPath: paths.raw }
      : { skipped: true, reason, promptPath: paths.prompt },
  );
  writeJson(paths.finalResult, result);
  fs.writeFileSync(
    paths.summary,
    `# Vitest E2E Scenario Advisor\n\n${failed ? "Failed" : "Skipped"}: ${reason}\n`,
  );
  if (failed) {
    console.error(`Scenario advisor analysis failed: ${reason}`);
  }
}

function logProgress(message: string): void {
  console.log(`[e2e-scenario-advisor] ${new Date().toISOString()} ${message}`);
}

export function buildSystemPrompt(schema: AdvisorSchema): string {
  return [
    "You are the NemoClaw Vitest E2E scenario advisor for CI.",
    "",
    "Your job is to recommend which Vitest-backed E2E scenario dispatches should run for a PR. They are part of the single NemoClaw E2E system, dispatched via `.github/workflows/e2e-vitest-scenarios.yaml`.",
    "",
    "Limit recommendations to the Vitest scenario workflow. Broader direct legacy `test/e2e/` workflows are owned by the general E2E advisor until they migrate; do not describe them as a separate kind of E2E.",
    "",
    "Authoritative sources to inspect with your read-only tools:",
    "- `.github/workflows/e2e-vitest-scenarios.yaml` — canonical Vitest live scenario workflow.",
    "- `test/e2e-scenario/scenarios/registry.ts` and `test/e2e-scenario/scenarios/scenarios/` — typed scenario IDs and metadata.",
    "- `test/e2e-scenario/scenarios/runtime-support.ts` — which typed scenarios are wired for live Vitest execution.",
    "- `test/e2e-scenario/live/registry-scenarios.test.ts` — live Vitest registry scenario entry point.",
    "- `test/e2e-scenario/fixtures/` and `test/e2e-scenario/support-tests/` — shared Vitest fixtures, clients, and phase helpers.",
    "",
    "Decision policy:",
    "- Required (all scenarios): changes to scenario registry, matrix emission, expected-state metadata, live support classification, shared fixtures, or the shared Vitest scenario workflow machinery. Recommend the `e2e-scenarios-all` fan-out through `e2e-vitest-scenarios.yaml`.",
    "- Required (targeted): fixture, live test, manifest, runtime-support, or scenario changes that affect a specific subset. Recommend the smallest set of live-supported typed scenario IDs that exercises the changed surface.",
    "- Required (free-standing job): if a PR wires or changes a discrete live Vitest job in `.github/workflows/e2e-vitest-scenarios.yaml` for a specific `test/e2e-scenario/live/*.test.ts`, prefer that job over `e2e-scenarios-all`. Use selectorType=`job`, id=`<job-id>`, workflow=`e2e-vitest-scenarios.yaml`, and dispatchCommand exactly `gh workflow run e2e-vitest-scenarios.yaml --ref <pr-head-ref> --field jobs=<job-id>`.",
    "- Missing wiring: if a PR adds or changes a free-standing live Vitest file under `test/e2e-scenario/live/*.test.ts` but that file is not referenced by `.github/workflows/e2e-vitest-scenarios.yaml` and is not `registry-scenarios.test.ts`, do not recommend the fan-out as proof. Return no required/optional recommendations and set `noScenarioE2eReason` to say the test must be wired into `e2e-vitest-scenarios.yaml` before it can be dispatched.",
    "- Optional: adjacent scenarios that exercise the same suite on a different platform/onboarding (e.g. macOS, WSL, GPU) but are not the primary target. Special-runner scenarios (`gpu-`, `macos-`, `wsl-`, `brev-`) should usually be optional unless they are the only path that exercises the change.",
    "- None: docs-only, comment-only, tests-only outside `test/e2e-scenario/`, or changes that cannot affect Vitest scenario behavior. Set `noScenarioE2eReason` and return empty `required`/`optional` arrays.",
    "",
    "Hard rules:",
    "- Only recommend live-supported typed scenario IDs that exist in the registry or the synthetic fan-out id `e2e-scenarios-all`. Do not invent IDs.",
    "- The only allowed workflow is `e2e-vitest-scenarios.yaml`.",
    "- Each `dispatchCommand` for a single-scenario recommendation MUST be exactly: `gh workflow run e2e-vitest-scenarios.yaml --ref <pr-head-ref> --field scenarios=<id>`.",
    "- Each `dispatchCommand` for a free-standing job recommendation MUST be exactly: `gh workflow run e2e-vitest-scenarios.yaml --ref <pr-head-ref> --field jobs=<id>`.",
    "- For the fan-out, use exactly: `gh workflow run e2e-vitest-scenarios.yaml --ref <pr-head-ref>` and set `id`/`workflow`/`selectorType` to `e2e-scenarios-all`/`e2e-vitest-scenarios.yaml`/`all`.",
    "- The normalizer validates targeted IDs against the trusted advisor checkout's registry/runtime-support modules, not PR-local TypeScript. If a PR adds or newly wires a typed registry scenario that is not live-supported on trusted `main` yet, recommend the `e2e-scenarios-all` fan-out rather than a targeted dispatch. This fallback does not apply to free-standing live test jobs.",
    "- A `suiteFilter` may be set on a recommendation as analytical metadata explaining why the scenario was selected. It must NOT leak into the dispatch command.",
    "- `relevantChangedFiles` must be the subset of `changedFiles` under `test/e2e-scenario/`, `.github/workflows/e2e-vitest-scenarios.yaml`, or other directly scenario-relevant paths.",
    "",
    "Return JSON only matching this schema:",
    "```json",
    JSON.stringify(schema),
    "```",
  ].join("\n");
}

export function buildPrompt({
  baseRef,
  headRef,
  changedFiles,
  diff,
}: {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  diff: string;
}): string {
  return `Return a Vitest E2E scenario recommendation for this PR.

Set these fields exactly:
- version: 1
- baseRef: ${JSON.stringify(baseRef)}
- headRef: ${JSON.stringify(headRef)}
- changedFiles: ${JSON.stringify(changedFiles)}

Changed files:
${changedFiles.map((file) => `- ${file}`).join("\n") || "- <none>"}

Git diff, truncated if large:
\`\`\`diff
${diff || "<no diff available>"}
\`\`\`
`;
}

export function normalizeScenarioAdvisorResult(
  result: unknown,
  metadata: AdvisorMetadata,
  options: { vitestWorkflowText?: string } = {},
): ScenarioAdvisorResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Scenario advisor returned a non-object result");
  }

  const object = result as Record<string, unknown>;
  const context = buildScenarioNormalizationContext(options.vitestWorkflowText);
  const unwiredFreeStandingLiveTests = findUnwiredFreeStandingLiveTests(
    metadata.changedFiles,
    context.vitestWorkflowText,
  );
  const suppressFanout = shouldSuppressFanoutForUnwiredLiveTests(
    metadata.changedFiles,
    unwiredFreeStandingLiveTests,
  );
  const deterministicJobs = deterministicFreeStandingJobRecommendations(
    metadata.changedFiles,
    context,
  );
  const required = suppressFanout
    ? []
    : mergeRecommendations(
        deterministicJobs,
        suppressFanoutForFocusedJobs(
          sanitizeRecommendations(object.required, true, context),
          deterministicJobs,
          metadata.changedFiles,
        ),
      );
  const optional = suppressFanout
    ? []
    : suppressFanoutForFocusedJobs(
        sanitizeRecommendations(object.optional, false, context),
        deterministicJobs,
        metadata.changedFiles,
      );
  const reasonField = object.noScenarioE2eReason;
  const noScenarioE2eReason = suppressFanout
    ? missingFreeStandingLiveWiringReason(unwiredFreeStandingLiveTests)
    : typeof reasonField === "string" &&
        reasonField.trim() &&
        required.length === 0 &&
        optional.length === 0
      ? reasonField.trim()
      : required.length === 0 && optional.length === 0
        ? unwiredFreeStandingLiveTests.length > 0
          ? missingFreeStandingLiveWiringReason(unwiredFreeStandingLiveTests)
          : "Advisor reported no Vitest E2E scenario impact."
        : null;

  return {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    changedFiles: metadata.changedFiles,
    relevantChangedFiles: stringArrayWithinChanged(
      object.relevantChangedFiles,
      metadata.changedFiles,
    ),
    required,
    optional: optional.filter(
      (candidate) =>
        !required.some(
          (item) => item.id === candidate.id && item.selectorType === candidate.selectorType,
        ),
    ),
    noScenarioE2eReason,
    confidence: enumValue<["low", "medium", "high"]>(
      object.confidence,
      ["low", "medium", "high"],
      "medium",
    ),
  };
}

function readVitestWorkflowText(): string | undefined {
  try {
    return fs.readFileSync(path.join(root, SCENARIO_WORKFLOW_PATH), "utf8");
  } catch {
    return undefined;
  }
}

function buildScenarioNormalizationContext(
  vitestWorkflowText = readVitestWorkflowText(),
): ScenarioNormalizationContext {
  const freeStandingJobs = extractFreeStandingVitestJobs(vitestWorkflowText ?? "");
  const liveTestToJobs = new Map<string, string[]>();
  for (const job of freeStandingJobs) {
    for (const file of job.liveTestFiles) {
      const jobs = liveTestToJobs.get(file) ?? [];
      jobs.push(job.id);
      liveTestToJobs.set(file, jobs);
    }
  }
  return { vitestWorkflowText, freeStandingJobs, liveTestToJobs };
}

export function extractFreeStandingVitestJobs(workflowText: string): VitestWorkflowJob[] {
  const jobsBlockStart = workflowText.search(/^jobs:\s*$/m);
  if (jobsBlockStart === -1) return [];

  const lines = workflowText.slice(jobsBlockStart).split(/\r?\n/);
  const jobs: VitestWorkflowJob[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (!match) continue;

    const id = match[1] || "";
    const bodyLines: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[bodyIndex])) break;
      bodyLines.push(lines[bodyIndex]);
    }
    const body = bodyLines.join("\n");
    if (!body.includes("inputs.jobs") || !body.includes(`,${id},`)) continue;
    const liveTestFiles = uniqueStrings(
      [...body.matchAll(/test\/e2e-scenario\/live\/[A-Za-z0-9._-]+\.test\.ts/g)].map(
        (item) => item[0],
      ),
    ).filter((file) => file !== REGISTRY_LIVE_ENTRYPOINT);
    if (liveTestFiles.length === 0) continue;
    jobs.push({ id, liveTestFiles });
  }
  return jobs.sort((a, b) => a.id.localeCompare(b.id));
}

function findUnwiredFreeStandingLiveTests(
  changedFiles: string[],
  vitestWorkflowText = readVitestWorkflowText(),
): string[] {
  return changedFiles.filter(
    (file) =>
      FREE_STANDING_LIVE_TEST_PATTERN.test(file) &&
      file !== REGISTRY_LIVE_ENTRYPOINT &&
      !(vitestWorkflowText ?? "").includes(file),
  );
}

function shouldSuppressFanoutForUnwiredLiveTests(
  changedFiles: string[],
  unwiredFreeStandingLiveTests: string[],
): boolean {
  if (unwiredFreeStandingLiveTests.length === 0) return false;
  const relevantFiles = changedFiles.filter(isVitestScenarioRelevantFile);
  return relevantFiles.every(
    (file) => unwiredFreeStandingLiveTests.includes(file) || file === SCENARIO_WORKFLOW_PATH,
  );
}

function isVitestScenarioRelevantFile(file: string): boolean {
  return (
    file === SCENARIO_WORKFLOW_PATH ||
    file.startsWith("test/e2e-scenario/") ||
    file.startsWith("tools/e2e-scenario") ||
    file.startsWith("tools/e2e-scenarios")
  );
}

function missingFreeStandingLiveWiringReason(files: string[]): string {
  const fileList = files.map((file) => `\`${file}\``).join(", ");
  return `New free-standing live Vitest test ${fileList} is not wired into \`${SCENARIO_WORKFLOW_PATH}\`, so the Vitest scenario workflow cannot dispatch it yet. Add a discrete job or register it as a typed live scenario before treating the PR as E2E-runnable.`;
}

function deterministicFreeStandingJobRecommendations(
  changedFiles: string[],
  context: ScenarioNormalizationContext,
): ScenarioRecommendation[] {
  const liveFiles = changedFiles.filter(
    (file) => FREE_STANDING_LIVE_FILE_PATTERN.test(file) && file !== REGISTRY_LIVE_ENTRYPOINT,
  );
  const output: ScenarioRecommendation[] = [];
  const seen = new Set<string>();
  for (const file of liveFiles) {
    for (const job of context.liveTestToJobs.get(file) ?? []) {
      if (seen.has(job)) continue;
      seen.add(job);
      output.push({
        id: job,
        workflow: SCENARIO_WORKFLOW,
        selectorType: "job",
        required: true,
        reason: `Focused free-standing Vitest job wired for changed live test \`${file}\`.`,
        dispatchCommand: canonicalDispatchCommand(SCENARIO_WORKFLOW, job, "job"),
      });
    }
  }
  return output.sort((a, b) => a.id.localeCompare(b.id));
}

function suppressFanoutForFocusedJobs(
  recommendations: ScenarioRecommendation[],
  deterministicJobs: ScenarioRecommendation[],
  changedFiles: string[],
): ScenarioRecommendation[] {
  if (deterministicJobs.length === 0) return recommendations;
  const relevantFiles = changedFiles.filter(isVitestScenarioRelevantFile);
  const onlyFocusedFreeStandingChange = relevantFiles.every(
    (file) =>
      file === SCENARIO_WORKFLOW_PATH ||
      FREE_STANDING_LIVE_FILE_PATTERN.test(file) ||
      file.startsWith("test/e2e-scenario/support-tests/") ||
      file.startsWith("tools/e2e-scenarios/"),
  );
  if (!onlyFocusedFreeStandingChange) return recommendations;
  return recommendations.filter((item) => item.selectorType !== "all");
}

function mergeRecommendations(
  first: ScenarioRecommendation[],
  second: ScenarioRecommendation[],
): ScenarioRecommendation[] {
  const seen = new Set<string>();
  const output: ScenarioRecommendation[] = [];
  for (const item of [...first, ...second]) {
    const key = `${item.selectorType}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function sanitizeRecommendations(
  value: unknown,
  requiredFlag: boolean,
  context: ScenarioNormalizationContext,
): ScenarioRecommendation[] {
  const seen = new Set<string>();
  const output: ScenarioRecommendation[] = [];
  const allowedJobIds = new Set(context.freeStandingJobs.map((job) => job.id));
  for (const item of recordItems(value)) {
    const id = stringOrUndefined(item.id);
    const reason = stringOrUndefined(item.reason);
    const workflow = stringOrUndefined(item.workflow);
    if (!id || !reason || !workflow) continue;
    // Allowlist: only the Vitest scenario workflow may be dispatched, and
    // only safe selector ids are accepted. Reject everything else; we do not
    // trust the model to author shell-safe dispatch commands.
    if (!ALLOWED_WORKFLOWS.has(workflow)) continue;
    const selectorType = normalizeSelectorType(item.selectorType, id, allowedJobIds);
    if (!selectorType) continue;
    if (selectorType === "job" && !allowedJobIds.has(id)) continue;
    if (selectorType !== "job" && !SCENARIO_ID_PATTERN.test(id)) continue;
    const scenarioDefinition = selectorType === "all" ? undefined : getScenario(id);
    if (
      selectorType === "scenario" &&
      (!scenarioDefinition || !liveScenarioSupport(scenarioDefinition).supported)
    ) {
      continue;
    }
    const key = `${selectorType}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scenario = stringOrUndefined(item.scenario);
    const suiteFilter = stringOrUndefined(item.suiteFilter);
    // Build dispatchCommand server-side. The model's value is intentionally
    // discarded so prompt drift can never leak a non-canonical dispatch into
    // the sticky comment.
    const dispatchCommand = canonicalDispatchCommand(workflow, id, selectorType);
    output.push(
      dropUndefinedValues({
        id,
        workflow,
        selectorType,
        scenario,
        suiteFilter,
        // Authority is the array position, not the model. Items in required[]
        // are required; items in optional[] are optional. The model's
        // per-item `required` boolean is ignored.
        required: requiredFlag,
        reason,
        dispatchCommand,
      }) as ScenarioRecommendation,
    );
  }
  return output;
}

function normalizeSelectorType(
  value: unknown,
  id: string,
  allowedJobIds: Set<string>,
): ScenarioSelectorType | null {
  if (value === "all" || value === "scenario" || value === "job") return value;
  if (id === SCENARIO_ALL_ID) return "all";
  if (allowedJobIds.has(id)) return "job";
  return "scenario";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function stringArrayWithinChanged(value: unknown, changedFiles: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(changedFiles);
  return value.filter((file): file is string => typeof file === "string" && allowed.has(file));
}

export function renderScenarioSummary(result: ScenarioAdvisorResult): string {
  const lines: string[] = [];
  lines.push("# Vitest E2E Scenario Advisor");
  lines.push("");
  lines.push(`Base: \`${result.baseRef}\`  `);
  lines.push(`Head: \`${result.headRef}\`  `);
  lines.push(`Confidence: **${result.confidence}**`);
  lines.push("");
  lines.push("## Required Vitest E2E scenarios");
  if (result.required.length === 0) {
    lines.push(`- _None._ ${result.noScenarioE2eReason || ""}`.trim());
  } else {
    for (const recommendation of result.required) {
      lines.push(`- **${recommendation.id}**: ${recommendation.reason}`);
      lines.push(`  - Dispatch: \`${recommendation.dispatchCommand}\``);
    }
  }
  lines.push("");
  lines.push("## Optional Vitest E2E scenarios");
  if (result.optional.length === 0) {
    lines.push("- _None._");
  } else {
    for (const recommendation of result.optional) {
      lines.push(`- **${recommendation.id}**: ${recommendation.reason}`);
      lines.push(`  - Dispatch: \`${recommendation.dispatchCommand}\``);
    }
  }
  lines.push("");
  lines.push("## Relevant changed files");
  if (result.relevantChangedFiles.length === 0) {
    lines.push("- _None._");
  } else {
    for (const file of result.relevantChangedFiles) lines.push(`- \`${file}\``);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function unavailableResult(
  metadata: AdvisorMetadata,
  reason: string,
  failed: boolean,
): ScenarioAdvisorResult {
  return {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    changedFiles: metadata.changedFiles,
    relevantChangedFiles: [],
    required: [],
    optional: [],
    noScenarioE2eReason: failed
      ? `Scenario advisor review failed: ${reason}`
      : `Scenario advisor review unavailable: ${reason}`,
    confidence: "low",
  };
}

// Constants are exported so workflow tests can pin them without duplicating literals.
export const SCENARIO_ADVISOR_WORKFLOWS = {
  single: SCENARIO_WORKFLOW,
  all: SCENARIO_WORKFLOW,
} as const;
