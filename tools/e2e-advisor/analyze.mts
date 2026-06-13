#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

type ArtifactPaths = AdvisorArtifactPaths;

type AdvisorSchema = Record<string, unknown>;
type Confidence = "low" | "medium" | "high";
type AdvisorMetadata = {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
};
type AdvisorDomain = {
  domain?: string;
  reason?: string;
  confidence: Confidence;
  matchedFiles: string[];
};
type AdvisorTest = {
  id?: string;
  reason?: string;
  workflow?: string;
  job?: string;
  script?: string;
  cost?: string;
  runner?: string;
};
type AdvisorNewRecommendation = {
  domain?: string;
  reason?: string;
  suggestedTest?: string;
  priority: Confidence;
};
type AdvisorDispatchHint = {
  workflow: string;
  jobsInput: string;
};
type AdvisorResult = {
  version: 1;
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  classifiedDomains: AdvisorDomain[];
  requiredTests: AdvisorTest[];
  optionalTests: AdvisorTest[];
  newE2eRecommendations: AdvisorNewRecommendation[];
  noE2eReason: string | null;
  confidence: Confidence;
  dispatchHint?: AdvisorDispatchHint;
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
  const schemaPath = args.schema || "tools/e2e-advisor/schema.json";
  const artifacts = artifactPaths(outDir);
  // Keep generated advisor credential config outside uploaded artifacts.
  const configDir =
    process.env.E2E_ADVISOR_CONFIG_DIR ||
    path.join("/tmp", `nemoclaw-e2e-advisor-config-${process.pid}`);
  const timeoutMs = parsePositiveInt(process.env.E2E_ADVISOR_TIMEOUT_MS, 900000);
  const heartbeatMs = parsePositiveInt(process.env.E2E_ADVISOR_HEARTBEAT_MS, 60000);
  const maxCaptureBytes = parsePositiveInt(
    process.env.E2E_ADVISOR_MAX_CAPTURE_BYTES,
    5 * 1024 * 1024,
  );

  fs.mkdirSync(outDir, { recursive: true });

  logProgress(`Starting advisor analysis: base=${baseRef} head=${headRef} outDir=${outDir}`);
  const schema = readJson<AdvisorSchema>(schemaPath);
  const changedFiles = getChangedFiles(baseRef, headRef);
  logProgress(`Detected ${changedFiles.length} changed file(s)`);
  const diff = getDiff(baseRef, headRef, 120000);
  logProgress(`Collected diff: ${diff.length} character(s) after truncation`);
  const systemPrompt = buildSystemPrompt(schema);
  const prompt = buildPrompt({ baseRef, headRef, changedFiles, diff });
  fs.writeFileSync(artifacts.prompt, prompt);
  logProgress(`Wrote advisor prompt: ${prompt.length} character(s) at ${artifacts.prompt}`);

  const metadata = { baseRef, headRef, changedFiles };
  const writeFailure = (reason: string): void =>
    writeUnavailableArtifacts(artifacts, metadata, reason, true);
  const writeUnavailable = (reason: string): void =>
    writeUnavailableArtifacts(artifacts, metadata, reason, false);

  if (process.env.E2E_ADVISOR_RUN_ANALYSIS === "0") {
    writeUnavailable("E2E_ADVISOR_RUN_ANALYSIS=0");
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
      promptTurns: [{ name: "analysis", prompt }],
      systemPrompt,
      configDir,
      htmlExportPath: artifacts.sessionHtml,
      timeoutMs,
      heartbeatMs,
      maxCaptureBytes,
      credentialEnv: ADVISOR_CREDENTIAL_ENV,
      logPrefix: "e2e-advisor",
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
    fs.writeFileSync(artifacts.raw, `Advisor SDK execution failed: ${reason}\n`);
    writeFailure(reason);
    process.exit(1);
  }

  let result: AdvisorResult;
  try {
    result = normalizeAdvisorResult(
      extractJson(sdkResult.text || sdkResult.raw, artifacts.raw, "e2e_advisor_json"),
      metadata,
    );
  } catch (error: unknown) {
    writeFailure(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  writeJson(artifacts.result, result);
  writeJson(artifacts.finalResult, result);
  const summary = renderSummary(result);
  fs.writeFileSync(artifacts.summary, summary);
  console.log(summary);
}

function artifactPaths(outDir: string): ArtifactPaths {
  return advisorArtifactPaths(outDir, "e2e-advisor");
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
    `# E2E Recommendation Advisor\n\n${failed ? "Failed" : "Skipped"}: ${reason}\n`,
  );
  if (failed) {
    console.error(`Advisor analysis failed: ${reason}`);
  }
}

function logProgress(message: string): void {
  console.log(`[e2e-advisor] ${new Date().toISOString()} ${message}`);
}

function buildSystemPrompt(schema: AdvisorSchema): string {
  return [
    "You are the NemoClaw E2E recommendation advisor for CI.",
    "",
    "NemoClaw is NVIDIA's reference stack for running OpenClaw always-on assistants inside NVIDIA OpenShell sandboxes. It includes:",
    "- a Node/TypeScript CLI for install, onboarding, credentials, policy, inference, and sandbox lifecycle;",
    "- an OpenClaw plugin and TypeScript blueprint runner;",
    "- YAML blueprint/network-policy assets;",
    "- scenario-based and workflow-dispatched E2E tests for real user flows.",
    "",
    "Recommend which existing E2E jobs should run for a PR. Use the diff and inspect nearby repository files as needed, especially .github/workflows, test/e2e, touched source files, and related tests.",
    "",
    "Decision policy:",
    "- Required E2E: changes that can affect installer/onboarding, sandbox lifecycle, credentials, security boundaries, network policy, inference routing, deployment, or real assistant user flows.",
    "- Optional E2E: useful confidence checks for adjacent behavior, but not merge-blocking.",
    "- No E2E: safe docs, tests-only, comments, refactors, or tooling changes that cannot affect runtime/user flows; explain in noE2eReason.",
    "- Missing coverage: use newE2eRecommendations. Do not invent existing test names.",
    "",
    "Return JSON only matching this schema:",
    "```json",
    JSON.stringify(schema),
    "```",
  ].join("\n");
}

function buildPrompt({
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
  return `Return an E2E recommendation for this PR.

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

function normalizeAdvisorResult(result: unknown, metadata: AdvisorMetadata): AdvisorResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Advisor returned a non-object result");
  }

  const object = result as Record<string, unknown>;
  const normalized: AdvisorResult = {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    changedFiles: metadata.changedFiles,
    classifiedDomains: sanitizeDomains(object.classifiedDomains),
    requiredTests: sanitizeTests(object.requiredTests),
    optionalTests: sanitizeTests(object.optionalTests),
    newE2eRecommendations: sanitizeNewRecommendations(object.newE2eRecommendations),
    noE2eReason:
      typeof object.noE2eReason === "string" || object.noE2eReason === null
        ? object.noE2eReason
        : null,
    confidence: isConfidence(object.confidence) ? object.confidence : "medium",
  };

  const dispatchHint = sanitizeDispatchHint(object.dispatchHint);
  if (dispatchHint) {
    normalized.dispatchHint = dispatchHint;
  }

  return normalized;
}

function sanitizeDomains(value: unknown): AdvisorDomain[] {
  return recordItems(value)
    .map((item) => ({
      domain: stringOrUndefined(item.domain),
      reason: stringOrUndefined(item.reason),
      confidence: isConfidence(item.confidence) ? item.confidence : "medium",
      matchedFiles: Array.isArray(item.matchedFiles)
        ? item.matchedFiles.filter((file): file is string => typeof file === "string")
        : [],
    }))
    .filter((item) => item.domain && item.reason);
}

function sanitizeTests(value: unknown): AdvisorTest[] {
  return recordItems(value)
    .map((item) => ({
      id: stringOrUndefined(item.id),
      reason: stringOrUndefined(item.reason),
      workflow: stringOrUndefined(item.workflow),
      job: stringOrUndefined(item.job),
      script: stringOrUndefined(item.script),
      cost: stringOrUndefined(item.cost),
      runner: stringOrUndefined(item.runner),
    }))
    .filter((item) => item.id && item.reason)
    .map(dropUndefinedValues);
}

function sanitizeNewRecommendations(value: unknown): AdvisorNewRecommendation[] {
  return recordItems(value)
    .map((item) => ({
      domain: stringOrUndefined(item.domain),
      reason: stringOrUndefined(item.reason),
      suggestedTest: stringOrUndefined(item.suggestedTest),
      priority: isConfidence(item.priority) ? item.priority : "medium",
    }))
    .filter((item) => item.domain && item.reason && item.suggestedTest);
}

function sanitizeDispatchHint(value: unknown): AdvisorDispatchHint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.workflow !== "string" || typeof object.jobsInput !== "string") return undefined;
  return { workflow: object.workflow, jobsInput: object.jobsInput };
}

function isConfidence(value: unknown): value is Confidence {
  return value === "low" || value === "medium" || value === "high";
}

function renderSummary(result: AdvisorResult): string {
  const lines: string[] = [];
  lines.push("# E2E Recommendation Advisor");
  lines.push("");
  lines.push(`Base: \`${result.baseRef}\`  `);
  lines.push(`Head: \`${result.headRef}\`  `);
  lines.push(`Confidence: **${result.confidence}**`);
  lines.push("");
  lines.push("## Required E2E");
  if (result.requiredTests.length === 0) {
    lines.push(`- _None._ ${result.noE2eReason || ""}`.trim());
  } else {
    for (const test of result.requiredTests) {
      lines.push(`- **${test.id}**${test.cost ? ` (${test.cost})` : ""}: ${test.reason}`);
    }
  }
  lines.push("");
  lines.push("## Optional E2E");
  if (result.optionalTests.length === 0) {
    lines.push("- _None._");
  } else {
    for (const test of result.optionalTests) {
      lines.push(`- **${test.id}**${test.cost ? ` (${test.cost})` : ""}: ${test.reason}`);
    }
  }
  lines.push("");
  lines.push("## New E2E recommendations");
  if (result.newE2eRecommendations.length === 0) {
    lines.push("- _None._");
  } else {
    for (const gap of result.newE2eRecommendations) {
      lines.push(`- **${gap.domain}** (${gap.priority || "medium"}): ${gap.reason}`);
      lines.push(`  - Suggested test: ${gap.suggestedTest}`);
    }
  }
  lines.push("");
  if (result.dispatchHint) {
    lines.push("## Dispatch hint");
    lines.push(`- Workflow: \`${result.dispatchHint.workflow}\``);
    lines.push(`- \`jobs\` input: \`${result.dispatchHint.jobsInput}\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function unavailableResult(
  metadata: AdvisorMetadata,
  reason: string,
  failed: boolean,
): AdvisorResult {
  return {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    changedFiles: metadata.changedFiles,
    classifiedDomains: [],
    requiredTests: [],
    optionalTests: [],
    newE2eRecommendations: failed
      ? [
          {
            domain: "e2e-advisor",
            reason: `Advisor review failed: ${reason}`,
            suggestedTest: "Re-run E2E Advisor after fixing advisor execution.",
            priority: "high",
          },
        ]
      : [],
    noE2eReason: failed ? null : `Advisor review unavailable: ${reason}`,
    confidence: "low",
  };
}
