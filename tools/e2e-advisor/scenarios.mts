// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const yaml: { load(input: string): unknown } = require("js-yaml");

import { getChangedFiles } from "../advisors/git.mts";
import { parseArgs, writeJson } from "../advisors/io.mts";

const SCENARIO_WORKFLOW = "e2e-scenarios.yaml";
const SCENARIO_ALL_WORKFLOW = "e2e-scenarios-all.yaml";
const DEFAULT_BASELINE_SCENARIO = "ubuntu-repo-cloud-openclaw";
const CORE_SCENARIO_IDS = [
  "ubuntu-repo-cloud-openclaw",
  "ubuntu-repo-cloud-hermes",
  "gpu-repo-local-ollama-openclaw",
  "macos-repo-cloud-openclaw",
  "wsl-repo-cloud-openclaw",
  "brev-launchable-cloud-openclaw",
  "ubuntu-no-docker-preflight-negative",
];

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
  confidence: "high";
};

type ScenarioEntry = {
  suites?: unknown;
  runner_requirements?: unknown;
  dimensions?: {
    platform?: unknown;
    onboarding?: unknown;
  };
};

type ScenariosFile = {
  setup_scenarios?: Record<string, ScenarioEntry>;
  test_plans?: Record<string, ScenarioEntry>;
};

type SuiteEntry = {
  steps?: Array<{ script?: unknown }>;
};

type SuitesFile = {
  suites?: Record<string, SuiteEntry>;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.outDir || "artifacts/e2e-advisor";
  const baseRef = args.base || process.env.BASE_REF || "origin/main";
  const headRef = args.head || process.env.HEAD_REF || "HEAD";
  const resultPath = path.join(outDir, "e2e-scenario-advisor-result.json");
  const summaryPath = path.join(outDir, "e2e-scenario-advisor-summary.md");

  fs.mkdirSync(outDir, { recursive: true });

  const changedFiles = getChangedFiles(baseRef, headRef);
  const result = analyzeScenarioRecommendations({
    baseRef,
    headRef,
    changedFiles,
    root: process.cwd(),
  });
  writeJson(resultPath, result);
  fs.writeFileSync(summaryPath, renderScenarioSummary(result));
  console.log(renderScenarioSummary(result));
}

export function analyzeScenarioRecommendations({
  baseRef,
  headRef,
  changedFiles,
  root = process.cwd(),
}: {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  root?: string;
}): ScenarioAdvisorResult {
  const scenarios = loadScenarios(root);
  const suiteToScenarios = buildSuiteToScenarios(scenarios);
  const scenariosWithGpuOrSpecialRunners =
    detectSpecialRunnerScenarios(scenarios);
  const suiteScriptMap = loadSuiteScriptMap(root);
  const suiteIds = new Set(Object.keys(suiteScriptMap));
  const directScenarioIds = new Set<string>();
  const changedSuiteIds = new Set<string>();
  const reasons = new Set<string>();
  const relevantChangedFiles = changedFiles.filter(isScenarioRelevantFile);
  let allScenariosRequired = false;

  for (const file of changedFiles) {
    if (file === ".github/workflows/e2e-scenarios-all.yaml") {
      allScenariosRequired = true;
      reasons.add("the all-scenarios fan-out workflow changed");
    } else if (file === ".github/workflows/e2e-scenarios.yaml") {
      allScenariosRequired = true;
      reasons.add("the reusable single-scenario workflow changed");
    } else if (file === "test/e2e/nemoclaw_scenarios/scenarios.yaml") {
      allScenariosRequired = true;
      reasons.add("scenario catalog metadata changed");
    } else if (file === "test/e2e/nemoclaw_scenarios/expected-states.yaml") {
      allScenariosRequired = true;
      reasons.add("expected-state metadata changed");
    } else if (file === "test/e2e/validation_suites/suites.yaml") {
      allScenariosRequired = true;
      reasons.add("suite catalog metadata changed");
    } else if (
      file.startsWith("test/e2e/runtime/") ||
      file.startsWith("test/e2e/nemoclaw_scenarios/helpers/")
    ) {
      allScenariosRequired = true;
      reasons.add("shared scenario runner/runtime code changed");
    } else if (
      file.startsWith("test/e2e/nemoclaw_scenarios/onboard/") ||
      file.startsWith("test/e2e/nemoclaw_scenarios/install/")
    ) {
      directScenarioIds.add(DEFAULT_BASELINE_SCENARIO);
      reasons.add("scenario install/onboard helper code changed");
    }

    for (const suiteId of inferSuiteIdsFromPath(
      file,
      suiteIds,
      suiteScriptMap,
    )) {
      changedSuiteIds.add(suiteId);
      reasons.add(`validation suite \`${suiteId}\` changed`);
    }
  }

  for (const suiteId of changedSuiteIds) {
    const matchingScenarios = suiteToScenarios.get(suiteId) || [];
    for (const scenario of matchingScenarios) directScenarioIds.add(scenario);
  }

  const required: ScenarioRecommendation[] = [];
  const optional: ScenarioRecommendation[] = [];
  if (allScenariosRequired) {
    required.push({
      id: "e2e-scenarios-all",
      workflow: SCENARIO_ALL_WORKFLOW,
      required: true,
      reason:
        [...reasons].join("; ") || "scenario E2E workflow or metadata changed",
      dispatchCommand:
        "gh workflow run e2e-scenarios-all.yaml --ref <pr-head-ref>",
    });
  }

  for (const scenario of [...directScenarioIds].sort()) {
    if (allScenariosRequired && CORE_SCENARIO_IDS.includes(scenario)) continue;
    const suiteFilter = suiteFilterForScenario(
      scenario,
      changedSuiteIds,
      scenarios,
    );
    required.push(
      buildSingleScenarioRecommendation(
        scenario,
        suiteFilter,
        reasonForScenario(scenario, changedSuiteIds, reasons),
      ),
    );
  }

  if (allScenariosRequired && changedSuiteIds.size > 0) {
    for (const scenario of scenariosForSuites(
      changedSuiteIds,
      suiteToScenarios,
    )) {
      if (CORE_SCENARIO_IDS.includes(scenario)) continue;
      const suiteFilter = suiteFilterForScenario(
        scenario,
        changedSuiteIds,
        scenarios,
      );
      optional.push(
        buildSingleScenarioRecommendation(
          scenario,
          suiteFilter,
          `Targeted follow-up for changed suite(s): ${suiteFilter || [...changedSuiteIds].sort().join(",")}`,
          false,
        ),
      );
    }
  }

  for (const specialScenario of scenariosWithGpuOrSpecialRunners) {
    if (
      [...required, ...optional].some(
        (item) => item.scenario === specialScenario,
      )
    )
      continue;
    const suites = suitesForScenario(specialScenario, scenarios);
    if ([...changedSuiteIds].some((suite) => suites.includes(suite))) {
      optional.push(
        buildSingleScenarioRecommendation(
          specialScenario,
          suiteFilterForScenario(specialScenario, changedSuiteIds, scenarios),
          "Special-runner scenario covers a changed suite but may require scarce hardware/secrets.",
          false,
        ),
      );
    }
  }

  return {
    version: 1,
    baseRef,
    headRef,
    changedFiles,
    relevantChangedFiles,
    required: uniqueRecommendations(required),
    optional: uniqueRecommendations(optional).filter(
      (candidate) => !required.some((item) => item.id === candidate.id),
    ),
    noScenarioE2eReason:
      required.length === 0 && optional.length === 0
        ? "No scenario workflow, scenario metadata, scenario runtime, or validation-suite files changed."
        : null,
    confidence: "high",
  };
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

function loadScenarios(root: string): Record<string, ScenarioEntry> {
  const filePath = path.join(
    root,
    "test/e2e/nemoclaw_scenarios/scenarios.yaml",
  );
  if (!fs.existsSync(filePath)) return {};
  const doc = yaml.load(fs.readFileSync(filePath, "utf8")) as
    | ScenariosFile
    | undefined;
  return { ...(doc?.test_plans ?? {}), ...(doc?.setup_scenarios ?? {}) };
}

function loadSuiteScriptMap(root: string): Record<string, string[]> {
  const filePath = path.join(root, "test/e2e/validation_suites/suites.yaml");
  if (!fs.existsSync(filePath)) return {};
  const doc = yaml.load(fs.readFileSync(filePath, "utf8")) as
    | SuitesFile
    | undefined;
  const output: Record<string, string[]> = {};
  for (const [suiteId, suite] of Object.entries(doc?.suites ?? {})) {
    output[suiteId] = Array.isArray(suite.steps)
      ? suite.steps
          .map((step) => step.script)
          .filter((script): script is string => typeof script === "string")
      : [];
  }
  return output;
}

function buildSuiteToScenarios(
  scenarios: Record<string, ScenarioEntry>,
): Map<string, string[]> {
  const suiteToScenarios = new Map<string, string[]>();
  for (const [scenario, entry] of Object.entries(scenarios)) {
    for (const suite of normalizeStringArray(entry.suites)) {
      const current = suiteToScenarios.get(suite) || [];
      current.push(scenario);
      suiteToScenarios.set(suite, current);
    }
  }
  for (const [suite, scenarioIds] of suiteToScenarios)
    suiteToScenarios.set(suite, scenarioIds.sort());
  return suiteToScenarios;
}

function detectSpecialRunnerScenarios(
  scenarios: Record<string, ScenarioEntry>,
): string[] {
  return Object.entries(scenarios)
    .filter(
      ([id, entry]) =>
        id.startsWith("gpu-") ||
        id.startsWith("macos-") ||
        id.startsWith("wsl-") ||
        id.startsWith("brev-") ||
        normalizeStringArray(entry.runner_requirements).length > 0,
    )
    .map(([id]) => id)
    .sort();
}

function isScenarioRelevantFile(file: string): boolean {
  return (
    file === ".github/workflows/e2e-scenarios.yaml" ||
    file === ".github/workflows/e2e-scenarios-all.yaml" ||
    file.startsWith("test/e2e/runtime/") ||
    file.startsWith("test/e2e/nemoclaw_scenarios/") ||
    file.startsWith("test/e2e/validation_suites/")
  );
}

function inferSuiteIdsFromPath(
  file: string,
  suiteIds: Set<string>,
  suiteScriptMap: Record<string, string[]>,
): string[] {
  if (
    !file.startsWith("test/e2e/validation_suites/") ||
    file.endsWith("/suites.yaml")
  )
    return [];
  const relative = file.slice("test/e2e/validation_suites/".length);
  const segments = relative.split("/");
  const candidates = new Set<string>();
  for (let size = Math.min(segments.length, 3); size >= 1; size -= 1) {
    candidates.add(segments.slice(0, size).join("-"));
    candidates.add(segments.slice(0, size).join("/"));
  }
  candidates.add(segments[0]);
  for (const suiteId of suiteIds) {
    const normalizedSuiteId = suiteId.replaceAll("-", "/");
    if (
      relative === `${normalizedSuiteId}.sh` ||
      relative.startsWith(`${normalizedSuiteId}/`)
    ) {
      candidates.add(suiteId);
    }
  }

  const matches = [...candidates].filter((candidate) =>
    suiteIds.has(candidate),
  );
  if (matches.length > 0)
    return matches.sort((a, b) => b.length - a.length).slice(0, 1);

  const scriptMatches = Object.entries(suiteScriptMap)
    .filter(([, scripts]) => scripts.includes(relative))
    .map(([suiteId]) => suiteId);
  if (scriptMatches.length > 0) return scriptMatches.sort();

  return [segments[0]];
}

function scenariosForSuites(
  changedSuiteIds: Set<string>,
  suiteToScenarios: Map<string, string[]>,
): string[] {
  const scenarioIds = new Set<string>();
  for (const suiteId of changedSuiteIds) {
    for (const scenarioId of suiteToScenarios.get(suiteId) || [])
      scenarioIds.add(scenarioId);
  }
  return [...scenarioIds].sort();
}

function suiteFilterForScenario(
  scenario: string,
  changedSuiteIds: Set<string>,
  scenarios: Record<string, ScenarioEntry>,
): string | undefined {
  const scenarioSuites = suitesForScenario(scenario, scenarios);
  const relevantSuites = [...changedSuiteIds]
    .filter((suite) => scenarioSuites.includes(suite))
    .sort();
  return relevantSuites.length > 0 ? relevantSuites.join(",") : undefined;
}

function suitesForScenario(
  scenario: string,
  scenarios: Record<string, ScenarioEntry>,
): string[] {
  return normalizeStringArray(scenarios[scenario]?.suites);
}

function reasonForScenario(
  scenario: string,
  changedSuiteIds: Set<string>,
  reasons: Set<string>,
): string {
  const suiteText =
    changedSuiteIds.size > 0
      ? ` Changed suite(s): ${[...changedSuiteIds]
          .sort()
          .map((suite) => `\`${suite}\``)
          .join(", ")}.`
      : "";
  return `Scenario \`${scenario}\` exercises the changed scenario E2E surface.${suiteText} ${[...reasons].join("; ")}`.trim();
}

function buildSingleScenarioRecommendation(
  scenario: string,
  suiteFilter: string | undefined,
  reason: string,
  required = true,
): ScenarioRecommendation {
  const suitePart = suiteFilter
    ? ` --field suite_filter=${shellQuote(suiteFilter)}`
    : "";
  return {
    id: suiteFilter ? `${scenario}:${suiteFilter}` : scenario,
    workflow: SCENARIO_WORKFLOW,
    scenario,
    suiteFilter,
    required,
    reason,
    dispatchCommand: `gh workflow run e2e-scenarios.yaml --ref <pr-head-ref> --field scenario=${shellQuote(scenario)}${suitePart}`,
  };
}

function uniqueRecommendations(
  recommendations: ScenarioRecommendation[],
): ScenarioRecommendation[] {
  const seen = new Set<string>();
  const output: ScenarioRecommendation[] = [];
  for (const recommendation of recommendations) {
    if (seen.has(recommendation.id)) continue;
    seen.add(recommendation.id);
    output.push(recommendation);
  }
  return output;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.:/=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
