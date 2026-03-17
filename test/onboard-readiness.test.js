// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

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
