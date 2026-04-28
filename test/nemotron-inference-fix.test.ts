// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("Nemotron inference fix preload (#1193, #2051)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines _NEMOTRON_FIX_SCRIPT path variable", () => {
    expect(src).toContain('_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"');
  });

  it("embeds the fix via a NEMOTRON_FIX_EOF heredoc", () => {
    expect(src).toMatch(
      /emit_sandbox_sourced_file\s+"\$_NEMOTRON_FIX_SCRIPT"\s+<<'NEMOTRON_FIX_EOF'/,
    );
    expect(src).toMatch(/^NEMOTRON_FIX_EOF$/m);
  });

  it("registers the preload in NODE_OPTIONS", () => {
    expect(src).toContain(
      'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_NEMOTRON_FIX_SCRIPT"',
    );
  });

  it("includes the preload in the proxy-env sourced file for connect sessions", () => {
    expect(src).toMatch(/# Nemotron inference fix for connect sessions/);
    expect(src).toContain("--require $_NEMOTRON_FIX_SCRIPT");
  });

  it("passes the preload path to validate_tmp_permissions in both root and non-root branches", () => {
    const calls = src.match(/validate_tmp_permissions\s+.*"\$_NEMOTRON_FIX_SCRIPT"/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("preload wraps both http and https modules", () => {
    const heredoc = src.match(/<<'NEMOTRON_FIX_EOF'\n([\s\S]*?)\nNEMOTRON_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc[1];
    expect(script).toContain("wrapModule(http)");
    expect(script).toContain("wrapModule(https)");
  });

  it("preload only intercepts POST requests to /v1/chat/completions", () => {
    const heredoc = src.match(/<<'NEMOTRON_FIX_EOF'\n([\s\S]*?)\nNEMOTRON_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc[1];
    expect(script).toContain("options.method !== 'POST'");
    expect(script).toContain("/v1/chat/completions");
  });

  it("preload matches Nemotron models case-insensitively", () => {
    const heredoc = src.match(/<<'NEMOTRON_FIX_EOF'\n([\s\S]*?)\nNEMOTRON_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc[1];
    expect(script).toMatch(/nemotron\/i/);
  });

  it("preload injects force_nonempty_content into chat_template_kwargs", () => {
    const heredoc = src.match(/<<'NEMOTRON_FIX_EOF'\n([\s\S]*?)\nNEMOTRON_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc[1];
    expect(script).toContain("chat_template_kwargs");
    expect(script).toContain("force_nonempty_content");
  });

  it("preload passes through non-Nemotron models unmodified", () => {
    const heredoc = src.match(/<<'NEMOTRON_FIX_EOF'\n([\s\S]*?)\nNEMOTRON_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc[1];
    // The else branch sends original bytes
    expect(script).toContain("origWrite.call(req, raw)");
  });

  it("preload falls back gracefully on JSON parse failure", () => {
    const heredoc = src.match(/<<'NEMOTRON_FIX_EOF'\n([\s\S]*?)\nNEMOTRON_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc[1];
    expect(script).toMatch(/catch\s*\(_e\)/);
    // Must forward original bytes on error, not crash
    expect(script).toMatch(/catch[\s\S]*?origWrite\.call\(req, raw\)/);
  });

  it("preload updates Content-Length header after body modification", () => {
    const heredoc = src.match(/<<'NEMOTRON_FIX_EOF'\n([\s\S]*?)\nNEMOTRON_FIX_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc[1];
    expect(script).toContain("removeHeader('content-length')");
    expect(script).toContain("setHeader('Content-Length'");
  });

  it("preload is placed before the WebSocket fix in the script", () => {
    const nemotronPos = src.indexOf("_NEMOTRON_FIX_SCRIPT=");
    const wsPos = src.indexOf("_WS_FIX_SCRIPT=");
    expect(nemotronPos).toBeGreaterThan(-1);
    expect(wsPos).toBeGreaterThan(-1);
    expect(nemotronPos).toBeLessThan(wsPos);
  });
});
