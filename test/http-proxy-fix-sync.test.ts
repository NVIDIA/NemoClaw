// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const CANONICAL_FIX = path.join(ROOT, "nemoclaw-blueprint", "scripts", "http-proxy-fix.js");
const START_SCRIPT = path.join(ROOT, "scripts", "nemoclaw-start.sh");

describe("http-proxy-fix heredoc sync (#2109)", () => {
  it("canonical http-proxy-fix.js exists and is non-empty", () => {
    expect(fs.existsSync(CANONICAL_FIX)).toBe(true);
    const content = fs.readFileSync(CANONICAL_FIX, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("(function () {");
    expect(content).toContain("http.request = function");
  });

  it("nemoclaw-start.sh embeds the fix via a HTTP_PROXY_FIX_EOF heredoc", () => {
    const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
    expect(startScript).toMatch(
      /emit_sandbox_sourced_file\s+"\$_PROXY_FIX_SCRIPT"\s+<<'HTTP_PROXY_FIX_EOF'/,
    );
    expect(startScript).toMatch(/^HTTP_PROXY_FIX_EOF$/m);
  });

  // Critical: the heredoc content in nemoclaw-start.sh and the canonical file
  // are two copies of the same code. If they drift, the shipped fix no longer
  // matches what review was done against. This test is the only thing keeping
  // the two in sync — a mismatch here is a bug.
  it("embedded heredoc matches canonical file byte-for-byte", () => {
    const canonical = fs.readFileSync(CANONICAL_FIX, "utf-8");
    const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
    const match = startScript.match(/<<'HTTP_PROXY_FIX_EOF'\n([\s\S]*?)\nHTTP_PROXY_FIX_EOF/);
    expect(match).not.toBeNull();
    if (!match) {
      throw new Error("Expected HTTP_PROXY_FIX_EOF heredoc in scripts/nemoclaw-start.sh");
    }
    // The heredoc capture excludes the final newline preceding the delimiter.
    // POSIX convention: the canonical file ends with a trailing newline.
    const embedded = `${match[1]}\n`;
    if (embedded !== canonical) {
      const embeddedLines = embedded.split("\n");
      const canonicalLines = canonical.split("\n");
      const firstDiff = embeddedLines.findIndex((l, i) => l !== canonicalLines[i]);
      throw new Error(
        `heredoc in scripts/nemoclaw-start.sh drifted from ${path.relative(ROOT, CANONICAL_FIX)} at line ${firstDiff + 1}:\n` +
          `  canonical: ${JSON.stringify(canonicalLines[firstDiff])}\n` +
          `  embedded:  ${JSON.stringify(embeddedLines[firstDiff])}\n` +
          "\nUpdate the heredoc in scripts/nemoclaw-start.sh (or the canonical file) so both match.",
      );
    }
    expect(embedded).toBe(canonical);
  });

  it("NODE_OPTIONS export references the same /tmp path the heredoc writes to", () => {
    const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
    expect(startScript).toContain('_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"');
    const primaryExport = startScript.match(
      /export NODE_OPTIONS="\$\{NODE_OPTIONS:\+\$NODE_OPTIONS \}--require \$_PROXY_FIX_SCRIPT"/,
    );
    expect(primaryExport).not.toBeNull();
  });

  it("validate_tmp_permissions is invoked with the fix path in both root and non-root branches", () => {
    const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
    const calls = startScript.match(/validate_tmp_permissions "\$_PROXY_FIX_SCRIPT"/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("legacy axios-proxy-fix variable is fully removed", () => {
    const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
    expect(startScript).not.toContain("_AXIOS_FIX_SCRIPT");
    expect(startScript).not.toContain("axios-proxy-fix.js");
  });
});
