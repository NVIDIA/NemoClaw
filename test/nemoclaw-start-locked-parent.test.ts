// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractShellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  expect(start, `Expected ${name} in nemoclaw-start.sh`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start);
  const end = body.indexOf("\n}");
  expect(end, `Expected ${name} closing brace`).toBeGreaterThan(0);
  return `${body.slice(0, end)}\n}`;
}

function runParentPreflight(configOwner: "root" | "sandbox", parentProtected: boolean) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-parent-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  const blockStart = source.indexOf(
    "# A root-owned config directory is the shields-up discriminator.",
  );
  const blockEnd = source.indexOf("# Migrate legacy symlink layout", blockStart);
  expect(blockStart).toBeGreaterThanOrEqual(0);
  expect(blockEnd).toBeGreaterThan(blockStart);
  const parentOwner = parentProtected ? "root:sandbox" : "sandbox:sandbox";
  const parentMode = parentProtected ? "1775" : "755";

  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `openclaw_config_dir_owner() { printf '%s\\n' ${JSON.stringify(configOwner)}; }`,
      `stat() { case "\${2:-}" in '%U:%G') printf '%s\\n' ${JSON.stringify(parentOwner)} ;; '%a') printf '%s\\n' ${JSON.stringify(parentMode)} ;; *) return 1 ;; esac; }`,
      extractShellFunction(source, "openclaw_locked_parent_is_protected"),
      source.slice(blockStart, blockEnd),
      'printf "startup-continued\\n"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("OpenClaw locked parent startup preflight", () => {
  it("accepts mutable config and the sticky root-owned locked posture", () => {
    const mutable = runParentPreflight("sandbox", false);
    expect(mutable.status, mutable.stderr).toBe(0);
    expect(mutable.stdout).toContain("startup-continued");

    const locked = runParentPreflight("root", true);
    expect(locked.status, locked.stderr).toBe(0);
    expect(locked.stdout).toContain("startup-continued");
  });

  it("refuses a root-owned config root under a renameable sandbox parent", () => {
    const result = runParentPreflight("root", false);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("startup-continued");
    expect(result.stderr).toContain("OPENCLAW_LOCKED_PARENT_UNPROTECTED");
    expect(result.stderr).toContain("trusted backup and recreate");
  });
});
