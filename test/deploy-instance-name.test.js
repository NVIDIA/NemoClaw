// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that deploy() validates and quotes the instance name in shell
// commands to prevent command injection.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "bin/nemoclaw.js"), "utf-8");

describe("deploy instance name hardening", () => {
  it("validates instance name with RFC 1123 regex", () => {
    assert.ok(
      source.includes("[a-z0-9-]") && source.includes("deploy"),
      "deploy() must validate the instance name against RFC 1123 subdomain rules"
    );
  });

  it("rejects names longer than 253 characters", () => {
    assert.ok(
      source.includes("253"),
      "deploy() must enforce a 253-character limit on instance names"
    );
  });

  it("does not interpolate unquoted instance name in ssh commands", () => {
    // Extract lines inside deploy() that call ssh/scp/rsync with the instance name.
    // After the fix, every ${name} in a shell string must be wrapped in double quotes.
    const deployMatch = source.match(/async function deploy\([\s\S]*?\n\}/);
    assert.ok(deployMatch, "Could not find deploy() function");
    const deployBody = deployMatch[0];

    // Find all shell-interpolated ${name} occurrences (skip console.log/error lines)
    const lines = deployBody.split("\n");
    for (const line of lines) {
      if (line.includes("${name}") && !line.match(/console\.(log|error)/)) {
        // In shell command strings, ${name} must be inside double quotes: "${name}"
        const unquoted = line.match(/[^"]\$\{name\}[^"]/);
        assert.ok(
          !unquoted,
          `Unquoted \${name} in shell command: ${line.trim()}`
        );
      }
    }
  });

  it("quotes instance name in brev create", () => {
    assert.ok(
      source.includes('brev create "${name}"'),
      'brev create must quote the instance name: brev create "${name}"'
    );
  });

  it("quotes instance name in rsync destination", () => {
    assert.ok(
      source.includes('"${name}":/home/ubuntu/nemoclaw/'),
      'rsync destination must quote the instance name: "${name}":/path'
    );
  });

  it("quotes instance name in scp destination", () => {
    assert.ok(
      source.includes('"${name}":/home/ubuntu/nemoclaw/.env'),
      'scp destination must quote the instance name: "${name}":/path'
    );
  });
});
