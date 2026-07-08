// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const CANONICAL_FIX = path.join(ROOT, "nemoclaw-blueprint", "scripts", "http-proxy-fix.js");
const START_SCRIPT = path.join(ROOT, "scripts", "nemoclaw-start.sh");

function extractShellFunction(source: string, name: string): string {
  const header = `${name}() {`;
  const start = source.indexOf(header);
  expect(start, `expected ${name} in nemoclaw-start.sh`).not.toBe(-1);
  const body = source.slice(start + header.length);
  const closing = body.match(/^}$/m);
  expect(closing, `expected closing brace for ${name}`).not.toBeNull();
  return `${name}() {${body.slice(0, closing?.index ?? 0)}\n}`;
}

describe("http-proxy-fix preload sync (#2109)", () => {
  it("entrypoint emits the proxy fix preload and registers it in NODE_OPTIONS", () => {
    const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
    const start = startScript.indexOf('_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"');
    const end = startScript.indexOf(
      "# NVIDIA endpoint model-specific inference parameter injection",
      start,
    );
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected HTTP proxy fix entrypoint block in scripts/nemoclaw-start.sh");
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-http-proxy-fix-"));
    const fixPath = path.join(tempDir, "http-proxy-fix.js");
    const block = startScript
      .slice(start, end)
      .replace(
        '_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"',
        `_PROXY_FIX_SCRIPT=${JSON.stringify(fixPath)}`,
      )
      .replace(
        '_PROXY_FIX_SOURCE="/usr/local/lib/nemoclaw/preloads/http-proxy-fix.js"',
        `_PROXY_FIX_SOURCE=${JSON.stringify(CANONICAL_FIX)}`,
      );
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
      "NODE_USE_ENV_PROXY=1",
      "NODE_OPTIONS='--require /already-loaded.js'",
      extractShellFunction(startScript, "node_options_has_require"),
      extractShellFunction(startScript, "append_node_require_once"),
      block,
      `_SANDBOX_SAFETY_NET=${JSON.stringify(path.join(tempDir, "safety-net.js"))}`,
      `_SANDBOX_SAFETY_NET_SOURCE=${JSON.stringify(CANONICAL_FIX)}`,
      `_NEMOTRON_FIX_SCRIPT=${JSON.stringify(path.join(tempDir, "nemotron-fix.js"))}`,
      `_NEMOTRON_FIX_SOURCE=${JSON.stringify(CANONICAL_FIX)}`,
      `_CIAO_GUARD_SCRIPT=${JSON.stringify(path.join(tempDir, "ciao-guard.js"))}`,
      `_CIAO_GUARD_SOURCE=${JSON.stringify(CANONICAL_FIX)}`,
      `_WS_FIX_SCRIPT=${JSON.stringify(path.join(tempDir, "ws-fix.js"))}`,
      `_WS_FIX_SOURCE=${JSON.stringify(path.join(tempDir, "missing-ws-source.js"))}`,
      `_SECCOMP_GUARD_SCRIPT=${JSON.stringify(path.join(tempDir, "seccomp-guard.js"))}`,
      `_SECCOMP_GUARD_SOURCE=${JSON.stringify(CANONICAL_FIX)}`,
      extractShellFunction(startScript, "install_core_runtime_preloads"),
      "install_core_runtime_preloads",
      "printf 'NODE_OPTIONS=%s\\n' \"$NODE_OPTIONS\"",
      "printf 'SCRIPT=%s\\n' \"$_PROXY_FIX_SCRIPT\"",
    ].join("\n");
    const wrapperPath = path.join(tempDir, "run.sh");

    try {
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
      const result = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`SCRIPT=${fixPath}`);
      expect(result.stdout).toContain("--require /already-loaded.js");
      expect(result.stdout).toContain(`--require ${fixPath}`);
      const generated = fs.readFileSync(fixPath, "utf-8");
      expect(generated).not.toContain("axios-proxy-fix.js");
      expect((fs.statSync(fixPath).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
