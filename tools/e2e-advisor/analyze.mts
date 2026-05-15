#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = process.cwd();
const ADVISOR_PROVIDER = "openai";
const ADVISOR_MODEL = "openai/openai/gpt-5.5";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

type ParsedArgs = Record<string, string | undefined>;
type AdvisorProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1];
type RunAdvisorResult = {
  text: string;
  raw: string;
};

type ArtifactPaths = {
  prompt: string;
  raw: string;
  result: string;
  finalResult: string;
  summary: string;
  sessionHtml: string;
};

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

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ADVISOR_PROVIDER_CONFIG: AdvisorProviderConfig = {
  api: "openai-completions",
  baseUrl: "https://inference-api.nvidia.com/v1",
  models: [advisorModel("openai/openai/gpt-5.5", "GPT-5.5", 256000, 32768, true, ["text", "image"])],
  ["api" + "Key"]: "E2E_ADVISOR_API_KEY",
} as AdvisorProviderConfig;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

function advisorModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  reasoning: boolean,
  input: ("text" | "image")[],
): NonNullable<AdvisorProviderConfig["models"]>[number] {
  return { id, name, reasoning, input, cost: ZERO_COST, contextWindow, maxTokens };
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
    process.env.E2E_ADVISOR_CONFIG_DIR || path.join("/tmp", `nemoclaw-e2e-advisor-config-${process.pid}`);
  const timeoutMs = parsePositiveInt(process.env.E2E_ADVISOR_TIMEOUT_MS, 900000);
  const heartbeatMs = parsePositiveInt(process.env.E2E_ADVISOR_HEARTBEAT_MS, 60000);
  const maxCaptureBytes = parsePositiveInt(process.env.E2E_ADVISOR_MAX_CAPTURE_BYTES, 5 * 1024 * 1024);

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
  const writeFailure = (reason: string): void => writeUnavailableArtifacts(artifacts, metadata, reason, true);
  const writeUnavailable = (reason: string): void => writeUnavailableArtifacts(artifacts, metadata, reason, false);

  if (process.env.E2E_ADVISOR_RUN_ANALYSIS === "0") {
    writeUnavailable("E2E_ADVISOR_RUN_ANALYSIS=0");
    process.exit(0);
  }

  logProgress(`Launching advisor SDK: provider=${ADVISOR_PROVIDER} model=${ADVISOR_MODEL}`);
  logProgress("Advisor tools enabled: read,grep,find,ls; repository commands remain disabled by prompt policy");

  let sdkResult: RunAdvisorResult | undefined;
  try {
    sdkResult = await runAdvisor({
      cwd: root,
      prompt,
      systemPrompt,
      configDir,
      htmlExportPath: artifacts.sessionHtml,
      timeoutMs,
      heartbeatMs,
      maxCaptureBytes,
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
    result = normalizeAdvisorResult(extractJson(sdkResult.text || sdkResult.raw, artifacts.raw), metadata);
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
  return {
    prompt: path.join(outDir, "e2e-advisor-prompt.md"),
    raw: path.join(outDir, "e2e-advisor-raw-output.txt"),
    result: path.join(outDir, "e2e-advisor-result.json"),
    finalResult: path.join(outDir, "e2e-advisor-final-result.json"),
    summary: path.join(outDir, "e2e-advisor-summary.md"),
    sessionHtml: path.join(outDir, "e2e-advisor-session.html"),
  };
}

function writeUnavailableArtifacts(paths: ArtifactPaths, metadata: AdvisorMetadata, reason: string, failed: boolean): void {
  const result = unavailableResult(metadata, reason, failed);
  writeJson(paths.result, failed ? { failed: true, reason, promptPath: paths.prompt, rawPath: paths.raw } : { skipped: true, reason, promptPath: paths.prompt });
  writeJson(paths.finalResult, result);
  fs.writeFileSync(paths.summary, `# E2E Recommendation Advisor\n\n${failed ? "Failed" : "Skipped"}: ${reason}\n`);
  if (failed) {
    console.error(`Advisor analysis failed: ${reason}`);
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function logProgress(message: string): void {
  console.log(`[e2e-advisor] ${new Date().toISOString()} ${message}`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runAdvisor(options: {
  cwd: string;
  prompt: string;
  systemPrompt: string;
  configDir: string;
  htmlExportPath: string;
  timeoutMs: number;
  heartbeatMs: number;
  maxCaptureBytes: number;
}): Promise<RunAdvisorResult> {
  fs.mkdirSync(options.configDir, { recursive: true });
  const { authStorage, modelRegistry } = prepareAdvisorConfig();
  const model = modelRegistry.find(ADVISOR_PROVIDER, ADVISOR_MODEL);
  if (!model || !modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Could not configure advisor model ${ADVISOR_MODEL}`);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.configDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.configDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "medium",
    tools: READ_ONLY_TOOLS,
    resourceLoader,
    sessionManager: SessionManager.create(options.cwd, path.join(options.configDir, "sessions")),
    settingsManager,
  });

  const rawHeader = [
    modelFallbackMessage ? `[e2e-advisor] ${modelFallbackMessage}` : undefined,
    `[e2e-advisor] model=${model.provider}/${model.id}`,
    `[e2e-advisor] tools=${READ_ONLY_TOOLS.join(",")}`,
    "--- ASSISTANT TEXT ---",
  ].filter((line): line is string => Boolean(line));

  const text = new CappedBuffer(options.maxCaptureBytes);
  const raw = new CappedBuffer(options.maxCaptureBytes, `${rawHeader.join("\n")}\n`);

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text.append(event.assistantMessageEvent.delta);
      raw.append(event.assistantMessageEvent.delta);
      return;
    }
    if (event.type === "tool_execution_start") {
      raw.append(`\n[e2e-advisor] tool_start ${event.toolName}\n`);
      return;
    }
    if (event.type === "tool_execution_end") {
      raw.append(`[e2e-advisor] tool_end ${event.toolName} ${event.isError ? "error" : "ok"}\n`);
      return;
    }
    if (event.type === "auto_retry_start") {
      raw.append(`[e2e-advisor] retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}\n`);
    }
  });

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logProgress(`Advisor SDK still running: elapsed=${elapsedSeconds}s timeout=${Math.round(options.timeoutMs / 1000)}s`);
  }, Math.max(options.heartbeatMs, 1000));
  heartbeat.unref?.();

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      logProgress(`Advisor SDK exceeded timeoutMs=${options.timeoutMs}; aborting session`);
      void session.abort();
      reject(new Error(`timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    timeout.unref?.();
  });

  try {
    await Promise.race([session.prompt(options.prompt), timeoutPromise]);
  } finally {
    unsubscribe();
    clearInterval(heartbeat);
    if (timeout) {
      clearTimeout(timeout);
    }
    try {
      const exportedPath = await session.exportToHtml(options.htmlExportPath);
      raw.append(`\n[e2e-advisor] exported_session_html=${exportedPath}\n`);
      logProgress(`Exported advisor session HTML: ${exportedPath}`);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      raw.append(`\n[e2e-advisor] failed_to_export_session_html=${reason}\n`);
      logProgress(`Failed to export advisor session HTML: ${reason}`);
    }
    session.dispose();
  }

  const truncationNotes: string[] = [];
  if (text.droppedBytes > 0) {
    truncationNotes.push(`<assistant text truncated; dropped ${text.droppedBytes} byte(s)>`);
  }
  if (raw.droppedBytes > 0) {
    truncationNotes.push(`<raw output truncated; dropped ${raw.droppedBytes} byte(s)>`);
  }
  if (truncationNotes.length > 0) {
    raw.appendFooter(`\n${truncationNotes.join("\n")}\n`);
  }

  return {
    text: text.toString(),
    raw: raw.toStringWithTrailingNewline(),
  };
}

class CappedBuffer {
  private readonly maxBytes: number;
  private value: string;
  public droppedBytes = 0;

  constructor(maxBytes: number, initialValue = "") {
    this.maxBytes = maxBytes;
    this.value = initialValue;
    this.trimToMaxBytes();
  }

  append(chunk: string): void {
    this.value += chunk;
    this.trimToMaxBytes();
  }

  appendFooter(footer: string): void {
    const footerBytes = Buffer.byteLength(footer, "utf8");
    if (footerBytes >= this.maxBytes) {
      this.value = trimHeadToBytes(footer, this.maxBytes);
      return;
    }
    this.trimToMaxBytes(this.maxBytes - footerBytes);
    this.value += footer;
  }

  toString(): string {
    return this.value;
  }

  toStringWithTrailingNewline(): string {
    return this.value.endsWith("\n") ? this.value : `${this.value}\n`;
  }

  private trimToMaxBytes(maxBytes = this.maxBytes): void {
    if (Buffer.byteLength(this.value, "utf8") <= maxBytes) return;

    const trimmed = trimHeadToBytes(this.value, maxBytes);
    this.droppedBytes += Buffer.byteLength(this.value.slice(0, this.value.length - trimmed.length), "utf8");
    this.value = trimmed;
  }
}

function trimHeadToBytes(value: string, maxBytes: number): string {
  let removeChars = Math.min(value.length, Math.max(1, Buffer.byteLength(value, "utf8") - maxBytes));
  while (removeChars < value.length && Buffer.byteLength(value.slice(removeChars), "utf8") > maxBytes) {
    removeChars += 1;
  }
  return value.slice(removeChars);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
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

function readJson<T>(relativeOrAbsolutePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(root, relativeOrAbsolutePath), "utf8")) as T;
}

function getChangedFiles(base: string, head: string): string[] {
  const stdout = gitOutput(
    [
      ["diff", "--name-only", `${base}...${head}`],
      ["diff", "--name-only", `${base}..${head}`],
    ],
    10 * 1024 * 1024,
  );
  if (stdout === undefined) {
    throw new Error(`failed to diff ${base}..${head}; ensure both refs are fetched`);
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function getDiff(base: string, head: string, maxChars: number): string {
  const stdout = gitOutput(
    [
      ["diff", "--find-renames", "--find-copies", "--unified=80", `${base}...${head}`],
      ["diff", "--find-renames", "--find-copies", "--unified=80", `${base}..${head}`],
    ],
    20 * 1024 * 1024,
  );
  return stdout === undefined ? "" : truncate(stdout, maxChars);
}

function gitOutput(commands: string[][], maxBuffer: number): string | undefined {
  for (const command of commands) {
    try {
      return execFileSync("git", command, { encoding: "utf8", maxBuffer });
    } catch {
      // Try next diff form. Some checkouts do not have a merge base locally.
    }
  }
  return undefined;
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

function extractJson(text: string, rawPath: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, fenced(trimmed), tagged(trimmed, "e2e_advisor_json"), balancedObject(trimmed)].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate.
    }
  }
  throw new Error(`Could not parse JSON from advisor output; see ${rawPath}`);
}

function fenced(text: string): string | undefined {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim();
}

function tagged(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
  return match?.[1]?.trim();
}

function balancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
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
    noE2eReason: typeof object.noE2eReason === "string" || object.noE2eReason === null ? object.noE2eReason : null,
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
      matchedFiles: Array.isArray(item.matchedFiles) ? item.matchedFiles.filter((file): file is string => typeof file === "string") : [],
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

function recordItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dropUndefinedValues<T extends Record<string, unknown>>(object: T): T {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;
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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n<diff truncated at ${maxChars} characters>`;
}

function prepareAdvisorConfig(): { authStorage: AuthStorage; modelRegistry: ModelRegistry } {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const apiKey = process.env.E2E_ADVISOR_API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) {
    authStorage.setRuntimeApiKey(ADVISOR_PROVIDER, apiKey);
    modelRegistry.registerProvider(ADVISOR_PROVIDER, ADVISOR_PROVIDER_CONFIG);
  }
  return { authStorage, modelRegistry };
}

function unavailableResult(metadata: AdvisorMetadata, reason: string, failed: boolean): AdvisorResult {
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
