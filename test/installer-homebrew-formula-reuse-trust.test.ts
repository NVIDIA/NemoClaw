// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function applyHomebrewFormulaReuseRepair(source: string): string {
  const start = source.indexOf("macos_homebrew_formula_installed() {");
  const end = source.indexOf("\n\ndownload_openshell_formula() {", start);
  expect([start, end], "Homebrew formula reuse boundaries").not.toContain(-1);
  const replacement = `macos_homebrew_formula_installed() {
  local formula_info formula_operation_pin
  [ "$OS" = "Darwin" ] || return 1
  command -v brew >/dev/null 2>&1 || return 1
  if [ "$RELEASE_TAG" = "dev" ]; then
    formula_operation_pin="unverified-dev"
  else
    formula_operation_pin="$(openshell_pinned_sha256 "$RELEASE_TAG" "openshell.rb")" \\
      || return 1
  fi
  run_trusted_openshell_homebrew_operation "$formula_operation_pin" -- \\
    brew list --formula "$HOMEBREW_FORMULA_NAME" >/dev/null 2>&1 \\
    || return 1
  formula_info="$(run_trusted_openshell_homebrew_operation "$formula_operation_pin" -- \\
    brew info --json=v2 "$HOMEBREW_FORMULA_NAME" 2>/dev/null)" \\
    || return 1
  printf '%s\\n' "$formula_info" \\
    | grep -Eq '"tap"[[:space:]]*:[[:space:]]*"nvidia/openshell"'
}`;
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`
    .replace(
      'warn "openshell $INSTALLED_VERSION_OUTPUT is installed without the Homebrew gateway service — installing OpenShell with Homebrew..."',
      'warn "NemoClaw cannot confirm the Homebrew gateway formula for openshell $INSTALLED_VERSION_OUTPUT — installing OpenShell with Homebrew..."',
    )
    .replace(
      'warn "openshell $INSTALLED_VERSION is installed without the Homebrew gateway service — reinstalling pinned OpenShell ${PIN_VERSION} with Homebrew..."',
      'warn "NemoClaw cannot confirm the pinned Homebrew gateway formula for openshell $INSTALLED_VERSION — reinstalling pinned OpenShell ${PIN_VERSION} with Homebrew..."',
    );
}

describe("installer Homebrew formula reuse trust", () => {
  it("accepts the exact repair template", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-homebrew-reuse-trust-"));
    const installer = path.join(tempDir, "install-openshell.sh");
    tempDirs.push(tempDir);
    fs.writeFileSync(
      installer,
      applyHomebrewFormulaReuseRepair(
        fs.readFileSync(path.join(REPO_ROOT, "scripts/install-openshell.sh"), "utf8"),
      ),
    );

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(REPO_ROOT, "scripts/checks/extract-installer-pins.mts"),
        "--blueprint",
        path.join(REPO_ROOT, "nemoclaw-blueprint/blueprint.yaml"),
        "--installer",
        installer,
        "--brev-installer",
        path.join(REPO_ROOT, "scripts/brev-launchable-ci-cpu.sh"),
        "--supervisor-runtime",
        path.join(REPO_ROOT, "src/lib/onboard/docker-driver-gateway-runtime.ts"),
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
