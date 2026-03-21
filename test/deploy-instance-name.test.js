// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that deploy() validates and shell-quotes the instance name in
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
      "deploy() must validate the instance name against RFC 1123 label rules"
    );
  });

  it("enforces max 63 character limit", () => {
    assert.match(
      deployBody,
      /length\s*>\s*63/,
      "deploy() must enforce a 63-character limit on instance names"
    );
  });

  it("uses shellQuote for instance name in shell commands", () => {
    assert.ok(
      deployBody.includes("qname = shellQuote(name)"),
      "deploy() must create a shellQuoted name variable"
    );
  });

  it("does not use execSync (prefer execFileSync)", () => {
    assert.ok(
      !deployBody.includes("execSync("),
      "deploy() must use execFileSync instead of execSync"
    );
  });

  it("shell-quotes env values", () => {
    assert.ok(
      deployBody.includes("shellQuote(process.env.NVIDIA_API_KEY"),
      "NVIDIA_API_KEY must be shellQuoted in env file"
    );
  });
});
