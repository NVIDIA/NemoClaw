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

// Extract the full deploy() function body using brace-depth counting
// so we don't stop at the first inner closing brace.
function extractDeploy(src) {
  const start = src.indexOf("async function deploy(");
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  if (open === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}") depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) return null;
  return src.slice(start, end);
}

const deployBody = extractDeploy(source);

describe("deploy instance name hardening", () => {
  it("can extract deploy() function body", () => {
    assert.ok(deployBody, "Could not find deploy() function");
  });

  it("enforces RFC 1123 validation inside deploy()", () => {
    assert.match(
      deployBody,
      /\^\[a-z0-9\]/,
      "deploy() must validate the instance name against RFC 1123 subdomain rules"
    );
  });

  it("rejects names longer than 253 characters inside deploy()", () => {
    assert.match(
      deployBody,
      /name\.length\s*>\s*253/,
      "deploy() must enforce a 253-character limit on instance names"
    );
  });

  it("does not interpolate unquoted instance name in shell commands", () => {
    // Every ${name} in a shell command string must be exactly "${name}".
    // Skip console.log/error lines which are display-only.
    const lines = deployBody.split("\n");
    for (const line of lines) {
      if (line.includes("${name}") && !line.match(/console\.(log|error)/)) {
        const all = [...line.matchAll(/\$\{name\}/g)].length;
        const quoted = [...line.matchAll(/"\$\{name\}"/g)].length;
        assert.equal(
          quoted,
          all,
          `Unquoted \${name} in shell command: ${line.trim()}`
        );
      }
    }
  });

  it("quotes instance name in brev create", () => {
    assert.ok(
      deployBody.includes('brev create "${name}"'),
      'brev create must quote the instance name: brev create "${name}"'
    );
  });

  it("quotes instance name in rsync destination", () => {
    assert.ok(
      deployBody.includes('"${name}":/home/ubuntu/nemoclaw/'),
      'rsync destination must quote the instance name: "${name}":/path'
    );
  });

  it("quotes instance name in scp destination", () => {
    assert.ok(
      deployBody.includes('"${name}":/home/ubuntu/nemoclaw/.env'),
      'scp destination must quote the instance name: "${name}":/path'
    );
  });
});
