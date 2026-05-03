// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Additional coverage on top of the existing
 * "REST policy YAML avoids deprecated tls: terminate" guard in
 * test/policies.test.ts.
 *
 * Two angles the existing test does not cover:
 *   1. Parse safety — bulk YAML deletions can leave a preset structurally
 *      broken (e.g. dangling list marker). Load each and confirm it parses.
 *   2. Over-deletion guard — `tls: skip` is still required for WebSocket
 *      pass-through endpoints. Ensure the deletion sweep did not catch
 *      those by mistake.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const POLICY_DIR = path.join(REPO_ROOT, "nemoclaw-blueprint", "policies");
const AGENTS_DIR = path.join(REPO_ROOT, "agents");
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(content: string): unknown };

function listPolicyFiles(): string[] {
  const files: string[] = [path.join(POLICY_DIR, "openclaw-sandbox.yaml")];
  const presetsDir = path.join(POLICY_DIR, "presets");
  for (const name of fs.readdirSync(presetsDir)) {
    if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      files.push(path.join(presetsDir, name));
    }
  }
  if (fs.existsSync(AGENTS_DIR)) {
    for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agentPolicyFile = path.join(AGENTS_DIR, entry.name, "policy-additions.yaml");
      if (fs.existsSync(agentPolicyFile)) files.push(agentPolicyFile);
    }
  }
  return files;
}

describe("Issue #2749 — additional coverage on top of existing tls:terminate guard", () => {
  it("PARSE SAFETY: every policy YAML input still parses after deletions", () => {
    for (const file of listPolicyFiles()) {
      const content = fs.readFileSync(file, "utf-8");
      // js-yaml throws on syntactic damage (dangling list markers, broken
      // indentation from bulk line deletions, etc.). If load() returns,
      // the file is structurally intact.
      expect(() => yaml.load(content)).not.toThrow();
      const parsed = yaml.load(content);
      expect(parsed).not.toBeNull();
      expect(typeof parsed).toBe("object");
    }
  });

  it("OVER-DELETION GUARD: `tls: skip` entries for WS pass-through are preserved", () => {
    // The PR removes `tls: terminate` (deprecated) but the body explicitly
    // calls out that `tls: skip` for WebSocket pass-through should stay.
    // Confirm at least one built-in preset still has `tls: skip` so a
    // future overzealous deletion sweep is caught without being masked by
    // the base policy.
    let presetSkipCount = 0;
    for (const file of listPolicyFiles().filter((candidate) =>
      candidate.includes(`${path.sep}presets${path.sep}`),
    )) {
      const content = fs.readFileSync(file, "utf-8");
      const matches = content.match(/^\s+tls:\s*skip\b/gm);
      if (matches) presetSkipCount += matches.length;
    }
    expect(presetSkipCount).toBeGreaterThan(0);
  });
});
