#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const MARKER = "/* nemoclaw compact tool catalog (#2600) */";
export const NATIVE_LLAMACPP_MARKER =
  "/* nemoclaw llama.cpp compact native tool catalog (#11105) */";
export const NATIVE_LLAMACPP_TOOL_CALL_MARKER =
  "/* nemoclaw llama.cpp JSON-string tool-call input (#11105) */";
const ALL_CUSTOM_TOOLS_PATTERN =
  "\t\t\tconst allCustomTools = [...customTools, ...clientToolDefs];";
const EFFECTIVE_TOOLS_PATTERN = "\t\tconst effectiveTools = [...tools, ...filteredBundledTools];";
const ALLOWED_TOOL_NAMES_PATTERN = [
  "\t\tconst allowedToolNames = collectAllowedToolNames({",
  "\t\t\ttools: effectiveTools,",
  "\t\t\tclientTools",
  "\t\t});",
].join("\n");
const SYSTEM_PROMPT_TOOLS_PATTERN = [
  "\t\t\tsandboxInfo,",
  "\t\t\ttools: effectiveTools,",
  "\t\t\tmodelAliasLines: buildModelAliasLines(params.config),",
].join("\n");
const ALREADY_PATCHED_FORBIDDEN_PATTERNS = [SYSTEM_PROMPT_TOOLS_PATTERN, ALL_CUSTOM_TOOLS_PATTERN];
const ALREADY_PATCHED_REQUIRED_PATTERNS = [
  "\t\tconst nemoClawToolCatalogControls = [",
  "\t\tconst nemoClawPromptVisibleTools = nemoClawToolCatalogEnabled ? nemoClawToolCatalogControls : effectiveTools;",
  "\t\tif (nemoClawToolCatalogEnabled) {",
  "\t\t\ttools: nemoClawPromptVisibleTools,",
  "\t\t\tconst nemoClawCatalogSourceTools = [...customTools, ...clientToolDefs];",
  "\t\t\tconst allCustomTools = nemoClawCreateToolCatalog(nemoClawCatalogSourceTools);",
];
const NATIVE_TOOL_SEARCH_PATTERN_SETS = [
  [
    "const uncompactedEffectiveTools = [...tools, ...filteredBundledTools];",
    "applyToolSearchCatalog({",
    "buildToolSearchRunPlan({",
    "const allowedToolNames = toolSearchRunPlan.visibleAllowedToolNames;",
    "const replayAllowedToolNames = toolSearchRunPlan.replayAllowedToolNames;",
  ],
  [
    "function buildToolSearchRunPlan(params) {",
    "const { clientTools, uncompactedEffectiveTools } = input.bundleTools;",
    "const toolSearch = applyAgentToolSurfaceCatalog({",
    "const toolSearchRunPlan = buildToolSearchRunPlan({",
    "replayAllowedToolNames: toolSearchRunPlan.replayAllowedToolNames",
  ],
] as const;
const CURRENT_NATIVE_TOOL_SEARCH_PATTERNS = NATIVE_TOOL_SEARCH_PATTERN_SETS[1];
const NATIVE_DIRECT_TOOL_PATTERN = [
  "function isDirectVisibleCatalogTool(tool, directToolNames) {",
  "\tconst classified = classifyTool(tool);",
  '\treturn classified.source === "openclaw" && (directToolNames.has(tool.name) || isCoreCodingSurfaceToolName(tool.name) && classified.sourceName === "core");',
  "}",
].join("\n");
const NATIVE_DIRECT_TOOL_REPLACEMENT = [
  NATIVE_LLAMACPP_MARKER,
  "function isDirectVisibleCatalogTool(tool, directToolNames) {",
  "\tconst classified = classifyTool(tool);",
  '\tconst hideCoreCodingSurface = (process.env.NEMOCLAW_UPSTREAM_PROVIDER ?? "").trim() === "llama-cpp-local";',
  '\treturn classified.source === "openclaw" && (directToolNames.has(tool.name) || !hideCoreCodingSurface && isCoreCodingSurfaceToolName(tool.name) && classified.sourceName === "core");',
  "}",
].join("\n");
const NATIVE_TOOL_CALL_SCHEMA_PATTERN =
  '\t\t\t\targs: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool input." }))';
const NATIVE_TOOL_CALL_SCHEMA_REPLACEMENT = [
  `\t\t\t\t${NATIVE_LLAMACPP_TOOL_CALL_MARKER}`,
  '\t\t\t\targs: Type.Optional((process.env.NEMOCLAW_UPSTREAM_PROVIDER ?? "").trim() === "llama-cpp-local" ? Type.String({ description: "JSON-encoded tool input object." }) : Type.Record(Type.String(), Type.Unknown(), { description: "Tool input." }))',
].join("\n");
const NATIVE_TOOL_CALL_INPUT_PATTERN = [
  "\tconst nestedInput = params.args ?? params.input;",
  "\tif (nestedInput != null) return {",
  "\t\tid: readToolSearchId(params),",
  "\t\tinput: isRecord(nestedInput) ? {",
  "\t\t\t...dottedInput,",
  "\t\t\t...nestedInput",
  "\t\t} : nestedInput",
  "\t};",
].join("\n");
const NATIVE_TOOL_CALL_INPUT_REPLACEMENT = [
  "\tlet nestedInput = params.args ?? params.input;",
  '\tif (typeof nestedInput === "string" && (process.env.NEMOCLAW_UPSTREAM_PROVIDER ?? "").trim() === "llama-cpp-local") {',
  "\t\ttry {",
  "\t\t\tconst parsed = JSON.parse(nestedInput);",
  '\t\t\tif (!isRecord(parsed)) throw new Error("not an object");',
  "\t\t\tnestedInput = parsed;",
  "\t\t} catch {",
  '\t\t\tthrow new ToolInputError("args must be a JSON-encoded object.");',
  "\t\t}",
  "\t}",
  "\tif (nestedInput != null) return {",
  "\t\tid: readToolSearchId(params),",
  "\t\tinput: isRecord(nestedInput) ? {",
  "\t\t\t...dottedInput,",
  "\t\t\t...nestedInput",
  "\t\t} : nestedInput",
  "\t};",
].join("\n");
const NATIVE_TOOL_INPUT_ERROR_BINDING_PATTERNS = [
  /class\s+ToolInputError\s+extends\s+Error\b/u,
  /import\s*\{[^}]*\b(?:ToolInputError|\w+\s+as\s+ToolInputError)\b[^}]*\}\s*from\s*["'][^"']*tool-input-error[^"']*["']/su,
];

const EFFECTIVE_TOOLS_REPLACEMENT = [
  EFFECTIVE_TOOLS_PATTERN,
  "\t\tconst nemoClawToolCatalogControls = [",
  '\t\t\t{ name: "tool_search" },',
  '\t\t\t{ name: "tool_describe" },',
  '\t\t\t{ name: "tool_call" }',
  "\t\t];",
  '\t\tconst nemoClawToolCatalogEnabled = process.env.NEMOCLAW_TOOL_CATALOG !== "0" && (effectiveTools.length > 0 || (clientTools?.length ?? 0) > 0);',
  "\t\tconst nemoClawPromptVisibleTools = nemoClawToolCatalogEnabled ? nemoClawToolCatalogControls : effectiveTools;",
].join("\n");

const ALLOWED_TOOL_NAMES_REPLACEMENT = [
  ALLOWED_TOOL_NAMES_PATTERN,
  "\t\tif (nemoClawToolCatalogEnabled) {",
  "\t\t\tfor (const tool of nemoClawToolCatalogControls) allowedToolNames.add(tool.name);",
  "\t\t}",
].join("\n");

const SYSTEM_PROMPT_TOOLS_REPLACEMENT = [
  "\t\t\tsandboxInfo,",
  "\t\t\ttools: nemoClawPromptVisibleTools,",
  "\t\t\tmodelAliasLines: buildModelAliasLines(params.config),",
].join("\n");

const CATALOG_HELPER_AND_ASSIGNMENT = [
  "\t\t\tconst nemoClawBuildToolResult = (payload) => ({",
  '\t\t\t\tcontent: [{ type: "text", text: JSON.stringify(payload, null, 2) }],',
  "\t\t\t\tdetails: payload",
  "\t\t\t});",
  '\t\t\tconst nemoClawIsObjectRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);',
  "\t\t\tconst nemoClawCompactSchema = (value, depth = 0) => {",
  "\t\t\t\tif (Array.isArray(value)) return value.map((entry) => nemoClawCompactSchema(entry, depth + 1));",
  "\t\t\t\tif (!nemoClawIsObjectRecord(value)) return value;",
  "\t\t\t\tconst out = {};",
  "\t\t\t\tfor (const [key, entry] of Object.entries(value)) {",
  '\t\t\t\t\tif (key === "title") continue;',
  '\t\t\t\t\tif (depth > 0 && key === "description") continue;',
  "\t\t\t\t\tout[key] = nemoClawCompactSchema(entry, depth + 1);",
  "\t\t\t\t}",
  "\t\t\t\treturn out;",
  "\t\t\t};",
  "\t\t\tconst nemoClawToolSummary = (tool) => {",
  '\t\t\t\tconst description = typeof tool.description === "string" ? tool.description.replace(/\\s+/g, " ").trim() : "";',
  "\t\t\t\treturn {",
  "\t\t\t\t\tname: tool.name,",
  '\t\t\t\t\tlabel: typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : tool.name,',
  "\t\t\t\t\tdescription: description.length > 240 ? `${description.slice(0, 237)}...` : description",
  "\t\t\t\t};",
  "\t\t\t};",
  "\t\t\tconst nemoClawCoerceToolArgs = (value) => {",
  "\t\t\t\tif (value === void 0 || value === null) return {};",
  "\t\t\t\tif (nemoClawIsObjectRecord(value)) return value;",
  '\t\t\t\tif (typeof value === "string" && value.trim()) {',
  "\t\t\t\t\tconst parsed = JSON.parse(value);",
  "\t\t\t\t\tif (nemoClawIsObjectRecord(parsed)) return parsed;",
  "\t\t\t\t}",
  '\t\t\t\tthrow new Error("tool_call.arguments must be an object or JSON object string");',
  "\t\t\t};",
  "\t\t\tconst nemoClawCreateToolCatalog = (realTools) => {",
  "\t\t\t\tif (!nemoClawToolCatalogEnabled || realTools.length === 0) return realTools;",
  "\t\t\t\tconst catalog = new Map();",
  "\t\t\t\tfor (const tool of realTools) {",
  '\t\t\t\t\tconst name = typeof tool.name === "string" ? tool.name.trim() : "";',
  "\t\t\t\t\tif (name && !catalog.has(name)) catalog.set(name, tool);",
  "\t\t\t\t}",
  "\t\t\t\tconst entries = [...catalog.values()].map(nemoClawToolSummary).toSorted((left, right) => left.name.localeCompare(right.name));",
  "\t\t\t\tconst searchTool = {",
  '\t\t\t\t\tname: "tool_search",',
  '\t\t\t\t\tlabel: "Tool search",',
  '\t\t\t\t\tdescription: "Search the available tool catalog by name, label, or description before describing or calling a tool.",',
  "\t\t\t\t\tparameters: {",
  '\t\t\t\t\t\ttype: "object",',
  "\t\t\t\t\t\tproperties: {",
  '\t\t\t\t\t\t\tquery: { type: "string", description: "Search terms. Use an empty string to list the first tools." },',
  '\t\t\t\t\t\t\tlimit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum matches to return." }',
  "\t\t\t\t\t\t},",
  '\t\t\t\t\t\trequired: ["query"]',
  "\t\t\t\t\t},",
  "\t\t\t\t\texecute: async (_toolCallId, params) => {",
  '\t\t\t\t\t\tconst query = typeof params?.query === "string" ? params.query.trim().toLowerCase() : "";',
  "\t\t\t\t\t\tconst terms = query.split(/\\s+/).filter(Boolean);",
  "\t\t\t\t\t\tconst requestedLimit = Number(params?.limit ?? 8);",
  "\t\t\t\t\t\tconst limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(20, Math.trunc(requestedLimit))) : 8;",
  "\t\t\t\t\t\tconst matches = entries.filter((entry) => {",
  "\t\t\t\t\t\t\tif (terms.length === 0) return true;",
  "\t\t\t\t\t\t\tconst haystack = `${entry.name} ${entry.label} ${entry.description}`.toLowerCase();",
  "\t\t\t\t\t\t\treturn terms.every((term) => haystack.includes(term));",
  "\t\t\t\t\t\t}).slice(0, limit);",
  "\t\t\t\t\t\treturn nemoClawBuildToolResult({ query, count: matches.length, matches });",
  "\t\t\t\t\t}",
  "\t\t\t\t};",
  "\t\t\t\tconst describeTool = {",
  '\t\t\t\t\tname: "tool_describe",',
  '\t\t\t\t\tlabel: "Tool describe",',
  '\t\t\t\t\tdescription: "Return one catalog tool\'s compact JSON schema before calling it.",',
  "\t\t\t\t\tparameters: {",
  '\t\t\t\t\t\ttype: "object",',
  '\t\t\t\t\t\tproperties: { name: { type: "string", description: "Exact tool name from tool_search." } },',
  '\t\t\t\t\t\trequired: ["name"]',
  "\t\t\t\t\t},",
  "\t\t\t\t\texecute: async (_toolCallId, params) => {",
  '\t\t\t\t\t\tconst name = typeof params?.name === "string" ? params.name.trim() : "";',
  "\t\t\t\t\t\tconst tool = catalog.get(name);",
  '\t\t\t\t\t\tif (!tool) return nemoClawBuildToolResult({ status: "error", tool: "tool_describe", error: `Unknown tool: ${name || "<empty>"}` });',
  '\t\t\t\t\t\treturn nemoClawBuildToolResult({ ...nemoClawToolSummary(tool), parameters: nemoClawCompactSchema(tool.parameters ?? { type: "object", properties: {} }) });',
  "\t\t\t\t\t}",
  "\t\t\t\t};",
  "\t\t\t\tconst callTool = {",
  '\t\t\t\t\tname: "tool_call",',
  '\t\t\t\t\tlabel: "Tool call",',
  '\t\t\t\t\tdescription: "Invoke a real catalog tool by exact name with arguments matching tool_describe.",',
  "\t\t\t\t\tparameters: {",
  '\t\t\t\t\t\ttype: "object",',
  "\t\t\t\t\t\tproperties: {",
  '\t\t\t\t\t\t\tname: { type: "string", description: "Exact tool name from tool_search." },',
  '\t\t\t\t\t\t\targuments: { type: "object", additionalProperties: true, description: "Arguments for the selected tool." }',
  "\t\t\t\t\t\t},",
  '\t\t\t\t\t\trequired: ["name", "arguments"]',
  "\t\t\t\t\t},",
  "\t\t\t\t\texecute: async (toolCallId, params, signal, onUpdate) => {",
  '\t\t\t\t\t\tconst name = typeof params?.name === "string" ? params.name.trim() : "";',
  "\t\t\t\t\t\tconst tool = catalog.get(name);",
  '\t\t\t\t\t\tif (!tool || typeof tool.execute !== "function") return nemoClawBuildToolResult({ status: "error", tool: "tool_call", error: `Unknown tool: ${name || "<empty>"}` });',
  "\t\t\t\t\t\ttry {",
  "\t\t\t\t\t\t\tconst args = nemoClawCoerceToolArgs(params?.arguments ?? params?.args);",
  "\t\t\t\t\t\t\treturn await tool.execute(toolCallId, args, signal, onUpdate);",
  "\t\t\t\t\t\t} catch (err) {",
  '\t\t\t\t\t\t\tif (signal?.aborted || err?.name === "AbortError") throw err;',
  '\t\t\t\t\t\t\treturn nemoClawBuildToolResult({ status: "error", tool: name, error: err instanceof Error ? err.message : String(err) });',
  "\t\t\t\t\t\t}",
  "\t\t\t\t\t}",
  "\t\t\t\t};",
  "\t\t\t\treturn [searchTool, describeTool, callTool];",
  "\t\t\t};",
  "\t\t\tconst nemoClawCatalogSourceTools = [...customTools, ...clientToolDefs];",
  "\t\t\tconst allCustomTools = nemoClawCreateToolCatalog(nemoClawCatalogSourceTools);",
].join("\n");

type PatchStatus =
  | "patched"
  | "already-patched"
  | "native-tool-search"
  | "patched-native-llamacpp"
  | "native-llamacpp-compat"
  | "skipped-built-in";

type PatchSelectionResult = {
  patched: boolean;
  text: string;
  status?: PatchStatus;
  skippedBuiltIn?: boolean;
};

function usage(): string {
  return "Usage: patch-openclaw-tool-catalog.mts <openclaw-dist-dir>";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function readOpenClawVersion(distDir: string): string {
  const packageJsonPath = path.resolve(distDir, "..", "package.json");
  let payload: { version?: unknown };
  try {
    payload = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Could not read OpenClaw package metadata at ${packageJsonPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof payload.version !== "string") {
    throw new Error(`OpenClaw package metadata missing string version at ${packageJsonPath}`);
  }
  return payload.version;
}

function listToolCatalogFiles(distDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(distDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Could not read OpenClaw dist directory ${distDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return entries
    .filter((entry) => entry.isFile() && /^(?:builtin-openclaw|selection)-.*\.js$/.test(entry.name))
    .map((entry) => path.join(distDir, entry.name))
    .sort();
}

function hasBuiltInToolCatalog(source: string): boolean {
  return source.includes("applyToolSearchCatalog({") && source.includes("buildToolSearchRunPlan({");
}

function hasNativeToolSearch(source: string): boolean {
  return NATIVE_TOOL_SEARCH_PATTERN_SETS.some((patterns) =>
    patterns.every((pattern) => source.includes(pattern)),
  );
}

function hasCurrentNativeToolSearch(source: string): boolean {
  return CURRENT_NATIVE_TOOL_SEARCH_PATTERNS.every((pattern) => source.includes(pattern));
}

function patchNativeLlamacppCatalogCompat(distDir: string): {
  patched: boolean;
  file: string;
} {
  const candidates = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^local-model-lean-.*\.js$/.test(entry.name))
    .map((entry) => path.join(distDir, entry.name))
    .filter((file) => {
      const source = fs.readFileSync(file, "utf-8");
      return source.includes(NATIVE_DIRECT_TOOL_PATTERN) || source.includes(NATIVE_LLAMACPP_MARKER);
    });
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one native llama.cpp tool-catalog compatibility target, found ${candidates.length}`,
    );
  }

  const target = candidates[0];
  const source = fs.readFileSync(target, "utf-8");
  if (!NATIVE_TOOL_INPUT_ERROR_BINDING_PATTERNS.some((pattern) => pattern.test(source))) {
    throw new Error(`${target}: native llama.cpp ToolInputError binding is missing`);
  }
  let text = source;
  let patched = false;
  if (text.includes(NATIVE_LLAMACPP_MARKER)) {
    if (text.includes(NATIVE_DIRECT_TOOL_PATTERN)) {
      throw new Error(`${target}: native llama.cpp marker is present but original target remains`);
    }
    if (!text.includes(NATIVE_DIRECT_TOOL_REPLACEMENT)) {
      throw new Error(`${target}: native llama.cpp compatibility patch shape is incomplete`);
    }
  } else {
    const count = countOccurrences(text, NATIVE_DIRECT_TOOL_PATTERN);
    if (count !== 1) {
      throw new Error(`${target}: expected exactly one native direct-tool target, found ${count}`);
    }
    text = text.replace(NATIVE_DIRECT_TOOL_PATTERN, NATIVE_DIRECT_TOOL_REPLACEMENT);
    patched = true;
  }

  if (text.includes(NATIVE_LLAMACPP_TOOL_CALL_MARKER)) {
    if (
      text.includes(NATIVE_TOOL_CALL_SCHEMA_PATTERN) ||
      text.includes(NATIVE_TOOL_CALL_INPUT_PATTERN)
    ) {
      throw new Error(
        `${target}: native llama.cpp tool-call marker is present but an original target remains`,
      );
    }
    if (
      !text.includes(NATIVE_TOOL_CALL_SCHEMA_REPLACEMENT) ||
      !text.includes(NATIVE_TOOL_CALL_INPUT_REPLACEMENT)
    ) {
      throw new Error(`${target}: native llama.cpp tool-call patch shape is incomplete`);
    }
  } else {
    const schemaCount = countOccurrences(text, NATIVE_TOOL_CALL_SCHEMA_PATTERN);
    const inputCount = countOccurrences(text, NATIVE_TOOL_CALL_INPUT_PATTERN);
    if (schemaCount !== 1 || inputCount !== 1) {
      throw new Error(
        `${target}: expected one native llama.cpp tool-call schema and input target, found ${schemaCount} and ${inputCount}`,
      );
    }
    text = text.replace(NATIVE_TOOL_CALL_SCHEMA_PATTERN, NATIVE_TOOL_CALL_SCHEMA_REPLACEMENT);
    text = text.replace(NATIVE_TOOL_CALL_INPUT_PATTERN, NATIVE_TOOL_CALL_INPUT_REPLACEMENT);
    patched = true;
  }

  if (
    !text.includes(NATIVE_LLAMACPP_MARKER) ||
    !text.includes(NATIVE_LLAMACPP_TOOL_CALL_MARKER) ||
    text.includes(NATIVE_DIRECT_TOOL_PATTERN) ||
    text.includes(NATIVE_TOOL_CALL_SCHEMA_PATTERN) ||
    text.includes(NATIVE_TOOL_CALL_INPUT_PATTERN)
  ) {
    throw new Error(`${target}: native llama.cpp compatibility patch verification failed`);
  }
  if (patched) fs.writeFileSync(target, text);
  return { patched, file: target };
}

export function patchSelectionText(source: string, filePath: string): PatchSelectionResult {
  if (source.includes(MARKER)) {
    if (ALREADY_PATCHED_FORBIDDEN_PATTERNS.some((pattern) => source.includes(pattern))) {
      throw new Error(`${filePath}: compact catalog marker is present but original targets remain`);
    }
    if (ALREADY_PATCHED_REQUIRED_PATTERNS.some((pattern) => !source.includes(pattern))) {
      throw new Error(
        `${filePath}: compact catalog marker is present but patch shape is incomplete`,
      );
    }
    return { patched: false, text: source };
  }

  if (hasNativeToolSearch(source)) {
    return { patched: false, text: source, status: "native-tool-search" };
  }

  if (hasBuiltInToolCatalog(source)) {
    return { patched: false, text: source, skippedBuiltIn: true };
  }

  const requiredPatterns = [
    EFFECTIVE_TOOLS_PATTERN,
    ALLOWED_TOOL_NAMES_PATTERN,
    SYSTEM_PROMPT_TOOLS_PATTERN,
    ALL_CUSTOM_TOOLS_PATTERN,
  ];
  for (const pattern of requiredPatterns) {
    const count = countOccurrences(source, pattern);
    if (count !== 1) {
      throw new Error(`${filePath}: expected exactly one target pattern, found ${count}`);
    }
  }

  let text = source.replace(EFFECTIVE_TOOLS_PATTERN, EFFECTIVE_TOOLS_REPLACEMENT);
  text = text.replace(ALLOWED_TOOL_NAMES_PATTERN, ALLOWED_TOOL_NAMES_REPLACEMENT);
  text = text.replace(SYSTEM_PROMPT_TOOLS_PATTERN, SYSTEM_PROMPT_TOOLS_REPLACEMENT);
  text = text.replace(ALL_CUSTOM_TOOLS_PATTERN, `${MARKER}\n${CATALOG_HELPER_AND_ASSIGNMENT}`);

  if (!text.includes(MARKER) || text.includes(ALL_CUSTOM_TOOLS_PATTERN)) {
    throw new Error(`${filePath}: patch verification failed`);
  }
  return { patched: true, text };
}

export function patchOpenClawToolCatalog(distDir: string): {
  status: PatchStatus;
  file: string;
  version: string;
} {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);

  const toolCatalogFiles = listToolCatalogFiles(resolvedDist);
  if (toolCatalogFiles.length === 0) {
    throw new Error(`No compiled tool-catalog candidates found in ${resolvedDist}`);
  }

  const targetFiles = toolCatalogFiles.filter((file) => {
    const text = fs.readFileSync(file, "utf-8");
    return (
      text.includes(ALL_CUSTOM_TOOLS_PATTERN) ||
      text.includes(MARKER) ||
      hasNativeToolSearch(text) ||
      hasBuiltInToolCatalog(text)
    );
  });
  if (targetFiles.length !== 1) {
    throw new Error(
      `Expected exactly one compiled tool-catalog target, found ${targetFiles.length}`,
    );
  }

  const target = targetFiles[0];
  const source = fs.readFileSync(target, "utf-8");
  const result = patchSelectionText(source, target);
  const { patched, text } = result;
  if (patched) {
    fs.writeFileSync(target, text);
    return { status: "patched", file: target, version };
  }
  if (result.skippedBuiltIn) {
    return { status: "skipped-built-in", file: target, version };
  }
  if (result.status === "native-tool-search" && hasCurrentNativeToolSearch(source)) {
    const compat = patchNativeLlamacppCatalogCompat(resolvedDist);
    return {
      status: compat.patched ? "patched-native-llamacpp" : "native-llamacpp-compat",
      file: compat.file,
      version,
    };
  }
  return { status: result.status ?? "already-patched", file: target, version };
}

function main(argv: readonly string[]): number {
  const distDir = argv[2];
  if (!distDir || argv.length > 3) {
    console.error(usage());
    return 2;
  }
  try {
    const result = patchOpenClawToolCatalog(distDir);
    console.log(
      `INFO: OpenClaw compact tool catalog ${result.status}: ${result.file} (openclaw ${result.version})`,
    );
    return 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main(process.argv);
}
