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
];
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

function fail(message) {
  throw new Error(`OpenClaw Tool Search runtime validation failed: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`could not read ${label} at ${filePath}: ${error.message}`);
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`could not parse ${label} at ${filePath}: ${error.message}`);
  }
  if (!isRecord(value)) fail(`${label} at ${filePath} must contain a JSON object`);
  return value;
}

function countFunctionDeclarations(source, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`, "g"))].length;
}

function readRuntimeCandidates(distDir) {
  let entries;
  try {
    entries = fs.readdirSync(distDir, { withFileTypes: true });
  } catch (error) {
    fail(`could not read OpenClaw dist directory ${distDir}: ${error.message}`);
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^pi-tools-.*\.js$/.test(entry.name)) continue;
    const filePath = path.join(distDir, entry.name);
    let source;
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      fail(`could not read compiled runtime candidate ${filePath}: ${error.message}`);
    }
    if (RUNTIME_FUNCTION_NAMES.every((name) => source.includes(`function ${name}`))) {
      candidates.push({ filePath, source });
    }
  }
  return candidates;
}

function locateRuntimeModule(distDir) {
  const candidates = readRuntimeCandidates(distDir);
  if (candidates.length !== 1) {
    fail(
      `expected exactly one pi-tools-*.js module containing ${RUNTIME_FUNCTION_NAMES.join(
        ", ",
      )}; found ${candidates.length}`,
    );
  }
  const candidate = candidates[0];
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

function parseRuntimeExportAliases(source, filePath) {
  const aliases = new Map();
  const exportBlocks = [...source.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*;?/g)];
  for (const block of exportBlocks) {
    for (const rawEntry of block[1].split(",")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const match = entry.match(
        /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/,
      );
      if (!match) continue;
      const localName = match[1];
      if (!RUNTIME_FUNCTION_NAMES.includes(localName)) continue;
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

async function importRuntimeFunctions(filePath, aliases) {
  const moduleUrl = pathToFileURL(filePath);
  moduleUrl.searchParams.set(
    "nemoclaw_tool_search_validator",
    `${process.pid}-${Date.now()}-${importSequence++}`,
  );

  let runtimeModule;
  try {
    runtimeModule = await import(moduleUrl.href);
  } catch (error) {
    fail(`could not import compiled runtime ${filePath}: ${error.message}`);
  }

  const functions = {};
  for (const functionName of RUNTIME_FUNCTION_NAMES) {
    const exportName = aliases.get(functionName);
    const value = runtimeModule[exportName];
    if (typeof value !== "function") {
      fail(`${filePath} export ${exportName} for ${functionName} is not a function`);
    }
    functions[functionName] = value;
  }
  return functions;
}

function assertExpectedVersion(distDir, expectedVersion) {
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

function readToolSearchConfig(config, expectedMode, configPath) {
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
  return toolSearch;
}

function assertResolvedConfig(resolveToolSearchConfig, config, expectedMode) {
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

function createProbeTool() {
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
    execute: async (_toolCallId, args) => ({
      content: [{ type: "text", text: `${PROBE_SENTINEL}:${args?.value ?? ""}` }],
      details: { sentinel: PROBE_SENTINEL, value: args?.value ?? null },
    }),
  };
}

function readToolResultPayload(result, toolName) {
  if (isRecord(result) && "details" in result && result.details !== undefined) {
    return result.details;
  }
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const textPart = content.find(
    (entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string",
  );
  if (!textPart) fail(`${toolName} returned no JSON text or details payload`);
  try {
    return JSON.parse(textPart.text);
  } catch (error) {
    fail(`${toolName} returned invalid JSON text: ${error.message}`);
  }
}

function assertExactToolNames(tools, expectedNames, label) {
  if (!Array.isArray(tools)) fail(`${label} must be an array`);
  const names = tools.map((tool) => (isRecord(tool) ? tool.name : undefined));
  if (names.some((name) => typeof name !== "string")) {
    fail(`${label} contains a tool without a string name`);
  }
  const sortedNames = [...names].sort();
  if (!isDeepStrictEqual(sortedNames, [...expectedNames].sort())) {
    fail(`${label} names must be ${expectedNames.join(", ")}; found ${sortedNames.join(", ")}`);
  }
  return names;
}

function toolByName(tools, name) {
  const matches = tools.filter((tool) => isRecord(tool) && tool.name === name);
  if (matches.length !== 1 || typeof matches[0].execute !== "function") {
    fail(`expected exactly one executable ${name} control; found ${matches.length}`);
  }
  return matches[0];
}

function createControls(createOpenClawCodingTools, config, catalogRef, runId) {
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
  if (!Array.isArray(controls)) fail("createOpenClawCodingTools did not return an array");
  const unexpected = controls.filter(
    (tool) => !isRecord(tool) || typeof tool.name !== "string" || !ALL_CONTROL_NAMES.has(tool.name),
  );
  if (unexpected.length > 0) {
    fail("control-only createOpenClawCodingTools call returned a non-Tool-Search tool");
  }
  return controls;
}

async function validateProgressiveRuntime(runtime, config) {
  const catalogRef = {};
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
  const visibleNames = assertExactToolNames(
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

  const search = toolByName(compacted.tools, "tool_search");
  const describe = toolByName(compacted.tools, "tool_describe");
  const call = toolByName(compacted.tools, "tool_call");
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
  return visibleNames;
}

async function validateDirectRuntime(runtime, config) {
  const catalogRef = {};
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
  const visibleNames = assertExactToolNames(
    direct.tools,
    [PROBE_NAME],
    "direct model-visible tools",
  );
  if (direct.compacted !== false || direct.catalogToolCount !== 0) {
    fail("direct mode unexpectedly compacted the hidden probe");
  }
  const proof = await direct.tools[0].execute("nemoclaw-validator-direct", { value: "direct" });
  if (!isRecord(proof) || !isRecord(proof.details) || proof.details.sentinel !== PROBE_SENTINEL) {
    fail("direct mode did not preserve executable direct tool exposure");
  }
  return visibleNames;
}

export async function validateOpenClawToolSearchRuntime({
  distDir,
  configPath,
  expectedMode,
  expectedVersion,
}) {
  if (expectedMode !== "progressive" && expectedMode !== "direct") {
    fail(`expected mode must be progressive or direct; found ${String(expectedMode)}`);
  }
  if (typeof expectedVersion !== "string" || expectedVersion.trim() === "") {
    fail("expected version must be a non-empty string");
  }
  const resolvedDist = path.resolve(distDir);
  const resolvedConfigPath = path.resolve(configPath);
  const version = assertExpectedVersion(resolvedDist, expectedVersion);
  const config = readJson(resolvedConfigPath, "generated OpenClaw config");
  readToolSearchConfig(config, expectedMode, resolvedConfigPath);
  const { filePath, source } = locateRuntimeModule(resolvedDist);
  const aliases = parseRuntimeExportAliases(source, filePath);
  const runtime = await importRuntimeFunctions(filePath, aliases);
  assertResolvedConfig(runtime.resolveToolSearchConfig, config, expectedMode);
  const visibleToolNames =
    expectedMode === "progressive"
      ? await validateProgressiveRuntime(runtime, config)
      : await validateDirectRuntime(runtime, config);
  return { version, expectedMode, runtimeModulePath: filePath, visibleToolNames };
}

function usage() {
  return "Usage: validate-openclaw-tool-search.mts <dist-dir> <config-path> <progressive|direct> <expected-version>";
}

async function main(argv) {
  if (argv.length !== 4) fail(usage());
  const [distDir, configPath, expectedMode, expectedVersion] = argv;
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
