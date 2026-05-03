// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const CANONICAL_FIX = path.join(ROOT, "nemoclaw-blueprint", "scripts", "http-proxy-fix.js");
const START_SCRIPT = path.join(ROOT, "scripts", "nemoclaw-start.sh");

describe("http-proxy-fix heredoc sync (#2109)", () => {
  it("entrypoint emits byte-for-byte canonical fix and registers it in NODE_OPTIONS", () => {
    const canonical = fs.readFileSync(CANONICAL_FIX, "utf-8");
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
      .replace('_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"', `_PROXY_FIX_SCRIPT=${JSON.stringify(fixPath)}`);
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "emit_sandbox_sourced_file() { local target=\"$1\"; cat > \"$target\"; chmod 444 \"$target\"; }",
      "NODE_USE_ENV_PROXY=1",
      "NODE_OPTIONS='--require /already-loaded.js'",
      block,
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
      expect(generated).toBe(canonical);
      expect(generated).not.toContain("axios-proxy-fix.js");
      expect((fs.statSync(fixPath).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
