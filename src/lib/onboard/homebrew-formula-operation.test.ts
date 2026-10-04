// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSTALLER = path.resolve(import.meta.dirname, "../../../scripts/install-openshell.sh");
const FORMULA = 'class Openshell < Formula\n  version "test"\nend\n';
const FORMULA_SHA256 = createHash("sha256").update(FORMULA).digest("hex");

let fixtureRoot = "";
let formulaPath = "";
let logPath = "";

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-homebrew-operation-"));
  const fakeBin = path.join(fixtureRoot, "bin");
  const tap = path.join(fixtureRoot, "tap");
  formulaPath = path.join(tap, "Formula", "openshell.rb");
  logPath = path.join(fixtureRoot, "brew.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.dirname(formulaPath), { recursive: true });
  fs.writeFileSync(formulaPath, FORMULA);
  fs.writeFileSync(
    path.join(fakeBin, "brew"),
    `#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$NEMOCLAW_TEST_BREW_LOG"
case "$*" in
  "--repository nvidia/openshell") printf '%s\n' "$NEMOCLAW_TEST_BREW_TAP" ;;
  "--cellar") printf '%s\n' "$NEMOCLAW_TEST_BREW_CELLAR" ;;
  "help trust") exit "\${NEMOCLAW_TEST_TRUST_HELP_STATUS:-0}" ;;
  "help untrust") exit "\${NEMOCLAW_TEST_UNTRUST_HELP_STATUS:-0}" ;;
  "trust --formula nvidia/openshell/openshell") exit "\${NEMOCLAW_TEST_TRUST_STATUS:-0}" ;;
  "untrust --formula nvidia/openshell/openshell")
    count="$(cat "$NEMOCLAW_TEST_UNTRUST_COUNT" 2>/dev/null || printf 0)"
    count=$((count + 1))
    printf '%s\n' "$count" > "$NEMOCLAW_TEST_UNTRUST_COUNT"
    if [ "$count" -gt 1 ]; then
      exit "\${NEMOCLAW_TEST_UNTRUST_CLEANUP_STATUS:-0}"
    fi
    exit "\${NEMOCLAW_TEST_UNTRUST_STATUS:-0}"
    ;;
  "list --formula openshell"|"info --json=v2 openshell"|"services restart openshell"|"services stop openshell")
    exit "\${NEMOCLAW_TEST_OPERATION_STATUS:-0}"
    ;;
esac
exit 1
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function runOperation(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    [INSTALLER, "--homebrew-formula-operation", FORMULA_SHA256, "--", "brew", ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_TEST_BREW_CELLAR: path.join(fixtureRoot, "Cellar"),
        NEMOCLAW_TEST_BREW_LOG: logPath,
        NEMOCLAW_TEST_BREW_TAP: path.join(fixtureRoot, "tap"),
        NEMOCLAW_TEST_UNTRUST_COUNT: path.join(fixtureRoot, "untrust-count"),
        PATH: `${path.join(fixtureRoot, "bin")}:/usr/bin:/bin`,
        ...overrides,
      },
    },
  );
}

function brewEvents(): string[] {
  return fs.readFileSync(logPath, "utf8").trim().split("\n");
}

describe("OpenShell Homebrew formula operation boundary", () => {
  it.each([
    ["inspection", ["info", "--json=v2", "openshell"]],
    ["start", ["services", "restart", "openshell"]],
    ["stop", ["services", "stop", "openshell"]],
  ])("scopes formula trust to each %s operation (#7707)", (_case, args) => {
    const result = runOperation(args);

    expect(result.status, result.stderr).toBe(0);
    expect(brewEvents()).toEqual([
      "--repository nvidia/openshell",
      "help trust",
      "help untrust",
      "untrust --formula nvidia/openshell/openshell",
      "trust --formula nvidia/openshell/openshell",
      args.join(" "),
      "untrust --formula nvidia/openshell/openshell",
    ]);
  });

  it("distinguishes an absent formula from a legacy installation needing repair (#7707)", () => {
    fs.unlinkSync(formulaPath);
    const absent = runOperation(["list", "--formula", "openshell"]);
    fs.mkdirSync(path.join(fixtureRoot, "Cellar", "openshell"), { recursive: true });
    const legacy = runOperation(["list", "--formula", "openshell"]);

    expect(absent.status).toBe(65);
    expect(legacy.status).toBe(66);
  });

  it("rejects formula drift before granting trust (#7707)", () => {
    fs.appendFileSync(formulaPath, "# drift\n");
    const result = runOperation(["list", "--formula", "openshell"]);

    expect(result.status).toBe(66);
    expect(brewEvents()).toEqual(["--repository nvidia/openshell"]);
  });

  it("fails closed when temporary formula trust is refused (#7707)", () => {
    const result = runOperation(["list", "--formula", "openshell"], {
      NEMOCLAW_TEST_TRUST_STATUS: "1",
    });

    expect(result.status).toBe(67);
    expect(brewEvents()).not.toContain("list --formula openshell");
  });

  it.each([
    ["trust", "NEMOCLAW_TEST_TRUST_HELP_STATUS"],
    ["untrust", "NEMOCLAW_TEST_UNTRUST_HELP_STATUS"],
  ])("fails closed when Homebrew does not support formula %s (#7707)", (_command, variable) => {
    const result = runOperation(["list", "--formula", "openshell"], {
      [variable]: "1",
    });

    expect(result.status).toBe(67);
    expect(brewEvents()).not.toContain("list --formula openshell");
  });

  it("fails closed when temporary formula trust cannot be removed (#7707)", () => {
    const result = runOperation(["list", "--formula", "openshell"], {
      NEMOCLAW_TEST_UNTRUST_CLEANUP_STATUS: "1",
    });

    expect(result.status).toBe(68);
    expect(brewEvents().at(-1)).toBe("untrust --formula nvidia/openshell/openshell");
  });
});
