#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "/* nemoclaw compact tool catalog (#2600) */";
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
  '\t\t\tconst nemoClawIsRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);',
  "\t\t\tconst nemoClawCompactSchema = (value, depth = 0) => {",
  "\t\t\t\tif (Array.isArray(value)) return value.map((entry) => nemoClawCompactSchema(entry, depth + 1));",
  "\t\t\t\tif (!nemoClawIsRecord(value)) return value;",
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
  "\t\t\t\tif (nemoClawIsRecord(value)) return value;",
  '\t\t\t\tif (typeof value === "string" && value.trim()) {',
  "\t\t\t\t\tconst parsed = JSON.parse(value);",
  "\t\t\t\t\tif (nemoClawIsRecord(parsed)) return parsed;",
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

function usage() {
  return "Usage: patch-openclaw-tool-catalog.js <openclaw-dist-dir>";
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function readOpenClawVersion(distDir) {
  const packageJsonPath = path.resolve(distDir, "..", "package.json");
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Could not read OpenClaw package metadata at ${packageJsonPath}: ${err.message}`,
    );
  }
  if (typeof payload.version !== "string") {
    throw new Error(`OpenClaw package metadata missing string version at ${packageJsonPath}`);
  }
  return payload.version;
}

function listSelectionFiles(distDir) {
  let entries;
  try {
    entries = fs.readdirSync(distDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Could not read OpenClaw dist directory ${distDir}: ${err.message}`);
  }
  return entries
    .filter((entry) => entry.isFile() && /^selection-.*\.js$/.test(entry.name))
    .map((entry) => path.join(distDir, entry.name))
    .sort();
}

function patchSelectionText(source, filePath) {
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

function patchOpenClawToolCatalog(distDir) {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);

  const selectionFiles = listSelectionFiles(resolvedDist);
  if (selectionFiles.length === 0) {
    throw new Error(`No selection-*.js files found in ${resolvedDist}`);
  }

  const targetFiles = selectionFiles.filter((file) => {
    const text = fs.readFileSync(file, "utf-8");
    return text.includes(ALL_CUSTOM_TOOLS_PATTERN) || text.includes(MARKER);
  });
  if (targetFiles.length !== 1) {
    throw new Error(`Expected exactly one selection-*.js target, found ${targetFiles.length}`);
  }

  const target = targetFiles[0];
  const source = fs.readFileSync(target, "utf-8");
  const { patched, text } = patchSelectionText(source, target);
  if (patched) {
    fs.writeFileSync(target, text);
    return { status: "patched", file: target, version };
  }
  return { status: "already-patched", file: target, version };
}

function main(argv) {
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

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  MARKER,
  patchOpenClawToolCatalog,
  patchSelectionText,
};
