// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

const repoRoot = path.resolve(__dirname, "..");

describe("configureWebSearch non-interactive Brave validation failure", () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // Best-effort cleanup: temp file may already be removed.
      }
    }
    tmpFiles.length = 0;
  });

  it("returns null instead of exiting when Brave API key validation fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brave-skip-"));
    const scriptPath = path.join(tmpDir, "test-brave-skip.mjs");
    tmpFiles.push(scriptPath);

    // Script that imports configureWebSearch with mocked runCurlProbe
    const script = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Module = require("module");

// Intercept require to mock runCurlProbe
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  return origResolve.call(this, request, parent, isMain, options);
};

// We need to patch the onboard module after loading.
// Load the compiled module and call configureWebSearch.
const onboard = require("${repoRoot.replace(/\\/g, "/")}/dist/lib/onboard.js");

// Mock the validation function by patching the module-level function.
// configureWebSearch calls validateBraveSearchApiKey internally,
// which calls runCurlProbe which calls spawnSync(curl, ...).
// We mock spawnSync at the child_process level.
const cp = require("node:child_process");
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function(cmd, args, opts) {
  // When curl is called for Brave validation, return a 429 error
  if (cmd === "curl" && args && args.some(a => typeof a === "string" && a.includes("brave.com"))) {
    return {
      status: 0,
      stdout: '{"type":"ErrorResponse","error":{"status":429,"detail":"Rate limit exceeded"}}',
      stderr: "",
    };
  }
  return origSpawnSync.call(this, cmd, args, opts);
};

async function main() {
  const result = await onboard.configureWebSearch(null);
  // If we reach here, process.exit was NOT called
  console.log("RESULT:" + JSON.stringify(result));
  process.exit(0);
}

main().catch(err => {
  console.error("ERROR:" + err.message);
  process.exit(2);
});
`;

    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: tmpDir,
        BRAVE_API_KEY: "test-invalid-key-12345",
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    // Should exit 0, not 1
    expect(result.status).toBe(0);

    // Should return null (skip web search)
    expect(result.stdout).toContain("RESULT:null");

    // Should print a warning about validation failure
    expect(result.stderr).toContain("Brave Search API key validation failed");

    // Cleanup tmpDir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips Brave web search when no BRAVE_API_KEY is set", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brave-none-"));
    const scriptPath = path.join(tmpDir, "test-brave-none.mjs");
    tmpFiles.push(scriptPath);

    const script = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const onboard = require("${repoRoot.replace(/\\/g, "/")}/dist/lib/onboard.js");

async function main() {
  const result = await onboard.configureWebSearch(null);
  console.log("RESULT:" + JSON.stringify(result));
  process.exit(0);
}

main().catch(err => {
  console.error("ERROR:" + err.message);
  process.exit(2);
});
`;

    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_NON_INTERACTIVE: "1",
        // No BRAVE_API_KEY set
      },
    });

    // Should exit 0 and return null (no Brave key → skip)
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESULT:null");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
