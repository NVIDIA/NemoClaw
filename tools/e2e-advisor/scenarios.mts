#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getChangedFiles, getDiff } from "../advisors/git.mts";
import {
  advisorArtifactPaths,
  parseArgs,
  parsePositiveInt,
  readJson,
  writeJson,
  type AdvisorArtifactPaths,
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
const SCENARIO_WORKFLOW = "e2e-scenarios.yaml";
const SCENARIO_ALL_WORKFLOW = "e2e-scenarios-all.yaml";
const ALLOWED_WORKFLOWS = new Set<string>([SCENARIO_WORKFLOW, SCENARIO_ALL_WORKFLOW]);
// Scenario IDs are embedded into the dispatch command we hand to users; restrict
// to a strict kebab-case allowlist so a hallucinated id can never inject shell
// metacharacters or non-canonical tokens into the dispatch line.
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function canonicalDispatchCommand(workflow: string, id: string): string {
  if (workflow === SCENARIO_ALL_WORKFLOW) {
    return `gh workflow run ${SCENARIO_ALL_WORKFLOW} --ref <pr-head-ref>`;
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
  scenario?: string;
  suiteFilter?: string;
  required: boolean;
  reason: string;
  dispatchCommand: string;
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
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
  const maxCaptureBytes = parsePositiveInt(process.env.E2E_SCENARIO_ADVISOR_MAX_CAPTURE_BYTES, 5 * 1024 * 1024);

  fs.mkdirSync(outDir, { recursive: true });

  logProgress(`Starting scenario advisor analysis: base=${baseRef} head=${headRef} outDir=${outDir}`);
  const schema = readJson<AdvisorSchema>(schemaPath);
  const changedFiles = getChangedFiles(baseRef, headRef);
  logProgress(`Detected ${changedFiles.length} changed file(s)`);
  const diff = getDiff(baseRef, headRef, 120000);
  logProgress(`Collected diff: ${diff.length} character(s) after truncation`);
  const systemPrompt = buildSystemPrompt(schema);
  const prompt = buildPrompt({ baseRef, headRef, changedFiles, diff });
  fs.writeFileSync(artifacts.prompt, prompt);
  logProgress(`Wrote scenario advisor prompt: ${prompt.length} character(s) at ${artifacts.prompt}`);

  const metadata = { baseRef, headRef, changedFiles };
  const writeFailure = (reason: string): void => writeUnavailableArtifacts(artifacts, metadata, reason, true);
  const writeUnavailable = (reason: string): void => writeUnavailableArtifacts(artifacts, metadata, reason, false);

  if (process.env.E2E_SCENARIO_ADVISOR_RUN_ANALYSIS === "0") {
    writeUnavailable("E2E_SCENARIO_ADVISOR_RUN_ANALYSIS=0");
    process.exit(0);
  }

  logProgress(`Launching advisor SDK: provider=${ADVISOR_PROVIDER} model=${ADVISOR_MODEL}`);
  logProgress(`Advisor tools enabled: ${READ_ONLY_TOOLS.join(",")}; repository commands remain disabled by prompt policy`);

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
    `# E2E Scenario Advisor\n\n${failed ? "Failed" : "Skipped"}: ${reason}\n`,
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
    "You are the NemoClaw E2E Scenario advisor for CI.",
    "",
    "Your job is to recommend which **scenario E2E** jobs should run for a PR. Scenario E2E is the layered scenario suite under `test/e2e-scenario/`, dispatched via `.github/workflows/e2e-scenarios.yaml` (single-scenario) and `.github/workflows/e2e-scenarios-all.yaml` (fan-out).",
    "",
    "You are a separate advisor from the general E2E recommendation advisor. Do not opine on legacy `test/e2e/` workflows or non-scenario E2E jobs; those are owned by the general advisor.",
    "",
    "Authoritative sources to inspect with your read-only tools:",
    "- `.github/workflows/e2e-scenarios.yaml` — its `ROUTES` table is the ground truth for dispatchable scenario IDs and runner placement.",
    "- `.github/workflows/e2e-scenarios-all.yaml` — fan-out workflow.",
    "- `test/e2e-scenario/nemoclaw_scenarios/scenarios.yaml` — scenario metadata (`setup_scenarios`, `test_plans`, base/onboarding profiles).",
    "- `test/e2e-scenario/nemoclaw_scenarios/expected-states.yaml` — expected-state contracts.",
    "- `test/e2e-scenario/validation_suites/suites.yaml` — suite definitions and their scripts.",
    "- `test/e2e-scenario/runtime/` — shared runner/runtime code (changes here usually require all-scenarios).",
    "",
    "Decision policy:",
    "- Required (all scenarios): changes to scenario runtime/runner code, scenario catalog metadata, expected-state metadata, suite catalog metadata, or the scenario workflows themselves. Recommend the `e2e-scenarios-all` fan-out.",
    "- Required (targeted): suite-script or onboarding/install-helper changes that affect a specific subset. Recommend the smallest set of scenario IDs from the `ROUTES` table that exercises the changed surface.",
    "- Optional: adjacent scenarios that exercise the same suite on a different platform/onboarding (e.g. macOS, WSL, GPU) but are not the primary target. Special-runner scenarios (`gpu-`, `macos-`, `wsl-`, `brev-`) should usually be optional unless they are the only path that exercises the change.",
    "- None: docs-only, comment-only, tests-only outside `test/e2e-scenario/`, or changes that cannot affect scenario E2E behavior. Set `noScenarioE2eReason` and return empty `required`/`optional` arrays.",
    "",
    "Hard rules:",
    "- Only recommend scenario IDs that exist in the `ROUTES` table of `e2e-scenarios.yaml`. Do not invent IDs.",
    "- The `e2e-scenarios.yaml` workflow accepts a single comma-separated `scenarios` input. Each `dispatchCommand` for a single-scenario recommendation MUST be exactly: `gh workflow run e2e-scenarios.yaml --ref <pr-head-ref> --field scenarios=<id>`.",
    "- For the fan-out, use exactly: `gh workflow run e2e-scenarios-all.yaml --ref <pr-head-ref>` and set `id`/`workflow` to `e2e-scenarios-all`/`e2e-scenarios-all.yaml`.",
    "- A `suiteFilter` may be set on a recommendation as analytical metadata explaining why the scenario was selected. It must NOT leak into the dispatch command.",
    "- `relevantChangedFiles` must be the subset of `changedFiles` under `test/e2e-scenario/`, `.github/workflows/e2e-scenarios*.yaml`, or other directly scenario-relevant paths.",
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
  return `Return a scenario E2E recommendation for this PR.

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
): ScenarioAdvisorResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Scenario advisor returned a non-object result");
  }

  const object = result as Record<string, unknown>;
  const required = sanitizeRecommendations(object.required, true);
  const optional = sanitizeRecommendations(object.optional, false);
  const reasonField = object.noScenarioE2eReason;
  const noScenarioE2eReason =
    typeof reasonField === "string" && reasonField.trim()
      ? reasonField.trim()
      : reasonField === null || reasonField === undefined
        ? required.length === 0 && optional.length === 0
          ? "Advisor reported no scenario E2E impact."
          : null
        : null;

  return {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    changedFiles: metadata.changedFiles,
    relevantChangedFiles: stringArrayWithinChanged(object.relevantChangedFiles, metadata.changedFiles),
    required,
    optional: optional.filter((candidate) => !required.some((item) => item.id === candidate.id)),
    noScenarioE2eReason,
    confidence: enumValue<["low", "medium", "high"]>(object.confidence, ["low", "medium", "high"], "medium"),
  };
}

function sanitizeRecommendations(value: unknown, requiredFlag: boolean): ScenarioRecommendation[] {
  const seen = new Set<string>();
  const output: ScenarioRecommendation[] = [];
  for (const item of recordItems(value)) {
    const id = stringOrUndefined(item.id);
    const reason = stringOrUndefined(item.reason);
    const workflow = stringOrUndefined(item.workflow);
    if (!id || !reason || !workflow) continue;
    // Allowlist: only the two scenario workflows may be dispatched, and only
    // kebab-case ids are accepted. Reject everything else; we do not trust
    // the model to author shell-safe dispatch commands.
    if (!ALLOWED_WORKFLOWS.has(workflow)) continue;
    if (!SCENARIO_ID_PATTERN.test(id)) continue;
    // Workflow/id pairing invariant: e2e-scenarios-all.yaml fan-out is the
    // only valid pairing for the synthetic id "e2e-scenarios-all", and that
    // id is meaningless on the single-scenario workflow. Reject mismatches
    // rather than render a misleading dispatch line.
    if (workflow === SCENARIO_ALL_WORKFLOW && id !== "e2e-scenarios-all") continue;
    if (workflow === SCENARIO_WORKFLOW && id === "e2e-scenarios-all") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const scenario = stringOrUndefined(item.scenario);
    const suiteFilter = stringOrUndefined(item.suiteFilter);
    // Build dispatchCommand server-side. The model's value is intentionally
    // discarded so prompt drift can never leak a non-canonical dispatch into
    // the sticky comment.
    const dispatchCommand = canonicalDispatchCommand(workflow, id);
    output.push(
      dropUndefinedValues({
        id,
        workflow,
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

function stringArrayWithinChanged(value: unknown, changedFiles: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(changedFiles);
  return value.filter((file): file is string => typeof file === "string" && allowed.has(file));
}

export function renderScenarioSummary(result: ScenarioAdvisorResult): string {
  const lines: string[] = [];
  lines.push("# E2E Scenario Advisor");
  lines.push("");
  lines.push(`Base: \`${result.baseRef}\`  `);
  lines.push(`Head: \`${result.headRef}\`  `);
  lines.push(`Confidence: **${result.confidence}**`);
  lines.push("");
  lines.push("## Required scenario E2E");
  if (result.required.length === 0) {
    lines.push(`- _None._ ${result.noScenarioE2eReason || ""}`.trim());
  } else {
    for (const recommendation of result.required) {
      lines.push(`- **${recommendation.id}**: ${recommendation.reason}`);
      lines.push(`  - Dispatch: \`${recommendation.dispatchCommand}\``);
    }
  }
  lines.push("");
  lines.push("## Optional scenario E2E");
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
  all: SCENARIO_ALL_WORKFLOW,
} as const;
