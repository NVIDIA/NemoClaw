#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import yaml from "yaml";

const root = process.cwd();
const advisorRoot = process.env.GITHUB_WORKSPACE || root;
const args = parseArgs(process.argv.slice(2));
const outDir = args.outDir || "artifacts/e2e-advisor";
const baselinePath = args.baseline || path.join(outDir, "e2e-advisor-result.json");
const manifestPath = args.manifest || "test/e2e/e2e-manifest.yaml";
const schemaPath = args.schema || "tools/e2e-advisor/schema.json";
const scriptDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(.:\/)/, "$1");
const modelsTemplatePath = args.modelsTemplate || path.join(scriptDir, "pi-models.template.json");
const promptPath = path.join(outDir, "e2e-advisor-pi-prompt.md");
const rawPath = path.join(outDir, "e2e-advisor-pi-raw-output.txt");
// Keep generated Pi credential config outside uploaded artifacts.
const piConfigDir = process.env.PI_E2E_ADVISOR_CONFIG_DIR || path.join("/tmp", `nemoclaw-e2e-advisor-pi-config-${process.pid}`);
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

if (!hasLikelyPiCredential()) {
  writeSkipped("No Pi provider credential was available in this workflow environment");
  process.exit(0);
}

const piBin = process.env.PI_BIN || "pi";
const provider = process.env.PI_E2E_ADVISOR_PROVIDER || (process.env.PI_E2E_ADVISOR_API_KEY ? "anthropic" : "");
const model = process.env.PI_E2E_ADVISOR_MODEL || defaultModelForProvider(provider);
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

if (provider) {
  piArgs.unshift("--provider", provider);
}
if (model) {
  piArgs.unshift("--model", model);
}
const promptStdin = process.env.PI_E2E_ADVISOR_PROMPT_STDIN !== "0";
if (promptStdin) {
  piArgs.push("Analyze the E2E advisor prompt from stdin and return JSON only.");
} else {
  piArgs.push(prompt);
}

const childEnv = {
  ...process.env,
  PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || "1",
};
preparePiConfig(childEnv, provider);

const child = spawnSync(piBin, piArgs, {
  cwd: root,
  encoding: "utf8",
  timeout: timeoutMs,
  maxBuffer: 20 * 1024 * 1024,
  input: promptStdin ? prompt : undefined,
  env: childEnv,
});

const combinedOutput = [
  child.stdout || "",
  child.stderr ? `\n--- STDERR ---\n${child.stderr}` : "",
].join("");
fs.writeFileSync(rawPath, combinedOutput);

if (child.error) {
  writeFailure(`pi execution failed: ${child.error.message}`);
  process.exit(1);
}
if (child.status !== 0) {
  writeFailure(`pi exited with status ${child.status}; see ${rawPath}`);
  process.exit(1);
}

let piResult;
try {
  piResult = normalizePiResult(extractJson(child.stdout || combinedOutput), baseline);
} catch (error) {
  writeFailure(error.message);
  process.exit(1);
}
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

function hasLikelyPiCredential() {
  const credentialEnv = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "FIREWORKS_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "MISTRAL_API_KEY",
    "MINIMAX_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENCODE_API_KEY",
    "KIMI_API_KEY",
    "CLOUDFLARE_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
  ];
  return Boolean(process.env.PI_E2E_ADVISOR_API_KEY) || credentialEnv.some((name) => Boolean(process.env[name])) || Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function preparePiConfig(env, provider) {
  if (!env.PI_E2E_ADVISOR_API_KEY) {
    return;
  }
  const envName = providerEnvName(provider || "anthropic");
  if (envName && !env[envName]) {
    env[envName] = env.PI_E2E_ADVISOR_API_KEY;
  }

  const templatePath = path.isAbsolute(modelsTemplatePath)
    ? modelsTemplatePath
    : path.resolve(advisorRoot, modelsTemplatePath);
  if (fs.existsSync(templatePath)) {
    fs.mkdirSync(piConfigDir, { recursive: true });
    fs.writeFileSync(path.join(piConfigDir, "auth.json"), "{}\n", { mode: 0o600 });
    const settings = {
      defaultProvider: provider || "anthropic",
      defaultModel: model || defaultModelForProvider(provider),
      defaultThinkingLevel: "medium",
    };
    fs.writeFileSync(path.join(piConfigDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    const models = fs.readFileSync(templatePath, "utf8").replaceAll("__PI_E2E_ADVISOR_API_KEY__", env.PI_E2E_ADVISOR_API_KEY);
    fs.writeFileSync(path.join(piConfigDir, "models.json"), models, { mode: 0o600 });
    env.PI_CODING_AGENT_DIR = path.resolve(root, piConfigDir);
  }
}

function providerEnvName(provider) {
  const normalized = provider.toLowerCase();
  if (normalized.includes("anthropic")) return "ANTHROPIC_API_KEY";
  if (normalized.includes("openai")) return "OPENAI_API_KEY";
  if (normalized.includes("azure")) return "AZURE_OPENAI_API_KEY";
  if (normalized.includes("google") || normalized.includes("gemini")) return "GEMINI_API_KEY";
  if (normalized.includes("deepseek")) return "DEEPSEEK_API_KEY";
  if (normalized.includes("groq")) return "GROQ_API_KEY";
  if (normalized.includes("cerebras")) return "CEREBRAS_API_KEY";
  if (normalized.includes("xai")) return "XAI_API_KEY";
  if (normalized.includes("fireworks")) return "FIREWORKS_API_KEY";
  if (normalized.includes("openrouter")) return "OPENROUTER_API_KEY";
  if (normalized.includes("vercel")) return "AI_GATEWAY_API_KEY";
  if (normalized.includes("zai")) return "ZAI_API_KEY";
  if (normalized.includes("mistral")) return "MISTRAL_API_KEY";
  if (normalized.includes("minimax")) return "MINIMAX_API_KEY";
  if (normalized.includes("moonshot")) return "MOONSHOT_API_KEY";
  if (normalized.includes("opencode")) return "OPENCODE_API_KEY";
  if (normalized.includes("kimi")) return "KIMI_API_KEY";
  return "OPENAI_API_KEY";
}

function defaultModelForProvider(provider) {
  const normalized = (provider || "").toLowerCase();
  if (normalized.includes("anthropic")) return "aws/anthropic/bedrock-claude-opus-4-7";
  if (normalized.includes("openai")) return "openai/openai/gpt-5.5";
  return "";
}

function writeFailure(reason) {
  const failure = {
    failed: true,
    reason,
    promptPath,
    baselinePath,
    rawPath,
  };
  fs.writeFileSync(piResultPath, `${JSON.stringify(failure, null, 2)}\n`);
  fs.copyFileSync(path.resolve(root, baselinePath), finalResultPath);
  fs.writeFileSync(piSummaryPath, `# Pi Semantic E2E Advisor\n\nFailed: ${reason}\n\nFalling back to deterministic baseline in \`e2e-advisor-final-result.json\`.\n`);
  console.error(`Pi semantic analysis failed: ${reason}`);
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
