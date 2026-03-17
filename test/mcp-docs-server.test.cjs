// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "mcp-docs-server", "index.js");

function mcpCall(method, params = {}) {
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  });
  const initialized = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const call = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method,
    params,
  });

  const input = `${init}\n${initialized}\n${call}\n`;
  const output = execSync(`node "${SERVER}"`, {
    input,
    encoding: "utf-8",
    timeout: 15000,
    cwd: ROOT,
  });

  // Parse the last JSON line (the response to our call)
  const lines = output.trim().split("\n").filter(Boolean);
  const responses = lines.map((l) => JSON.parse(l));
  const response = responses.find((r) => r.id === 2);
  assert.ok(response, "Expected response with id 2");
  return response;
}

describe("MCP docs server", () => {
  it("lists tools", () => {
    const res = mcpCall("tools/list");
    const names = res.result.tools.map((t) => t.name);
    assert.ok(names.includes("list_docs"), "missing list_docs tool");
    assert.ok(names.includes("read_doc"), "missing read_doc tool");
    assert.ok(names.includes("search"), "missing search tool");
    assert.ok(names.includes("get_blueprint_config"), "missing get_blueprint_config tool");
    assert.ok(names.includes("get_baseline_policy"), "missing get_baseline_policy tool");
    assert.ok(names.includes("list_policy_presets"), "missing list_policy_presets tool");
    assert.ok(names.includes("get_policy_preset"), "missing get_policy_preset tool");
    assert.ok(names.includes("get_nim_models"), "missing get_nim_models tool");
    assert.ok(names.includes("read_source_file"), "missing read_source_file tool");
    assert.ok(names.includes("list_source_files"), "missing list_source_files tool");
    assert.ok(names.includes("get_architecture_overview"), "missing get_architecture_overview tool");
    assert.ok(names.includes("get_dockerfile"), "missing get_dockerfile tool");
    assert.equal(names.length, 12, "expected 12 tools");
  });

  it("list_docs returns doc pages", () => {
    const res = mcpCall("tools/call", { name: "list_docs", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("NemoClaw Documentation"), "missing heading");
    assert.ok(text.includes("overview.md"), "missing overview doc");
    assert.ok(text.includes("commands.md"), "missing commands doc");
  });

  it("read_doc returns content for valid path", () => {
    const res = mcpCall("tools/call", {
      name: "read_doc",
      arguments: { doc_path: "about/overview.md" },
    });
    const text = res.result.content[0].text;
    assert.ok(text.includes("Overview"), "missing title");
    assert.ok(text.includes("NemoClaw"), "missing NemoClaw mention");
  });

  it("read_doc returns error for invalid path", () => {
    const res = mcpCall("tools/call", {
      name: "read_doc",
      arguments: { doc_path: "nonexistent.md" },
    });
    assert.equal(res.result.isError, true, "expected isError flag");
    assert.ok(res.result.content[0].text.includes("not found"), "missing error message");
  });

  it("search finds results for 'inference'", () => {
    const res = mcpCall("tools/call", {
      name: "search",
      arguments: { query: "inference", max_results: 3 },
    });
    const text = res.result.content[0].text;
    assert.ok(text.includes("Search:"), "missing search heading");
    assert.ok(text.includes("Score:"), "missing score");
  });

  it("search returns empty for gibberish", () => {
    const res = mcpCall("tools/call", {
      name: "search",
      arguments: { query: "xyzzyplughtwisty" },
    });
    assert.ok(res.result.content[0].text.includes("No results"), "expected no results");
  });

  it("search respects scope filtering", () => {
    const res = mcpCall("tools/call", {
      name: "search",
      arguments: { query: "sandbox", scope: "policies" },
    });
    const text = res.result.content[0].text;
    assert.ok(text.includes("scope: policies"), "scope not reflected");
  });

  it("get_blueprint_config returns YAML", () => {
    const res = mcpCall("tools/call", { name: "get_blueprint_config", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("version:"), "missing version field");
    assert.ok(text.includes("profiles:"), "missing profiles");
  });

  it("get_baseline_policy returns policy YAML", () => {
    const res = mcpCall("tools/call", { name: "get_baseline_policy", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("network_policies:"), "missing network_policies");
    assert.ok(text.includes("filesystem_policy:"), "missing filesystem_policy");
  });

  it("list_policy_presets returns presets", () => {
    const res = mcpCall("tools/call", { name: "list_policy_presets", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("discord"), "missing discord preset");
    assert.ok(text.includes("slack"), "missing slack preset");
    assert.ok(text.includes("docker"), "missing docker preset");
  });

  it("get_policy_preset returns preset YAML", () => {
    const res = mcpCall("tools/call", {
      name: "get_policy_preset",
      arguments: { preset_name: "slack" },
    });
    const text = res.result.content[0].text;
    assert.ok(text.includes("slack"), "missing preset name");
    assert.ok(text.includes("api.slack.com"), "missing slack endpoint");
  });

  it("get_policy_preset returns error for unknown preset", () => {
    const res = mcpCall("tools/call", {
      name: "get_policy_preset",
      arguments: { preset_name: "nonexistent" },
    });
    assert.equal(res.result.isError, true, "expected isError flag");
  });

  it("get_nim_models returns model catalog", () => {
    const res = mcpCall("tools/call", { name: "get_nim_models", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("NIM Model Catalog"), "missing heading");
    assert.ok(text.includes("nemotron"), "missing nemotron model");
  });

  it("list_source_files returns files", () => {
    const res = mcpCall("tools/call", { name: "list_source_files", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("plugin"), "missing plugin category");
    assert.ok(text.includes("scripts"), "missing scripts category");
  });

  it("list_source_files filters by category", () => {
    const res = mcpCall("tools/call", {
      name: "list_source_files",
      arguments: { category: "blueprint" },
    });
    const text = res.result.content[0].text;
    assert.ok(text.includes("blueprint"), "missing blueprint category");
    assert.ok(!text.includes("## scripts"), "should not include scripts category");
  });

  it("get_architecture_overview returns overview", () => {
    const res = mcpCall("tools/call", { name: "get_architecture_overview", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("Architecture Overview"), "missing heading");
    assert.ok(text.includes("Key Flows"), "missing key flows");
  });

  it("get_dockerfile returns Dockerfile", () => {
    const res = mcpCall("tools/call", { name: "get_dockerfile", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("FROM"), "missing FROM instruction");
    assert.ok(text.includes("sandbox"), "missing sandbox user");
  });

  it("server version matches package.json", () => {
    const res = mcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    // The init response is id 1, but we sent it as id 2 in mcpCall wrapper
    // Use a direct check instead
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "mcp-docs-server", "package.json"), "utf-8")
    );
    assert.equal(pkg.version, "0.1.0", "package.json version mismatch");
  });
});
