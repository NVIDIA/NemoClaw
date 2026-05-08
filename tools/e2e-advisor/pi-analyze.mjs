#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import yaml from "yaml";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const outDir = args.outDir || "artifacts/e2e-advisor";
const baselinePath = args.baseline || path.join(outDir, "e2e-advisor-result.json");
const manifestPath = args.manifest || "test/e2e/e2e-manifest.yaml";
const schemaPath = args.schema || "tools/e2e-advisor/schema.json";
const promptPath = path.join(outDir, "e2e-advisor-pi-prompt.md");
const rawPath = path.join(outDir, "e2e-advisor-pi-raw-output.txt");
const piResultPath = path.join(outDir, "e2e-advisor-pi-result.json");
const finalResultPath = path.join(outDir, "e2e-advisor-final-result.json");
const piSummaryPath = path.join(outDir, "e2e-advisor-pi-summary.md");
const timeoutMs = Number.parseInt(process.env.PI_E2E_ADVISOR_TIMEOUT_MS || "900000", 10);

fs.mkdirSync(outDir, { recursive: true });

const baseline = readJson(baselinePath);
const manifest = readYaml(manifestPath);
const schema = readJson(schemaPath);
const diff = getDiff(baseline.baseRef, baseline.headRef, 90000);
const prompt = buildPrompt({ baseline, manifest, schema, diff });
fs.writeFileSync(promptPath, prompt);

if (process.env.PI_E2E_ADVISOR_RUN_PI === "0") {
  writeSkipped("PI_E2E_ADVISOR_RUN_PI=0");
  process.exit(0);
}

const piBin = process.env.PI_BIN || "pi";
const piArgs = [
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--tools",
  "read,grep,find,ls",
  "--print",
];

if (process.env.PI_E2E_ADVISOR_PROVIDER) {
  piArgs.unshift("--provider", process.env.PI_E2E_ADVISOR_PROVIDER);
}
if (process.env.PI_E2E_ADVISOR_MODEL) {
  piArgs.unshift("--model", process.env.PI_E2E_ADVISOR_MODEL);
}
piArgs.push(prompt);

const child = spawnSync(piBin, piArgs, {
  cwd: root,
  encoding: "utf8",
  timeout: timeoutMs,
  maxBuffer: 20 * 1024 * 1024,
  env: {
    ...process.env,
    PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || "1",
  },
});

const combinedOutput = [
  child.stdout || "",
  child.stderr ? `\n--- STDERR ---\n${child.stderr}` : "",
].join("");
fs.writeFileSync(rawPath, combinedOutput);

if (child.error) {
  throw new Error(`pi execution failed: ${child.error.message}`);
}
if (child.status !== 0) {
  throw new Error(`pi exited with status ${child.status}; see ${rawPath}`);
}

const piResult = normalizePiResult(extractJson(child.stdout || combinedOutput), baseline);
fs.writeFileSync(piResultPath, `${JSON.stringify(piResult, null, 2)}\n`);
fs.writeFileSync(finalResultPath, `${JSON.stringify(piResult, null, 2)}\n`);
fs.writeFileSync(piSummaryPath, renderPiSummary(piResult));
console.log(renderPiSummary(piResult));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      parsed[key] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function readJson(relativeOrAbsolutePath) {
  return JSON.parse(fs.readFileSync(path.resolve(root, relativeOrAbsolutePath), "utf8"));
}

function readYaml(relativeOrAbsolutePath) {
  return yaml.parse(fs.readFileSync(path.resolve(root, relativeOrAbsolutePath), "utf8"));
}

function getDiff(baseRef, headRef, maxChars) {
  const commands = [
    ["diff", "--find-renames", "--find-copies", "--unified=80", `${baseRef}...${headRef}`],
    ["diff", "--find-renames", "--find-copies", "--unified=80", `${baseRef}..${headRef}`],
  ];
  for (const command of commands) {
    try {
      const stdout = execFileSync("git", command, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
      return truncate(stdout, maxChars);
    } catch {
      // Try next diff form.
    }
  }
  return "";
}

function buildPrompt({ baseline, manifest, schema, diff }) {
  const manifestSummary = (manifest.tests || []).map((test) => ({
    id: test.id,
    workflow: test.workflow,
    job: test.job,
    script: test.script,
    runner: test.runner,
    cost: test.cost,
    domains: test.domains,
    risk_areas: test.risk_areas,
  }));

  return `You are the NemoClaw semantic E2E test advisor running in CI.

Goal: analyze this PR/branch statically and decide which existing E2E tests should run, plus whether a new E2E test is recommended. The deterministic baseline is path-rule based; improve it using semantic reasoning over the diff and repository files.

Hard constraints:
- Static analysis only. Do not execute repository scripts, tests, package managers, or generated code.
- You may use only read-only inspection tools if needed: read, grep, find, ls.
- Prefer exact test IDs from the manifest. Do not invent existing test IDs.
- If behavior is not covered by existing tests, add a newE2eRecommendations entry instead of inventing a test ID.
- Required tests are for high-risk behavior likely to break real users or security. Optional tests are useful but not mandatory.
- If no existing E2E is required, set requiredTests to [] and noE2eReason to a concise explanation.
- Return JSON only. No markdown, no code fences, no commentary outside JSON.

Output must conform to this JSON schema shape. You may omit optional dispatchHint if no nightly jobs are required:
${JSON.stringify(schema, null, 2)}

Required output metadata values:
- version: 1
- baseRef: ${JSON.stringify(baseline.baseRef)}
- headRef: ${JSON.stringify(baseline.headRef)}
- changedFiles: exactly the provided changedFiles array

Existing E2E manifest summary:
${JSON.stringify(manifestSummary, null, 2)}

Deterministic baseline result to review/improve:
${JSON.stringify(baseline, null, 2)}

Git diff, truncated if large:
${diff || "<no diff available>"}
`;
}

function extractJson(text) {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    fenced(trimmed),
    tagged(trimmed, "e2e_advisor_json"),
    balancedObject(trimmed),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }
  throw new Error(`Could not parse JSON from pi output; see ${rawPath}`);
}

function fenced(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim();
}

function tagged(text, tag) {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
  return match?.[1]?.trim();
}

function balancedObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

function normalizePiResult(result, baseline) {
  const normalized = {
    version: 1,
    baseRef: baseline.baseRef,
    headRef: baseline.headRef,
    changedFiles: baseline.changedFiles,
    classifiedDomains: Array.isArray(result.classifiedDomains) ? result.classifiedDomains : baseline.classifiedDomains,
    requiredTests: Array.isArray(result.requiredTests) ? result.requiredTests : baseline.requiredTests,
    optionalTests: Array.isArray(result.optionalTests) ? result.optionalTests : baseline.optionalTests,
    newE2eRecommendations: Array.isArray(result.newE2eRecommendations)
      ? result.newE2eRecommendations
      : baseline.newE2eRecommendations,
    noE2eReason: Object.hasOwn(result, "noE2eReason") ? result.noE2eReason : baseline.noE2eReason,
    confidence: ["low", "medium", "high"].includes(result.confidence) ? result.confidence : baseline.confidence,
  };

  if (result.dispatchHint && typeof result.dispatchHint === "object") {
    normalized.dispatchHint = result.dispatchHint;
  } else if (baseline.dispatchHint) {
    normalized.dispatchHint = baseline.dispatchHint;
  }

  return normalized;
}

function renderPiSummary(result) {
  const lines = [];
  lines.push("# Pi Semantic E2E Advisor");
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

function truncate(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n<diff truncated at ${maxChars} characters>`;
}

function writeSkipped(reason) {
  const skipped = {
    skipped: true,
    reason,
    promptPath,
    baselinePath,
  };
  fs.writeFileSync(piResultPath, `${JSON.stringify(skipped, null, 2)}\n`);
  fs.writeFileSync(piSummaryPath, `# Pi Semantic E2E Advisor\n\nSkipped: ${reason}\n`);
  fs.copyFileSync(path.resolve(root, baselinePath), finalResultPath);
  console.log(`Pi semantic analysis skipped: ${reason}`);
}
