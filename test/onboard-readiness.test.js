// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildPolicySetCommand, buildPolicyGetCommand } = require("../bin/lib/policies");

// Test the readiness parsing logic extracted for testability
// These validate the exact matching algorithm from onboard.js createSandbox()

function isSandboxReady(output, sandboxName) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  return clean.split("\n").some((l) => {
    const cols = l.trim().split(/\s+/);
    return cols[0] === sandboxName && cols.includes("Ready") && !cols.includes("NotReady");
  });
}

describe("sandbox readiness parsing", () => {
  it("detects Ready sandbox", () => {
    assert.ok(isSandboxReady("my-assistant   Ready   2m ago", "my-assistant"));
  });

  it("rejects NotReady sandbox", () => {
    assert.ok(!isSandboxReady("my-assistant   NotReady   init failed", "my-assistant"));
  });

  it("rejects empty output", () => {
    assert.ok(!isSandboxReady("No sandboxes found.", "my-assistant"));
    assert.ok(!isSandboxReady("", "my-assistant"));
  });

  it("strips ANSI escape codes before matching", () => {
    assert.ok(isSandboxReady(
      "\x1b[1mmy-assistant\x1b[0m   \x1b[32mReady\x1b[0m   2m ago",
      "my-assistant"
    ));
  });

  it("rejects ANSI-wrapped NotReady", () => {
    assert.ok(!isSandboxReady(
      "\x1b[1mmy-assistant\x1b[0m   \x1b[31mNotReady\x1b[0m   crash",
      "my-assistant"
    ));
  });

  it("exact-matches sandbox name in first column", () => {
    // "my" should NOT match "my-assistant"
    assert.ok(!isSandboxReady("my-assistant   Ready   2m ago", "my"));
  });

  it("does not match sandbox name in non-first column", () => {
    assert.ok(!isSandboxReady("other-box   Ready   owned-by-my-assistant", "my-assistant"));
  });

  it("handles multiple sandboxes in output", () => {
    const output = [
      "NAME           STATUS     AGE",
      "dev-box        NotReady   5m ago",
      "my-assistant   Ready      2m ago",
      "staging        Ready      10m ago",
    ].join("\n");
    assert.ok(isSandboxReady(output, "my-assistant"));
    assert.ok(!isSandboxReady(output, "dev-box")); // NotReady
    assert.ok(isSandboxReady(output, "staging"));
    assert.ok(!isSandboxReady(output, "prod")); // not present
  });

  it("handles Ready sandbox with extra status columns", () => {
    assert.ok(isSandboxReady("my-assistant   Ready   Running   2m ago   1/1", "my-assistant"));
  });

  it("rejects when output only contains name in a URL or path", () => {
    assert.ok(!isSandboxReady("Connecting to my-assistant.openshell.internal Ready", "my-assistant"));
    // "my-assistant.openshell.internal" is cols[0], not "my-assistant"
  });

  it("handles tab-separated output", () => {
    assert.ok(isSandboxReady("my-assistant\tReady\t2m ago", "my-assistant"));
  });
});

// Regression tests: WSL truncates hyphenated sandbox names during shell
// argument parsing (e.g. "my-assistant" → "m").
describe("WSL sandbox name handling", () => {
  it("buildPolicySetCommand preserves hyphenated sandbox name", () => {
    const cmd = buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
    assert.ok(cmd.includes('"my-assistant"'), `Expected quoted name in: ${cmd}`);
    assert.ok(!cmd.includes(' my-assistant '), "Name must be quoted, not bare");
  });

  it("buildPolicyGetCommand preserves hyphenated sandbox name", () => {
    const cmd = buildPolicyGetCommand("my-assistant");
    assert.ok(cmd.includes('"my-assistant"'), `Expected quoted name in: ${cmd}`);
  });

  it("buildPolicySetCommand preserves multi-hyphen names", () => {
    const cmd = buildPolicySetCommand("/tmp/p.yaml", "my-dev-assistant-v2");
    assert.ok(cmd.includes('"my-dev-assistant-v2"'));
  });

  it("buildPolicySetCommand preserves single-char name", () => {
    // If WSL truncates "my-assistant" to "m", the single-char name should
    // still be quoted and passed through unchanged
    const cmd = buildPolicySetCommand("/tmp/p.yaml", "m");
    assert.ok(cmd.includes('"m"'));
  });

  it("applyPreset rejects truncated/invalid sandbox name", () => {
    const policies = require("../bin/lib/policies");
    // Empty name
    assert.throws(
      () => policies.applyPreset("", "npm"),
      /Invalid or truncated sandbox name/
    );
    // Name with uppercase (not valid per RFC 1123)
    assert.throws(
      () => policies.applyPreset("My-Assistant", "npm"),
      /Invalid or truncated sandbox name/
    );
    // Name starting with hyphen
    assert.throws(
      () => policies.applyPreset("-broken", "npm"),
      /Invalid or truncated sandbox name/
    );
  });

  it("readiness check uses exact match preventing truncated name false-positive", () => {
    // If "my-assistant" was truncated to "m", the readiness check should
    // NOT match a sandbox named "my-assistant" when searching for "m"
    assert.ok(!isSandboxReady("my-assistant   Ready   2m ago", "m"));
    assert.ok(!isSandboxReady("my-assistant   Ready   2m ago", "my"));
    assert.ok(!isSandboxReady("my-assistant   Ready   2m ago", "my-"));
  });
});
