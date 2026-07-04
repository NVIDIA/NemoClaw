// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/lib/core/shell-quote";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunctionFromSource(src: string, name: string): string {
  const escapedName = escapeRegExp(name);
  const match = src.match(new RegExp(`${escapedName}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  expect(match, `Expected ${name} in agents/hermes/start.sh`).not.toBeNull();
  return `${name}() {${match?.[1] ?? ""}\n}`;
}

function runHermesConfigIntegrityVerifierAsRoot(inspectStatus: 0 | 1) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-integrity-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const hermesHome = path.join(tmpDir, ".hermes");
  const hashFile = path.join(tmpDir, "hermes.config-hash");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(hashFile, "hash\n");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "0\\n"; else command id "$@"; fi; }',
      'verify_config_integrity() { printf "verify:%s:%s:stepped=%s\\n" "$1" "$2" "${NEMOCLAW_TEST_STEPPED_DOWN:-0}"; }',
      `inspect_hermes_mcp_integrity() { return ${inspectStatus}; }`,
      extractShellFunctionFromSource(src, "verify_hermes_config_integrity"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES_HASH_FILE=${shellQuote(hashFile)}`,
      "STEP_DOWN_PREFIX_SANDBOX=(env NEMOCLAW_TEST_STEPPED_DOWN=1)",
      "HERMES_RESTART_FAILURE_CODE=internal",
      'if verify_hermes_config_integrity; then printf "result=success failure-code=%s\\n" "$HERMES_RESTART_FAILURE_CODE"; else printf "result=failure failure-code=%s\\n" "$HERMES_RESTART_FAILURE_CODE"; fi',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesDashboardHomePrepAsRoot() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-seed-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const binDir = path.join(tmpDir, "bin");
  const fakePython = path.join(tmpDir, "fake-python.sh");
  const logPath = path.join(tmpDir, "seed.log");
  const hermesHome = path.join(tmpDir, ".hermes");
  const dashboardHome = path.join(hermesHome, "dashboard-home");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.mkdirSync(dashboardHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardHome, "gateway_state.json"), "stale\n");
  for (const [name, realCommand] of [
    ["mkdir", "/bin/mkdir"],
    ["chmod", "/bin/chmod"],
    ["rm", "/bin/rm"],
    ["chown", ""],
  ] as const) {
    fs.writeFileSync(
      path.join(binDir, name),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf 'cmd=${name} stepped=%s args=' "\${NEMOCLAW_TEST_STEPPED_DOWN:-0}" >>${shellQuote(logPath)}`,
        `printf '%q ' "$@" >>${shellQuote(logPath)}`,
        `printf '\\n' >>${shellQuote(logPath)}`,
        realCommand ? `exec ${realCommand} "$@"` : "exit 64",
      ].join("\n"),
      { mode: 0o700 },
    );
  }
  fs.writeFileSync(
    fakePython,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'cmd=python stepped=%s args=' "\${NEMOCLAW_TEST_STEPPED_DOWN:-0}" >>${shellQuote(logPath)}`,
      `printf '%q ' "$@" >>${shellQuote(logPath)}`,
      `printf '\\n' >>${shellQuote(logPath)}`,
      `printf 'args=%s\\n' "$*" >>${shellQuote(logPath)}`,
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `PATH=${shellQuote(`${binDir}:${process.env.PATH ?? ""}`)}`,
      "export PATH",
      'id() { if [ "${1:-}" = "-u" ]; then printf "0\\n"; else command id "$@"; fi; }',
      extractShellFunctionFromSource(src, "prepare_hermes_dashboard_home"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES_DASHBOARD_HOME=${shellQuote(dashboardHome)}`,
      `_HERMES_PYTHON=${shellQuote(fakePython)}`,
      `_HERMES_DASHBOARD_CONFIG_SEEDER=${shellQuote(path.join(tmpDir, "seed-dashboard-config.py"))}`,
      "STEP_DOWN_PREFIX_SANDBOX=(env NEMOCLAW_TEST_STEPPED_DOWN=1)",
      "prepare_hermes_dashboard_home sandbox:sandbox",
      `if [ -e ${shellQuote(path.join(dashboardHome, "gateway_state.json"))} ]; then echo gateway_state_exists=1; else echo gateway_state_exists=0; fi`,
      `cat ${shellQuote(logPath)}`,
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 10_000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runLockedParentStartupPreflight(parentMetadata: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-parent-preflight-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const mainStart = src.indexOf('if [ "$(id -u)" -eq 0 ]; then', src.indexOf("# ── Main"));
  const rootBranchEnd = src.indexOf("\nelif ", mainStart);
  expect(mainStart).toBeGreaterThanOrEqual(0);
  expect(rootBranchEnd).toBeGreaterThan(mainStart);
  const rootBranch = `${src.slice(mainStart, rootBranchEnd)}\nfi`;
  const [parentOwner, parentMode] = parentMetadata.split(" ");

  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'id() { [ "${1:-}" = "-u" ] && printf "0\\n" || command id "$@"; }',
      "recover_startup_hermes_mutation() { return 0; }",
      "hermes_restart_seal_orphaned() { return 1; }",
      "hermes_config_root_is_locked() { return 0; }",
      `stat() { case "\${2:-}" in '%U:%G') printf '%s\\n' ${shellQuote(parentOwner)} ;; '%a') printf '%s\\n' ${shellQuote(parentMode)} ;; *) return 1 ;; esac; }`,
      extractShellFunctionFromSource(src, "hermes_locked_parent_is_protected"),
      rootBranch,
      'printf "startup-continued\\n"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh config integrity", () => {
  it("verifies the strict Hermes hash through the sandbox identity in root mode", () => {
    const result = runHermesConfigIntegrityVerifierAsRoot(0);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/:stepped=1$/m);
    expect(result.stdout).toContain("result=success failure-code=internal");
  });

  it("classifies failed MCP integrity inspection as an MCP restart failure", () => {
    const result = runHermesConfigIntegrityVerifierAsRoot(1);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/:stepped=1$/m);
    expect(result.stdout).toContain("result=failure failure-code=mcp-integrity");
  });

  it("prepares root dashboard home and seeds config through the sandbox identity", {
    timeout: 15_000,
  }, () => {
    const result = runHermesDashboardHomePrepAsRoot();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("gateway_state_exists=0");
    expect(result.stdout).toContain("cmd=mkdir stepped=1");
    expect(result.stdout).toContain("cmd=chmod stepped=1");
    expect(result.stdout).toContain("cmd=rm stepped=1");
    expect(result.stdout).toContain("cmd=python stepped=1");
    expect(result.stdout).not.toContain("cmd=chown");
    expect(result.stdout).toContain("/config.yaml");
    expect(result.stdout).toContain("/.env");
  });

  it("continues locked startup only when /sandbox has the sticky root-owned posture", () => {
    const protectedParent = runLockedParentStartupPreflight("root:sandbox 1775");
    expect(protectedParent.status, protectedParent.stderr).toBe(0);
    expect(protectedParent.stdout).toContain("startup-continued");

    const unprotectedParent = runLockedParentStartupPreflight("sandbox:sandbox 755");
    expect(unprotectedParent.status).toBe(1);
    expect(unprotectedParent.stderr).toContain("HERMES_LOCKED_PARENT_UNPROTECTED");
    expect(unprotectedParent.stderr).toContain("trusted backup and recreate");
    expect(unprotectedParent.stderr).not.toContain("run shields up");
  });
});
