#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const root = process.cwd();
const advisorRoot = process.env.GITHUB_WORKSPACE || root;
const args = parseArgs(process.argv.slice(2));
const outDir = args.outDir || "artifacts/e2e-advisor";
const baseRef = args.base || process.env.BASE_REF || "origin/main";
const headRef = args.head || process.env.HEAD_REF || "HEAD";
const schemaPath = args.schema || "tools/e2e-advisor/schema.json";
const scriptDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(.:\/)/, "$1");
const modelsTemplatePath = args.modelsTemplate || path.join(scriptDir, "pi-models.template.json");
const promptPath = path.join(outDir, "e2e-advisor-pi-prompt.md");
const rawPath = path.join(outDir, "e2e-advisor-pi-raw-output.txt");
const piResultPath = path.join(outDir, "e2e-advisor-pi-result.json");
const finalResultPath = path.join(outDir, "e2e-advisor-final-result.json");
const piSummaryPath = path.join(outDir, "e2e-advisor-pi-summary.md");
// Keep generated Pi credential config outside uploaded artifacts.
const piConfigDir = process.env.PI_E2E_ADVISOR_CONFIG_DIR || path.join("/tmp", `nemoclaw-e2e-advisor-pi-config-${process.pid}`);
const timeoutMs = parsePositiveInt(process.env.PI_E2E_ADVISOR_TIMEOUT_MS, 900000);
const heartbeatMs = parsePositiveInt(process.env.PI_E2E_ADVISOR_HEARTBEAT_MS, 60000);
const maxCaptureBytes = parsePositiveInt(process.env.PI_E2E_ADVISOR_MAX_CAPTURE_BYTES, 5 * 1024 * 1024);

fs.mkdirSync(outDir, { recursive: true });

logProgress(`Starting advisor analysis: base=${baseRef} head=${headRef} outDir=${outDir}`);
const schema = readJson(schemaPath);
const changedFiles = getChangedFiles(baseRef, headRef);
logProgress(`Detected ${changedFiles.length} changed file(s)`);
const diff = getDiff(baseRef, headRef, 120000);
logProgress(`Collected diff: ${diff.length} character(s) after truncation`);
const prompt = buildPrompt({ baseRef, headRef, changedFiles, schema, diff });
fs.writeFileSync(promptPath, prompt);
logProgress(`Wrote Pi prompt: ${prompt.length} character(s) at ${promptPath}`);

if (process.env.PI_E2E_ADVISOR_RUN_PI === "0") {
  writeUnavailable("PI_E2E_ADVISOR_RUN_PI=0");
  process.exit(0);
}

if (!hasLikelyPiCredential()) {
  writeUnavailable("No Pi provider credential was available in this workflow environment");
  process.exit(0);
}

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
piArgs.push("Analyze the NemoClaw PR from the prompt on stdin. Use read-only tools as needed. Return JSON only.");

const childEnv = {
  ...process.env,
  PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || "1",
};
preparePiConfig(childEnv, provider, model);
logProgress(`Launching Pi: provider=${provider || "<default>"} model=${model || "<default>"} timeoutMs=${timeoutMs} heartbeatMs=${heartbeatMs}`);
logProgress("Pi tools enabled: read,grep,find,ls; repository commands remain disabled by prompt policy");

const child = await runPi(process.env.PI_BIN || "pi", piArgs, {
  cwd: root,
  env: childEnv,
  input: prompt,
  timeoutMs,
  heartbeatMs,
  maxCaptureBytes,
});

const capturedStdout = child.stdoutDroppedBytes > 0
  ? `<stdout truncated; dropped ${child.stdoutDroppedBytes} byte(s)>\n${child.stdout}`
  : child.stdout;
const capturedStderr = child.stderrDroppedBytes > 0
  ? `<stderr truncated; dropped ${child.stderrDroppedBytes} byte(s)>\n${child.stderr}`
  : child.stderr;
const combinedOutput = [capturedStdout || "", capturedStderr ? `\n--- STDERR ---\n${capturedStderr}` : ""].join("");
fs.writeFileSync(rawPath, combinedOutput);
logProgress(`Pi finished: status=${child.status ?? "<none>"} signal=${child.signal || "<none>"} stdoutBytes=${Buffer.byteLength(child.stdout || "")} stderrBytes=${Buffer.byteLength(child.stderr || "")} stdoutDroppedBytes=${child.stdoutDroppedBytes} stderrDroppedBytes=${child.stderrDroppedBytes}`);

if (child.error) {
  writeFailure(`pi execution failed: ${child.error.message}`);
  process.exit(1);
}
if (child.status !== 0) {
  writeFailure(`pi exited with status ${child.status}; see ${rawPath}`);
  process.exit(1);
}

let result;
try {
  result = normalizePiResult(extractJson(child.stdout || combinedOutput), { baseRef, headRef, changedFiles });
} catch (error) {
  writeFailure(error.message);
  process.exit(1);
}

fs.writeFileSync(piResultPath, `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(finalResultPath, `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(piSummaryPath, renderSummary(result));
console.log(renderSummary(result));

function logProgress(message) {
  console.log(`[e2e-advisor] ${new Date().toISOString()} ${message}`);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runPi(command, commandArgs, { cwd, env, input, timeoutMs, heartbeatMs, maxCaptureBytes }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutDroppedBytes = 0;
    let stderrDroppedBytes = 0;
    let spawnError;
    let timedOut = false;

    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      logProgress(`Pi still running: elapsed=${elapsedSeconds}s timeout=${Math.round(timeoutMs / 1000)}s`);
    }, Math.max(heartbeatMs, 1000));
    heartbeat.unref?.();

    const timeout = setTimeout(() => {
      timedOut = true;
      logProgress(`Pi exceeded timeoutMs=${timeoutMs}; sending SIGTERM`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          logProgress("Pi did not exit after SIGTERM; sending SIGKILL");
          child.kill("SIGKILL");
        }
      }, 5000).unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const captured = appendCapped(stdout, chunk, maxCaptureBytes, stdoutDroppedBytes);
      stdout = captured.text;
      stdoutDroppedBytes = captured.droppedBytes;
    });
    child.stderr.on("data", (chunk) => {
      const captured = appendCapped(stderr, chunk, maxCaptureBytes, stderrDroppedBytes);
      stderr = captured.text;
      stderrDroppedBytes = captured.droppedBytes;
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      const error = timedOut
        ? new Error(`timed out after ${timeoutMs} ms`)
        : spawnError;
      resolve({ stdout, stderr, stdoutDroppedBytes, stderrDroppedBytes, status, signal, error });
    });

    child.stdin.end(input);
  });
}

function appendCapped(current, chunk, maxBytes, droppedBytes) {
  let next = current + chunk;
  let nextDroppedBytes = droppedBytes;
  let nextBytes = Buffer.byteLength(next, "utf8");
  if (nextBytes <= maxBytes) {
    return { text: next, droppedBytes: nextDroppedBytes };
  }

  let removeChars = Math.min(next.length, Math.max(1, nextBytes - maxBytes));
  while (removeChars < next.length && Buffer.byteLength(next.slice(removeChars), "utf8") > maxBytes) {
    removeChars += 1;
  }
  nextDroppedBytes += Buffer.byteLength(next.slice(0, removeChars), "utf8");
  next = next.slice(removeChars);
  return { text: next, droppedBytes: nextDroppedBytes };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        parsed[key] = undefined;
        continue;
      }
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function readJson(relativeOrAbsolutePath) {
  return JSON.parse(fs.readFileSync(path.resolve(root, relativeOrAbsolutePath), "utf8"));
}

function getChangedFiles(base, head) {
  const commands = [
    ["diff", "--name-only", `${base}...${head}`],
    ["diff", "--name-only", `${base}..${head}`],
  ];
  for (const command of commands) {
    try {
      const stdout = execFileSync("git", command, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
    } catch {
      // Try next diff form. Some checkouts do not have a merge base locally.
    }
  }
  throw new Error(`failed to diff ${base}..${head}; ensure both refs are fetched`);
}

function getDiff(base, head, maxChars) {
  const commands = [
    ["diff", "--find-renames", "--find-copies", "--unified=80", `${base}...${head}`],
    ["diff", "--find-renames", "--find-copies", "--unified=80", `${base}..${head}`],
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

function buildPrompt({ baseRef, headRef, changedFiles, schema, diff }) {
  return `You are the NemoClaw E2E Advisor running in CI for an internal PR.

Your job is to semantically review the PR and the repository, then recommend which E2E tests should run.

This is intentionally NOT a path-rule or manifest-driven advisor. Use your judgment. Inspect repository files with read-only tools to understand:
- existing E2E workflows under .github/workflows,
- E2E scripts and scenarios under test/e2e,
- source files touched by the PR,
- nearby tests and code paths related to the change.

Hard constraints:
- Static analysis only. Do not execute repository scripts, tests, package managers, or generated code.
- Use only read-only tools: read, grep, find, ls.
- Recommend existing E2E tests by their actual workflow job/script names after inspecting the repo.
- Do not invent existing tests. If behavior is not covered, add a newE2eRecommendations entry.
- Required tests are for changes that can break real user flows, security boundaries, networking, credentials, installer/onboarding, sandbox lifecycle, inference routing, or deployment behavior.
- Optional tests are useful confidence checks but not merge-blocking recommendations.
- If no E2E is needed, set requiredTests to [] and explain in noE2eReason.
- Return JSON only. No markdown, no code fences, no commentary outside JSON.

Output must conform to this JSON schema shape:
${JSON.stringify(schema, null, 2)}

Required output metadata values:
- version: 1
- baseRef: ${JSON.stringify(baseRef)}
- headRef: ${JSON.stringify(headRef)}
- changedFiles: exactly this array: ${JSON.stringify(changedFiles)}

Changed files:
${changedFiles.map((file) => `- ${file}`).join("\n") || "- <none>"}

Git diff, truncated if large:
${diff || "<no diff available>"}
`;
}

function extractJson(text) {
  const trimmed = text.trim();
  const candidates = [trimmed, fenced(trimmed), tagged(trimmed, "e2e_advisor_json"), balancedObject(trimmed)].filter(Boolean);

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

function normalizePiResult(result, metadata) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Pi returned a non-object result");
  }

  const normalized = {
    version: 1,
    baseRef: metadata.baseRef,
    headRef: metadata.headRef,
    changedFiles: metadata.changedFiles,
    classifiedDomains: sanitizeDomains(result.classifiedDomains),
    requiredTests: sanitizeTests(result.requiredTests),
    optionalTests: sanitizeTests(result.optionalTests),
    newE2eRecommendations: sanitizeNewRecommendations(result.newE2eRecommendations),
    noE2eReason: typeof result.noE2eReason === "string" || result.noE2eReason === null ? result.noE2eReason : null,
    confidence: ["low", "medium", "high"].includes(result.confidence) ? result.confidence : "medium",
  };

  const dispatchHint = sanitizeDispatchHint(result.dispatchHint);
  if (dispatchHint) {
    normalized.dispatchHint = dispatchHint;
  }

  return normalized;
}

function sanitizeDomains(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object")
    .map((item) => ({
      domain: stringOrUndefined(item.domain),
      reason: stringOrUndefined(item.reason),
      confidence: ["low", "medium", "high"].includes(item.confidence) ? item.confidence : "medium",
      matchedFiles: Array.isArray(item.matchedFiles) ? item.matchedFiles.filter((file) => typeof file === "string") : [],
    }))
    .filter((item) => item.domain && item.reason);
}

function sanitizeTests(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object")
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

function sanitizeNewRecommendations(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object")
    .map((item) => ({
      domain: stringOrUndefined(item.domain),
      reason: stringOrUndefined(item.reason),
      suggestedTest: stringOrUndefined(item.suggestedTest),
      priority: ["low", "medium", "high"].includes(item.priority) ? item.priority : "medium",
    }))
    .filter((item) => item.domain && item.reason && item.suggestedTest);
}

function sanitizeDispatchHint(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.workflow !== "string" || typeof value.jobsInput !== "string") return undefined;
  return { workflow: value.workflow, jobsInput: value.jobsInput };
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dropUndefinedValues(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function renderSummary(result) {
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
    "AWS_BEARER_TOKEN_BEDROCK",
  ];
  return Boolean(process.env.PI_E2E_ADVISOR_API_KEY) || credentialEnv.some((name) => Boolean(process.env[name])) || Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function preparePiConfig(env, provider, model) {
  if (!env.PI_E2E_ADVISOR_API_KEY) {
    return;
  }
  const envName = providerEnvName(provider || "anthropic");
  if (envName && !env[envName]) {
    env[envName] = env.PI_E2E_ADVISOR_API_KEY;
  }

  const templatePath = path.isAbsolute(modelsTemplatePath) ? modelsTemplatePath : path.resolve(advisorRoot, modelsTemplatePath);
  if (!fs.existsSync(templatePath)) {
    return;
  }

  fs.mkdirSync(piConfigDir, { recursive: true });
  fs.writeFileSync(path.join(piConfigDir, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(piConfigDir, "settings.json"), `${JSON.stringify({
    defaultProvider: provider || "anthropic",
    defaultModel: model || defaultModelForProvider(provider),
    defaultThinkingLevel: "medium",
  }, null, 2)}\n`);
  const models = fs.readFileSync(templatePath, "utf8").replaceAll("__PI_E2E_ADVISOR_API_KEY__", env.PI_E2E_ADVISOR_API_KEY);
  fs.writeFileSync(path.join(piConfigDir, "models.json"), models, { mode: 0o600 });
  env.PI_CODING_AGENT_DIR = piConfigDir;
}

function providerEnvName(provider) {
  const normalized = provider.toLowerCase();
  if (normalized.includes("anthropic")) return "ANTHROPIC_API_KEY";
  if (normalized.includes("openai")) return "OPENAI_API_KEY";
  if (normalized.includes("azure")) return "AZURE_OPENAI_API_KEY";
  if (normalized.includes("google") || normalized.includes("gemini")) return "GEMINI_API_KEY";
  return "OPENAI_API_KEY";
}

function defaultModelForProvider(provider) {
  const normalized = (provider || "").toLowerCase();
  if (normalized.includes("anthropic")) return "aws/anthropic/bedrock-claude-opus-4-7";
  if (normalized.includes("openai")) return "openai/openai/gpt-5.5";
  return "";
}

function writeFailure(reason) {
  const failureResult = unavailableResult(reason, true);
  fs.writeFileSync(piResultPath, `${JSON.stringify({ failed: true, reason, promptPath, rawPath }, null, 2)}\n`);
  fs.writeFileSync(finalResultPath, `${JSON.stringify(failureResult, null, 2)}\n`);
  fs.writeFileSync(piSummaryPath, `# Pi Semantic E2E Advisor\n\nFailed: ${reason}\n`);
  console.error(`Pi semantic analysis failed: ${reason}`);
}

function writeUnavailable(reason) {
  const result = unavailableResult(reason, false);
  fs.writeFileSync(piResultPath, `${JSON.stringify({ skipped: true, reason, promptPath }, null, 2)}\n`);
  fs.writeFileSync(finalResultPath, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(piSummaryPath, `# Pi Semantic E2E Advisor\n\nSkipped: ${reason}\n`);
}

function unavailableResult(reason, failed) {
  return {
    version: 1,
    baseRef,
    headRef,
    changedFiles,
    classifiedDomains: [],
    requiredTests: [],
    optionalTests: [],
    newE2eRecommendations: failed ? [{
      domain: "e2e-advisor",
      reason: `Pi semantic review failed: ${reason}`,
      suggestedTest: "Re-run E2E Advisor after fixing Pi execution.",
      priority: "high",
    }] : [],
    noE2eReason: failed ? null : `Pi semantic review unavailable: ${reason}`,
    confidence: "low",
  };
}
