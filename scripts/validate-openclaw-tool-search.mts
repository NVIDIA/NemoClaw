#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const RUNTIME_FUNCTION_NAMES = [
  "resolveToolSearchConfig",
  "createOpenClawCodingTools",
  "applyToolSearchCatalog",
] as const;
const RUNTIME_MODULE_FILE_PATTERNS = new Map<string, RegExp>([
  ["2026.5.27", /^pi-tools-.*\.js$/],
  ["2026.6.10", /^agent-tools-.*\.js$/],
]);
type RuntimeFunctionName = (typeof RUNTIME_FUNCTION_NAMES)[number];
type ExpectedMode = "progressive" | "direct";
interface JsonRecord {
  [key: string]: unknown;
}

interface RuntimeCandidate {
  filePath: string;
  source: string;
}

interface CatalogRef {
  current?: unknown;
}

type ToolExecute = (
  toolCallId: string,
  args: JsonRecord,
  signal?: AbortSignal,
  onUpdate?: unknown,
) => unknown | Promise<unknown>;

interface Tool {
  name: string;
  label?: string;
  description?: string;
  parameters?: JsonRecord;
  execute: ToolExecute;
}

interface ToolResult extends JsonRecord {
  content?: unknown;
  details?: unknown;
}

interface RuntimeToolConstructionPlan {
  includeBaseCodingTools: false;
  includeShellTools: false;
  includeChannelTools: false;
  includeOpenClawTools: false;
  includePluginTools: false;
}

interface RuntimeToolOptions {
  config: JsonRecord;
  workspaceDir: string;
  includeCoreTools: false;
  includeToolSearchControls: true;
  toolSearchCatalogRef: CatalogRef;
  runId: string;
  sessionId: string;
  toolConstructionPlan: RuntimeToolConstructionPlan;
}

interface CatalogParams {
  config: JsonRecord;
  tools: Tool[];
  catalogRef: CatalogRef;
  runId: string;
  sessionId: string;
}

type ResolveToolSearchConfig = (config: JsonRecord) => unknown;
type CreateOpenClawCodingTools = (options: RuntimeToolOptions) => unknown;
type ApplyToolSearchCatalog = (params: CatalogParams) => unknown;

interface RuntimeFunctions {
  resolveToolSearchConfig: ResolveToolSearchConfig;
  createOpenClawCodingTools: CreateOpenClawCodingTools;
  applyToolSearchCatalog: ApplyToolSearchCatalog;
}

interface ValidationOptions {
  distDir: string;
  configPath: string;
  expectedMode: string;
  expectedVersion: string;
}

interface ValidationResult {
  version: string;
  expectedMode: ExpectedMode;
  runtimeModulePath: string;
  visibleToolNames: string[];
}
const STRUCTURED_TOOL_SEARCH = {
  mode: "tools",
  searchDefaultLimit: 8,
  maxSearchLimit: 20,
};
const STRUCTURED_CONTROL_NAMES = ["tool_call", "tool_describe", "tool_search"];
const ALL_CONTROL_NAMES = new Set([...STRUCTURED_CONTROL_NAMES, "tool_search_code"]);
const PROBE_NAME = "nemoclaw_runtime_validator_probe";
const PROBE_SENTINEL = "NEMOCLAW_OPENCLAW_TOOL_SEARCH_RUNTIME_OK";
let importSequence = 0;

function fail(message: string): never {
  throw new Error(`OpenClaw Tool Search runtime validation failed: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeFunctionName(value: string): value is RuntimeFunctionName {
  return (RUNTIME_FUNCTION_NAMES as readonly string[]).includes(value);
}

function readJson(filePath: string, label: string): JsonRecord {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`could not read ${label} at ${filePath}: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    fail(`could not parse ${label} at ${filePath}: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) fail(`${label} at ${filePath} must contain a JSON object`);
  return value;
}

function countFunctionDeclarations(source: string, functionName: RuntimeFunctionName): number {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`, "g"))].length;
}

function runtimeModuleFilePattern(expectedVersion: string): RegExp {
  const pattern = RUNTIME_MODULE_FILE_PATTERNS.get(expectedVersion);
  if (pattern === undefined) {
    fail(`no compiled runtime module layout is registered for OpenClaw ${expectedVersion}`);
  }
  return pattern;
}

function readRuntimeCandidates(distDir: string, expectedVersion: string): RuntimeCandidate[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(distDir, { withFileTypes: true });
  } catch (error) {
    fail(`could not read OpenClaw dist directory ${distDir}: ${errorMessage(error)}`);
  }

  const filePattern = runtimeModuleFilePattern(expectedVersion);
  const candidates: RuntimeCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !filePattern.test(entry.name)) continue;
    const filePath = path.join(distDir, entry.name);
    let source: string;
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      fail(`could not read compiled runtime candidate ${filePath}: ${errorMessage(error)}`);
    }
    if (RUNTIME_FUNCTION_NAMES.every((name) => source.includes(`function ${name}`))) {
      candidates.push({ filePath, source });
    }
  }
  return candidates;
}

function locateRuntimeModule(distDir: string, expectedVersion: string): RuntimeCandidate {
  const candidates = readRuntimeCandidates(distDir, expectedVersion);
  if (candidates.length !== 1) {
    fail(
      `expected exactly one registered OpenClaw ${expectedVersion} runtime module containing ${RUNTIME_FUNCTION_NAMES.join(
        ", ",
      )}; found ${candidates.length}`,
    );
  }
  const candidate = candidates[0];
  if (!candidate) fail("compiled runtime candidate disappeared after cardinality check");
  for (const functionName of RUNTIME_FUNCTION_NAMES) {
    const count = countFunctionDeclarations(candidate.source, functionName);
    if (count !== 1) {
      fail(
        `${candidate.filePath} must declare compiled function ${functionName} exactly once; found ${count}`,
      );
    }
  }
  return candidate;
}

function parseRuntimeExportAliases(
  source: string,
  filePath: string,
): Map<RuntimeFunctionName, string> {
  const aliases = new Map<RuntimeFunctionName, string>();
  const exportBlocks = [...source.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*;?/g)];
  for (const block of exportBlocks) {
    const blockBody = block[1];
    if (blockBody === undefined) continue;
    for (const rawEntry of blockBody.split(",")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const match = entry.match(
        /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/,
      );
      if (!match) continue;
      const localName = match[1];
      if (localName === undefined || !isRuntimeFunctionName(localName)) continue;
      if (aliases.has(localName)) {
        fail(`${filePath} exports compiled function ${localName} more than once`);
      }
      aliases.set(localName, match[2] ?? localName);
    }
  }

  for (const functionName of RUNTIME_FUNCTION_NAMES) {
    if (!aliases.has(functionName)) {
      fail(`${filePath} does not export compiled function ${functionName}`);
    }
  }
  if (new Set(aliases.values()).size !== RUNTIME_FUNCTION_NAMES.length) {
    fail(`${filePath} reuses an export alias across required compiled functions`);
  }
  return aliases;
}

function requiredAlias(
  aliases: ReadonlyMap<RuntimeFunctionName, string>,
  functionName: RuntimeFunctionName,
  filePath: string,
): string {
  const alias = aliases.get(functionName);
  if (alias === undefined) fail(`${filePath} does not export compiled function ${functionName}`);
  return alias;
}

async function importRuntimeFunctions(
  filePath: string,
  aliases: ReadonlyMap<RuntimeFunctionName, string>,
): Promise<RuntimeFunctions> {
  const moduleUrl = pathToFileURL(filePath);
  moduleUrl.searchParams.set(
    "nemoclaw_tool_search_validator",
    `${process.pid}-${Date.now()}-${importSequence++}`,
  );

  let runtimeModule: JsonRecord;
  try {
    const loaded: unknown = await import(moduleUrl.href);
    if (!isRecord(loaded)) fail(`compiled runtime ${filePath} did not export a module object`);
    runtimeModule = loaded;
  } catch (error) {
    fail(`could not import compiled runtime ${filePath}: ${errorMessage(error)}`);
  }

  const runtimeExports = new Map<RuntimeFunctionName, (...args: never[]) => unknown>();
  for (const functionName of RUNTIME_FUNCTION_NAMES) {
    const exportName = requiredAlias(aliases, functionName, filePath);
    const value = runtimeModule[exportName];
    if (typeof value !== "function") {
      fail(`${filePath} export ${exportName} for ${functionName} is not a function`);
    }
    runtimeExports.set(functionName, value as (...args: never[]) => unknown);
  }
  return {
    resolveToolSearchConfig: runtimeExports.get(
      "resolveToolSearchConfig",
    ) as ResolveToolSearchConfig,
    createOpenClawCodingTools: runtimeExports.get(
      "createOpenClawCodingTools",
    ) as CreateOpenClawCodingTools,
    applyToolSearchCatalog: runtimeExports.get("applyToolSearchCatalog") as ApplyToolSearchCatalog,
  };
}

function assertExpectedVersion(distDir: string, expectedVersion: string): string {
  const packagePath = path.resolve(distDir, "..", "package.json");
  const packageJson = readJson(packagePath, "OpenClaw package metadata");
  if (packageJson.version !== expectedVersion) {
    fail(
      `OpenClaw version mismatch at ${packagePath}: expected ${expectedVersion}, found ${String(
        packageJson.version,
      )}`,
    );
  }
  return packageJson.version;
}

function readToolSearchConfig(
  config: JsonRecord,
  expectedMode: ExpectedMode,
  configPath: string,
): void {
  const tools = config.tools;
  if (!isRecord(tools)) fail(`generated config ${configPath} is missing object tools`);
  const toolSearch = tools.toolSearch;
  if (expectedMode === "progressive") {
    if (!isDeepStrictEqual(toolSearch, STRUCTURED_TOOL_SEARCH)) {
      fail(
        `generated config ${configPath} must set tools.toolSearch to exactly ${JSON.stringify(
          STRUCTURED_TOOL_SEARCH,
        )} for progressive mode; found ${JSON.stringify(toolSearch)}`,
      );
    }
  } else if (toolSearch !== false) {
    fail(
      `generated config ${configPath} must set tools.toolSearch to false for direct mode; found ${JSON.stringify(
        toolSearch,
      )}`,
    );
  }
}

function assertResolvedConfig(
  resolveToolSearchConfig: ResolveToolSearchConfig,
  config: JsonRecord,
  expectedMode: ExpectedMode,
): void {
  const resolved = resolveToolSearchConfig(config);
  if (!isRecord(resolved)) fail("resolveToolSearchConfig did not return an object");
  if (expectedMode === "progressive") {
    const expected = {
      enabled: true,
      mode: "tools",
      searchDefaultLimit: 8,
      maxSearchLimit: 20,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (resolved[key] !== value) {
        fail(`resolved progressive Tool Search ${key} must be ${JSON.stringify(value)}`);
      }
    }
  } else if (resolved.enabled !== false) {
    fail("resolved direct Tool Search must be disabled");
  }
}

function createProbeTool(): Tool {
  return {
    name: PROBE_NAME,
    label: "NemoClaw runtime validator probe",
    description: "A deterministic hidden probe for the NemoClaw Tool Search runtime validator.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        value: { type: "string", description: "Deterministic proof input." },
      },
      required: ["value"],
    },
    execute: async (_toolCallId: string, args: JsonRecord) => ({
      content: [{ type: "text", text: `${PROBE_SENTINEL}:${args?.value ?? ""}` }],
      details: { sentinel: PROBE_SENTINEL, value: args?.value ?? null },
    }),
  };
}

function readToolResultPayload(result: unknown, toolName: string): unknown {
  if (!isRecord(result)) fail(`${toolName} returned a non-object result`);
  const toolResult: ToolResult = result;
  if (toolResult.details !== undefined) {
    return toolResult.details;
  }
  const content = Array.isArray(toolResult.content) ? toolResult.content : [];
  const textPart = content.find(
    (entry): entry is JsonRecord & { type: "text"; text: string } =>
      isRecord(entry) && entry.type === "text" && typeof entry.text === "string",
  );
  if (!textPart) fail(`${toolName} returned no JSON text or details payload`);
  try {
    return JSON.parse(textPart.text) as unknown;
  } catch (error) {
    fail(`${toolName} returned invalid JSON text: ${errorMessage(error)}`);
  }
}

function isTool(value: unknown): value is Tool {
  return isRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

function assertExactToolNames(
  tools: unknown,
  expectedNames: readonly string[],
  label: string,
): Tool[] {
  if (!Array.isArray(tools)) fail(`${label} must be an array`);
  if (!tools.every(isTool)) fail(`${label} contains a non-executable or unnamed tool`);
  const names = tools.map((tool) => tool.name);
  const sortedNames = [...names].sort();
  if (!isDeepStrictEqual(sortedNames, [...expectedNames].sort())) {
    fail(`${label} names must be ${expectedNames.join(", ")}; found ${sortedNames.join(", ")}`);
  }
  return tools;
}

function toolByName(tools: readonly Tool[], name: string): Tool {
  const matches = tools.filter((tool) => tool.name === name);
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    fail(`expected exactly one executable ${name} control; found ${matches.length}`);
  }
  return match;
}

function createControls(
  createOpenClawCodingTools: CreateOpenClawCodingTools,
  config: JsonRecord,
  catalogRef: CatalogRef,
  runId: string,
): Tool[] {
  const controls = createOpenClawCodingTools({
    config,
    workspaceDir: process.cwd(),
    includeCoreTools: false,
    includeToolSearchControls: true,
    toolSearchCatalogRef: catalogRef,
    runId,
    sessionId: runId,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: false,
    },
  });
  if (!Array.isArray(controls) || !controls.every(isTool)) {
    fail("createOpenClawCodingTools did not return executable named tools");
  }
  const unexpected = controls.filter((tool) => !ALL_CONTROL_NAMES.has(tool.name));
  if (unexpected.length > 0) {
    fail("control-only createOpenClawCodingTools call returned a non-Tool-Search tool");
  }
  return controls;
}

async function validateProgressiveRuntime(
  runtime: RuntimeFunctions,
  config: JsonRecord,
): Promise<string[]> {
  const catalogRef: CatalogRef = {};
  const runId = `nemoclaw-tool-search-validator-${process.pid}-${Date.now()}-${importSequence}`;
  const controls = createControls(runtime.createOpenClawCodingTools, config, catalogRef, runId);
  const probe = createProbeTool();
  const compacted = runtime.applyToolSearchCatalog({
    config,
    tools: [...controls, probe],
    catalogRef,
    runId,
    sessionId: runId,
  });
  if (!isRecord(compacted)) fail("applyToolSearchCatalog did not return an object");
  const visibleTools = assertExactToolNames(
    compacted.tools,
    STRUCTURED_CONTROL_NAMES,
    "progressive model-visible tools",
  );
  if (
    compacted.compacted !== true ||
    compacted.catalogToolCount !== 1 ||
    compacted.catalogRegistered !== true
  ) {
    fail("progressive catalog did not compact and register exactly one hidden probe");
  }

  const search = toolByName(visibleTools, "tool_search");
  const describe = toolByName(visibleTools, "tool_describe");
  const call = toolByName(visibleTools, "tool_call");
  const searchPayload = readToolResultPayload(
    await search.execute("nemoclaw-validator-search", { query: PROBE_NAME, limit: 8 }),
    "tool_search",
  );
  if (!Array.isArray(searchPayload)) fail("tool_search payload must be an array");
  const hit = searchPayload.find((entry) => isRecord(entry) && entry.name === PROBE_NAME);
  if (!hit || typeof hit.id !== "string") fail("tool_search did not discover the hidden probe");

  const described = readToolResultPayload(
    await describe.execute("nemoclaw-validator-describe", { id: hit.id }),
    "tool_describe",
  );
  if (!isRecord(described) || described.name !== PROBE_NAME) {
    fail("tool_describe did not return the hidden probe schema");
  }

  const callPayload = readToolResultPayload(
    await call.execute("nemoclaw-validator-call", {
      id: hit.id,
      args: { value: "progressive" },
    }),
    "tool_call",
  );
  if (
    !isRecord(callPayload) ||
    !isRecord(callPayload.tool) ||
    callPayload.tool.name !== PROBE_NAME ||
    !isRecord(callPayload.result) ||
    !isRecord(callPayload.result.details) ||
    callPayload.result.details.sentinel !== PROBE_SENTINEL ||
    callPayload.result.details.value !== "progressive"
  ) {
    fail("tool_call did not execute the hidden deterministic probe");
  }
  return visibleTools.map((tool) => tool.name);
}

async function validateDirectRuntime(
  runtime: RuntimeFunctions,
  config: JsonRecord,
): Promise<string[]> {
  const catalogRef: CatalogRef = {};
  const runId = `nemoclaw-tool-search-validator-direct-${process.pid}-${Date.now()}-${importSequence}`;
  const controls = createControls(runtime.createOpenClawCodingTools, config, catalogRef, runId);
  assertExactToolNames(controls, [], "direct Tool Search controls");
  const probe = createProbeTool();
  const direct = runtime.applyToolSearchCatalog({
    config,
    tools: [probe],
    catalogRef,
    runId,
    sessionId: runId,
  });
  if (!isRecord(direct)) fail("applyToolSearchCatalog did not return an object");
  const visibleTools = assertExactToolNames(
    direct.tools,
    [PROBE_NAME],
    "direct model-visible tools",
  );
  if (direct.compacted !== false || direct.catalogToolCount !== 0) {
    fail("direct mode unexpectedly compacted the hidden probe");
  }
  const directProbe = visibleTools[0];
  if (directProbe === undefined) fail("direct probe disappeared after cardinality check");
  const proof = await directProbe.execute("nemoclaw-validator-direct", { value: "direct" });
  if (!isRecord(proof) || !isRecord(proof.details) || proof.details.sentinel !== PROBE_SENTINEL) {
    fail("direct mode did not preserve executable direct tool exposure");
  }
  return visibleTools.map((tool) => tool.name);
}

export async function validateOpenClawToolSearchRuntime({
  distDir,
  configPath,
  expectedMode,
  expectedVersion,
}: ValidationOptions): Promise<ValidationResult> {
  if (expectedMode !== "progressive" && expectedMode !== "direct") {
    fail(`expected mode must be progressive or direct; found ${String(expectedMode)}`);
  }
  const validatedMode: ExpectedMode = expectedMode;
  if (typeof expectedVersion !== "string" || expectedVersion.trim() === "") {
    fail("expected version must be a non-empty string");
  }
  const resolvedDist = path.resolve(distDir);
  const resolvedConfigPath = path.resolve(configPath);
  const version = assertExpectedVersion(resolvedDist, expectedVersion);
  const config = readJson(resolvedConfigPath, "generated OpenClaw config");
  readToolSearchConfig(config, validatedMode, resolvedConfigPath);
  const { filePath, source } = locateRuntimeModule(resolvedDist, version);
  const aliases = parseRuntimeExportAliases(source, filePath);
  const runtime = await importRuntimeFunctions(filePath, aliases);
  assertResolvedConfig(runtime.resolveToolSearchConfig, config, validatedMode);
  const visibleToolNames =
    validatedMode === "progressive"
      ? await validateProgressiveRuntime(runtime, config)
      : await validateDirectRuntime(runtime, config);
  return { version, expectedMode: validatedMode, runtimeModulePath: filePath, visibleToolNames };
}

function usage(): string {
  return "Usage: validate-openclaw-tool-search.mts <dist-dir> <config-path> <progressive|direct> <expected-version>";
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length !== 4) fail(usage());
  const [distDir, configPath, expectedMode, expectedVersion] = argv;
  if (
    distDir === undefined ||
    configPath === undefined ||
    expectedMode === undefined ||
    expectedVersion === undefined
  ) {
    fail(usage());
  }
  const result = await validateOpenClawToolSearchRuntime({
    distDir,
    configPath,
    expectedMode,
    expectedVersion,
  });
  console.log(
    `Validated OpenClaw ${result.version} Tool Search ${result.expectedMode} runtime: ${result.visibleToolNames.join(
      ", ",
    )}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
