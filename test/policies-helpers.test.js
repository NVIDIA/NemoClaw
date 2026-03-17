// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getPresetEndpoints,
  extractPresetEntries,
  parseCurrentPolicy,
} = require("../bin/lib/policies");

describe("getPresetEndpoints", () => {
  it("extracts hosts from YAML content", () => {
    const content = `
network_policies:
  npm_yarn:
    endpoints:
      - host: registry.npmjs.org
        port: 443
      - host: registry.yarnpkg.com
        port: 443
`;
    const hosts = getPresetEndpoints(content);
    assert.deepEqual(hosts, ["registry.npmjs.org", "registry.yarnpkg.com"]);
  });

  it("returns empty array when no hosts found", () => {
    assert.deepEqual(getPresetEndpoints(""), []);
    assert.deepEqual(getPresetEndpoints("name: foo"), []);
  });

  it("extracts single host", () => {
    const content = "host: example.com";
    assert.deepEqual(getPresetEndpoints(content), ["example.com"]);
  });
});

describe("extractPresetEntries", () => {
  it("extracts content after network_policies key", () => {
    const content = `preset:
  name: npm
  description: "npm access"

network_policies:
  npm_yarn:
    name: npm_yarn
    endpoints:
      - host: registry.npmjs.org
`;
    const result = extractPresetEntries(content);
    assert.ok(result);
    assert.ok(result.includes("npm_yarn"));
    assert.ok(result.includes("registry.npmjs.org"));
  });

  it("returns null when no network_policies section", () => {
    const content = `preset:
  name: test
  description: "no policies"
`;
    assert.equal(extractPresetEntries(content), null);
  });

  it("returns null for empty string", () => {
    assert.equal(extractPresetEntries(""), null);
  });
});

describe("parseCurrentPolicy", () => {
  it("strips metadata header before ---", () => {
    const raw = `Version: 3
Hash: abc123
---
version: 1

network_policies:
  claude_code:
    name: claude_code`;
    const result = parseCurrentPolicy(raw);
    assert.ok(result.startsWith("version: 1"));
    assert.ok(result.includes("claude_code"));
    assert.ok(!result.includes("Hash:"));
  });

  it("returns content as-is when no --- separator", () => {
    const raw = "version: 1\nnetwork_policies:";
    assert.equal(parseCurrentPolicy(raw), raw);
  });

  it("returns empty string for null/empty input", () => {
    assert.equal(parseCurrentPolicy(""), "");
    assert.equal(parseCurrentPolicy(null), "");
    assert.equal(parseCurrentPolicy(undefined), "");
  });
});
