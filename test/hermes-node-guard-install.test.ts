// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const START_SCRIPT = path.join(ROOT, "agents", "hermes", "start.sh");
const DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");

function extractGuardInstaller(source: string): string {
  const start = source.indexOf("install_nemoclaw_node_guards() {");
  const end = source.indexOf("\n# Invoked with", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runGuardInstaller(sourceDir: string, emitFunction: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-node-guards-"));
  const safetyTarget = path.join(tempDir, "sandbox-safety-net.js");
  const ciaoTarget = path.join(tempDir, "ciao-network-guard.js");
  const source = fs
    .readFileSync(START_SCRIPT, "utf8")
    .replaceAll("/tmp/nemoclaw-sandbox-safety-net.js", safetyTarget)
    .replaceAll("/tmp/nemoclaw-ciao-network-guard.js", ciaoTarget);
  const script = [
    "set -euo pipefail",
    emitFunction,
    extractGuardInstaller(source),
    'NODE_OPTIONS=""',
    `install_nemoclaw_node_guards ${shellQuote(sourceDir)}`,
    'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  return { ciaoTarget, result, safetyTarget, tempDir };
}

describe("Hermes Node guard installation", () => {
  it("stages both image-owned guards and exports them through NODE_OPTIONS", () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-node-guard-source-"));
    fs.writeFileSync(path.join(sourceDir, "sandbox-safety-net.js"), "// safety\n");
    fs.writeFileSync(path.join(sourceDir, "ciao-network-guard.js"), "// ciao\n");
    const harness = runGuardInstaller(sourceDir, 'emit_sandbox_sourced_file() { cat >"$1"; }');
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(fs.readFileSync(harness.safetyTarget, "utf8")).toBe("// safety\n");
      expect(fs.readFileSync(harness.ciaoTarget, "utf8")).toBe("// ciao\n");
      expect(harness.result.stdout).toContain(`--require ${harness.safetyTarget}`);
      expect(harness.result.stdout).toContain(`--require ${harness.ciaoTarget}`);
    } finally {
      fs.rmSync(sourceDir, { force: true, recursive: true });
      fs.rmSync(harness.tempDir, { force: true, recursive: true });
    }
  });

  it("keeps startup alive when guard staging fails", () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-node-guard-source-"));
    fs.writeFileSync(path.join(sourceDir, "sandbox-safety-net.js"), "// safety\n");
    fs.writeFileSync(path.join(sourceDir, "ciao-network-guard.js"), "// ciao\n");
    const harness = runGuardInstaller(sourceDir, "emit_sandbox_sourced_file() { return 1; }");
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(harness.result.stdout).toBe("NODE_OPTIONS=\n");
      expect(harness.result.stderr).toContain("could not install sandbox-safety-net preload");
      expect(harness.result.stderr).toContain("could not install ciao-network-guard preload");
    } finally {
      fs.rmSync(sourceDir, { force: true, recursive: true });
      fs.rmSync(harness.tempDir, { force: true, recursive: true });
    }
  });

  it("keeps startup alive when the image guard directory is missing", () => {
    const missingDir = path.join(os.tmpdir(), `missing-hermes-guards-${process.pid}`);
    const harness = runGuardInstaller(missingDir, 'emit_sandbox_sourced_file() { cat >"$1"; }');
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(harness.result.stdout).toBe("NODE_OPTIONS=\n");
      expect(harness.result.stderr).toContain("NemoClaw preload guards not found");
    } finally {
      fs.rmSync(harness.tempDir, { force: true, recursive: true });
    }
  });

  it("copies the recovery preloads into the Hermes image contract", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    expect(dockerfile).toContain(
      "COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/",
    );
    expect(dockerfile).toContain(
      "find /usr/local/lib/nemoclaw/preloads -type f -name '*.js' -exec chmod 644 {} +",
    );
    expect(fs.readFileSync(START_SCRIPT, "utf8")).not.toContain("NEMOCLAW_GUARD_DIRS");
  });
});
