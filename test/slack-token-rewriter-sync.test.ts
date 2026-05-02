// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const CANONICAL_REWRITER = path.join(
  ROOT,
  "nemoclaw-blueprint",
  "scripts",
  "slack-token-rewriter.js",
);
const START_SCRIPT = path.join(ROOT, "scripts", "nemoclaw-start.sh");

describe("slack-token-rewriter heredoc sync (#2085)", () => {
  it("entrypoint emits byte-for-byte canonical rewriter and registers it in NODE_OPTIONS", () => {
    const canonical = fs.readFileSync(CANONICAL_REWRITER, "utf-8");
    const startScript = fs.readFileSync(START_SCRIPT, "utf-8");
    const start = startScript.indexOf("# ── Slack token rewriter");
    const end = startScript.indexOf("# ── Slack secrets-on-disk tripwire", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected Slack token rewriter entrypoint block in scripts/nemoclaw-start.sh");
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-rewriter-"));
    const rewriterPath = path.join(tempDir, "slack-token-rewriter.js");
    const configPath = path.join(tempDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ token: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" }));
    const block = startScript
      .slice(start, end)
      .replace(
        '_SLACK_REWRITER_SCRIPT="/tmp/nemoclaw-slack-token-rewriter.js"',
        `_SLACK_REWRITER_SCRIPT=${JSON.stringify(rewriterPath)}`,
      )
      .replace(
        'local config_file="/sandbox/.openclaw/openclaw.json"',
        `local config_file=${JSON.stringify(configPath)}`,
      );
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "emit_sandbox_sourced_file() { local target=\"$1\"; cat > \"$target\"; chmod 444 \"$target\"; }",
      "NODE_OPTIONS='--require /already-loaded.js'",
      block,
      "install_slack_token_rewriter",
      "printf 'NODE_OPTIONS=%s\\n' \"$NODE_OPTIONS\"",
      "printf 'SCRIPT=%s\\n' \"$_SLACK_REWRITER_SCRIPT\"",
    ].join("\n");
    const wrapperPath = path.join(tempDir, "run.sh");

    try {
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
      const result = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`SCRIPT=${rewriterPath}`);
      expect(result.stdout).toContain("--require /already-loaded.js");
      expect(result.stdout).toContain(`--require ${rewriterPath}`);
      const generated = fs.readFileSync(rewriterPath, "utf-8");
      expect(generated).toBe(canonical);
      expect((fs.statSync(rewriterPath).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
