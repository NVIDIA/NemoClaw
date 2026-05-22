// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-tool-catalog.js",
);
const { MARKER } = require(PATCH_SCRIPT) as { MARKER: string };

function writePackageJson(root: string, version = "2026.4.24") {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }, null, 2));
}

function realToolFixtureSource(allCustomToolsLine: string) {
  const longDescription =
    "Run a shell command in the sandbox workspace. ".repeat(60) +
    "Use this only when the user asks for command execution.";
  const nestedDescription = "Nested schema metadata that should not be returned by tool_describe. ".repeat(
    30,
  );

  return [
    "const realCalls = [];",
    "function collectAllowedToolNames(params) {",
    "\tconst names = new Set();",
    "\tfor (const tool of params.tools) names.add(tool.name);",
    "\tfor (const tool of params.clientTools ?? []) names.add(tool.function.name);",
    "\treturn names;",
    "}",
    "function collectRegisteredToolNames(tools) { return new Set(tools.map((tool) => tool.name)); }",
    "function toSessionToolAllowlist(names) { return [...names].sort((a, b) => a.localeCompare(b)); }",
    "function splitSdkTools(params) { return { customTools: params.tools }; }",
    "function toClientToolDefinitions() { return []; }",
    "function buildEmbeddedSystemPrompt(params) { return `tools=${params.tools.map((tool) => tool.name).join(',')}`; }",
    "function buildModelAliasLines() { return []; }",
    "function toProviderTool(tool) {",
    "\treturn { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };",
    "}",
    "export function getRealCalls() { return realCalls; }",
    "export async function runFakeAgentTurn(env = {}) {",
    "\tconst previousCatalog = process.env.NEMOCLAW_TOOL_CATALOG;",
    "\tif (Object.hasOwn(env, 'NEMOCLAW_TOOL_CATALOG')) process.env.NEMOCLAW_TOOL_CATALOG = env.NEMOCLAW_TOOL_CATALOG;",
    "\telse delete process.env.NEMOCLAW_TOOL_CATALOG;",
    "\ttry {",
    "\t\tconst params = { config: {} };",
    "\t\tconst sandboxInfo = {};",
    "\t\tconst modelAliasLines = [];",
    "\t\tconst clientTools = [];",
    "\t\tconst tools = [{",
    "\t\t\tname: 'exec',",
    "\t\t\tlabel: 'Execute command',",
    `\t\t\tdescription: ${JSON.stringify(longDescription)},`,
    "\t\t\tparameters: {",
    "\t\t\t\ttype: 'object',",
    "\t\t\t\ttitle: 'Exec root schema title',",
    "\t\t\t\tdescription: 'Root schema description metadata',",
    "\t\t\t\tproperties: {",
    "\t\t\t\t\tcommand: {",
    "\t\t\t\t\t\ttype: 'string',",
    "\t\t\t\t\t\ttitle: 'Command title',",
    `\t\t\t\t\t\tdescription: ${JSON.stringify(nestedDescription)}`,
    "\t\t\t\t\t}",
    "\t\t\t\t},",
    "\t\t\t\trequired: ['command']",
    "\t\t\t},",
    "\t\t\texecute: async (toolCallId, args) => {",
    "\t\t\t\trealCalls.push({ toolCallId, args });",
    "\t\t\t\treturn { content: [{ type: 'text', text: `ran:${args.command}` }], details: { status: 'ok', command: args.command } };",
    "\t\t\t}",
    "\t\t}, {",
    "\t\t\tname: 'read',",
    "\t\t\tlabel: 'Read file',",
    "\t\t\tdescription: 'Read a file from the workspace.',",
    "\t\t\tparameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to read.' } }, required: ['path'] },",
    "\t\t\texecute: async (_toolCallId, args) => ({ content: [{ type: 'text', text: `read:${args.path}` }] })",
    "\t\t}];",
    "\t\tconst filteredBundledTools = [];",
    "\t\tconst effectiveTools = [...tools, ...filteredBundledTools];",
    "\t\tconst allowedToolNames = collectAllowedToolNames({",
    "\t\t\ttools: effectiveTools,",
    "\t\t\tclientTools",
    "\t\t});",
    "\t\tconst prompt = buildEmbeddedSystemPrompt({",
    "\t\t\tsandboxInfo,",
    "\t\t\ttools: effectiveTools,",
    "\t\t\tmodelAliasLines: buildModelAliasLines(params.config),",
    "\t\t});",
    "\t\tconst { customTools } = splitSdkTools({",
    "\t\t\ttools: effectiveTools,",
    "\t\t\tsandboxEnabled: false",
    "\t\t});",
    "\t\tconst clientToolDefs = clientTools ? toClientToolDefinitions(clientTools, () => {}, {}) : [];",
    allCustomToolsLine,
    "\t\tconst sessionToolAllowlist = toSessionToolAllowlist(collectRegisteredToolNames(allCustomTools));",
    "\t\tconst request = {",
    "\t\t\tmodel: 'fake-model',",
    "\t\t\tmessages: [{ role: 'system', content: prompt }],",
    "\t\t\ttools: allCustomTools.map(toProviderTool)",
    "\t\t};",
    "\t\treturn { request, allCustomTools, sessionToolAllowlist, allowedToolNames: [...allowedToolNames].sort(), prompt };",
    "\t} finally {",
    "\t\tif (previousCatalog === undefined) delete process.env.NEMOCLAW_TOOL_CATALOG;",
    "\t\telse process.env.NEMOCLAW_TOOL_CATALOG = previousCatalog;",
    "\t}",
    "}",
    "",
  ].join("\n");
}

function makeFixture(opts: { version?: string; allCustomToolsLine?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tool-catalog-patch-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  writePackageJson(root, opts.version ?? "2026.4.24");
  fs.writeFileSync(path.join(dist, "selection-empty.js"), "export const noop = true;\n");
  const selectionPath = path.join(dist, "selection-fixture.js");
  fs.writeFileSync(
    selectionPath,
    realToolFixtureSource(
      opts.allCustomToolsLine ?? "\t\t\tconst allCustomTools = [...customTools, ...clientToolDefs];",
    ),
  );
  return { root, dist, selectionPath };
}

function runPatch(dist: string) {
  return spawnSync(process.execPath, [PATCH_SCRIPT, dist], {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

async function importSelection(selectionPath: string) {
  return await import(`${pathToFileURL(selectionPath).href}?v=${Date.now()}-${Math.random()}`);
}

function parseToolResult(result: any) {
  return JSON.parse(result.content[0].text);
}

describe("OpenClaw compact tool catalog patch", () => {
  it("patches compatible selection runtimes once and fails closed on shape drift", () => {
    const fixture = makeFixture();
    try {
      const first = runPatch(fixture.dist);
      expect(first.status, `${first.stdout}${first.stderr}`).toBe(0);
      expect(first.stdout).toContain("patched");
      const patched = fs.readFileSync(fixture.selectionPath, "utf-8");
      expect((patched.match(new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(1);
      expect(patched).not.toContain("const allCustomTools = [...customTools, ...clientToolDefs];");

      const second = runPatch(fixture.dist);
      expect(second.status, `${second.stdout}${second.stderr}`).toBe(0);
      expect(second.stdout).toContain("already-patched");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }

    const futureVersion = makeFixture({ version: "2026.5.1" });
    try {
      const result = runPatch(futureVersion.dist);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("openclaw 2026.5.1");
      expect(fs.readFileSync(futureVersion.selectionPath, "utf-8")).toContain(MARKER);
    } finally {
      fs.rmSync(futureVersion.root, { recursive: true, force: true });
    }

    const changed = makeFixture({
      allCustomToolsLine: "\t\t\tconst allCustomTools = customTools.concat(clientToolDefs);",
    });
    try {
      const result = runPatch(changed.dist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Expected exactly one selection-*.js target, found 0");
    } finally {
      fs.rmSync(changed.root, { recursive: true, force: true });
    }

    const builtInCatalog = makeFixture({
      allCustomToolsLine: [
        "\t\tconst toolSearch = applyToolSearchCatalog({",
        "\t\t\ttools: effectiveTools,",
        "\t\t});",
        "\t\tconst toolSearchRunPlan = buildToolSearchRunPlan({",
        "\t\t\tvisibleTools: effectiveTools,",
        "\t\t});",
      ].join("\n"),
    });
    try {
      const result = runPatch(builtInCatalog.dist);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("skipped-built-in");
      expect(fs.readFileSync(builtInCatalog.selectionPath, "utf-8")).not.toContain(MARKER);
    } finally {
      fs.rmSync(builtInCatalog.root, { recursive: true, force: true });
    }

    const partial = makeFixture({
      allCustomToolsLine: [
        MARKER,
        "\t\t\tconst nemoClawCatalogSourceTools = [...customTools, ...clientToolDefs];",
        "\t\t\tconst allCustomTools = nemoClawCreateToolCatalog(nemoClawCatalogSourceTools);",
      ].join("\n"),
    });
    try {
      const result = runPatch(partial.dist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "compact catalog marker is present but original targets remain",
      );
    } finally {
      fs.rmSync(partial.root, { recursive: true, force: true });
    }
  });

  it("captures only catalog controls in the fake provider request and preserves rollback", async () => {
    const fixture = makeFixture();
    try {
      expect(runPatch(fixture.dist).status).toBe(0);
      const mod = await importSelection(fixture.selectionPath);

      const compact = await mod.runFakeAgentTurn();
      const compactToolNames = compact.request.tools.map((tool: any) => tool.function.name);
      expect(compactToolNames).toEqual(["tool_search", "tool_describe", "tool_call"]);
      expect(compact.request.messages[0].content).toBe("tools=tool_search,tool_describe,tool_call");
      expect(JSON.stringify(compact.request)).not.toContain("Exec root schema title");
      expect(JSON.stringify(compact.request)).not.toContain("read");
      expect(compact.sessionToolAllowlist).toEqual(["tool_call", "tool_describe", "tool_search"]);
      expect(compact.allowedToolNames).toEqual([
        "exec",
        "read",
        "tool_call",
        "tool_describe",
        "tool_search",
      ]);

      const rollback = await mod.runFakeAgentTurn({ NEMOCLAW_TOOL_CATALOG: "0" });
      const rollbackToolNames = rollback.request.tools.map((tool: any) => tool.function.name);
      expect(rollbackToolNames).toEqual(["exec", "read"]);
      expect(rollback.request.messages[0].content).toBe("tools=exec,read");

      const compactBytes = Buffer.byteLength(JSON.stringify(compact.request), "utf8");
      const rollbackBytes = Buffer.byteLength(JSON.stringify(rollback.request), "utf8");
      expect(compactBytes).toBeLessThan(rollbackBytes * 0.45);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("searches, describes compact schemas, and calls the real underlying tool", async () => {
    const fixture = makeFixture();
    try {
      expect(runPatch(fixture.dist).status).toBe(0);
      const mod = await importSelection(fixture.selectionPath);
      const turn = await mod.runFakeAgentTurn();

      const search = turn.allCustomTools.find((tool: any) => tool.name === "tool_search");
      const describe = turn.allCustomTools.find((tool: any) => tool.name === "tool_describe");
      const call = turn.allCustomTools.find((tool: any) => tool.name === "tool_call");

      const searchPayload = parseToolResult(await search.execute("call-search", { query: "shell" }));
      expect(searchPayload.matches.map((match: any) => match.name)).toEqual(["exec"]);

      const described = parseToolResult(await describe.execute("call-describe", { name: "exec" }));
      expect(described.name).toBe("exec");
      expect(described.description).toContain("Run a shell command");
      expect(described.parameters.required).toEqual(["command"]);
      expect(described.parameters.title).toBeUndefined();
      expect(described.parameters.properties.command.title).toBeUndefined();
      expect(described.parameters.properties.command.description).toBeUndefined();

      const result = await call.execute("call-exec", {
        name: "exec",
        arguments: { command: "pwd" },
      });
      expect(result.content[0].text).toBe("ran:pwd");
      expect(mod.getRealCalls()).toEqual([{ toolCallId: "call-exec", args: { command: "pwd" } }]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
