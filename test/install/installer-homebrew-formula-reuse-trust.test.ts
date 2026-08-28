// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const INSTALLER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/install-openshell.sh"),
  "utf8",
);
const TRUSTED_V00106_TEMPLATE_DIGESTS = [
  "139ad73792b019048b1d3bd9a8a7fbac56a354643aa1a4606115bdf1cc271fea",
  "1846d9051f4c588d0961d83107066521e436643ec95c13c0be43f298971139f1",
  "77d3abb360880c96a63424c4850ddb2e8db81b126bb7474a3b24fcde7844a3dd",
  "03215130365310e907390ceeb685088db6e75b963adf80c9c939de670381797c",
] as const;
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function removeHomebrewFormulaReuseRepair(source: string): string {
  const start = source.indexOf("macos_homebrew_formula_installed() {");
  const end = source.indexOf("\n\ndownload_openshell_formula() {", start);
  expect([start, end], "Homebrew formula reuse boundaries").not.toContain(-1);
  const replacement = `macos_homebrew_formula_installed() {
  [ "$OS" = "Darwin" ] || return 1
  command -v brew >/dev/null 2>&1 || return 1
  brew list --formula "$HOMEBREW_FORMULA_NAME" >/dev/null 2>&1 || return 1
  brew info --json=v2 "$HOMEBREW_FORMULA_NAME" 2>/dev/null \\
    | grep -Eq '"tap"[[:space:]]*:[[:space:]]*"nvidia/openshell"'
}`;
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`
    .replace(
      'warn "NemoClaw cannot confirm the Homebrew gateway formula for openshell $INSTALLED_VERSION_OUTPUT — installing OpenShell with Homebrew..."',
      'warn "openshell $INSTALLED_VERSION_OUTPUT is installed without the Homebrew gateway service — installing OpenShell with Homebrew..."',
    )
    .replace(
      'warn "NemoClaw cannot confirm the pinned Homebrew gateway formula for openshell $INSTALLED_VERSION — reinstalling pinned OpenShell ${PIN_VERSION} with Homebrew..."',
      'warn "openshell $INSTALLED_VERSION is installed without the Homebrew gateway service — reinstalling pinned OpenShell ${PIN_VERSION} with Homebrew..."',
    );
}

function addStringsPreflight(source: string): string {
  const marker = 'info "Detected $OS_LABEL ($ARCH_LABEL)"';
  expect(source.split(marker), "detected-platform marker").toHaveLength(2);
  return source.replace(
    marker,
    `${marker}
command -v strings >/dev/null 2>&1 \\
  || fail "'strings' (from binutils) is required to install and verify OpenShell. Install it first (Debian/Ubuntu: sudo apt-get install -y binutils) and retry."`,
  );
}

function restoreFlatInstallTestPaths(source: string): string {
  return source.replaceAll(
    "test/install/install-openshell-version-check.test.ts",
    "test/install-openshell-version-check.test.ts",
  );
}

function runTrustCheck(source: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-homebrew-reuse-trust-"));
  const installer = path.join(tempDir, "install-openshell.sh");
  tempDirs.push(tempDir);
  fs.writeFileSync(installer, source);
  return spawnSync(
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
}

describe("installer Homebrew formula reuse trust", () => {
  const previousTemplate = restoreFlatInstallTestPaths(INSTALLER_SOURCE);
  const baseTemplate = removeHomebrewFormulaReuseRepair(previousTemplate);
  const templates = [
    ["downstream", TRUSTED_V00106_TEMPLATE_DIGESTS[0], baseTemplate],
    ["strings preflight", TRUSTED_V00106_TEMPLATE_DIGESTS[1], addStringsPreflight(baseTemplate)],
    ["formula repair", TRUSTED_V00106_TEMPLATE_DIGESTS[2], previousTemplate],
    ["grouped install tests", TRUSTED_V00106_TEMPLATE_DIGESTS[3], INSTALLER_SOURCE],
  ] as const;

  it.each(templates)("accepts the %s template with digest %s", (_label, digest, source) => {
    const result = runTrustCheck(source);

    expect(result.status, result.stderr).toBe(0);
    const records = JSON.parse(result.stdout) as Array<{
      operationalTemplateSha256: string;
      source: string;
    }>;
    const installerTemplateDigests = new Set(
      records
        .filter((record) => record.source === "installer")
        .map((record) => record.operationalTemplateSha256),
    );
    expect(installerTemplateDigests).toEqual(new Set([digest]));
  });

  it("rejects an unlisted template", () => {
    const result = runTrustCheck(
      INSTALLER_SOURCE.replace(
        'info "Detected $OS_LABEL ($ARCH_LABEL)"',
        'info "Detected $OS_LABEL ($ARCH_LABEL)"\n# unlisted installer template',
      ),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installer operational template is not base-trusted");
  });
});
