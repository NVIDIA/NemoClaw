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
  "5d4cdb2db60df7539193b486ac15bb9be96ec1d40fc0f739a94d4d2f0bf597a0",
  "e850e927aab619d52c5de72967137569d65dd7fa669920c7c5b558f0770140d1",
  "e7d51536442b217e3d5e77c4ba3b7c25e6a74898bf22523f7fb58627d34329cb",
  "18175cf47a0fece8ce75e5d523185062c7a7c913a3f4ceafbba4a7ca4df7c69b",
  "293f45ea1d54e1531c3a070123c04b47f972f29504bd8902a44ab71acdfe6cca",
  "ee3db19d06d34a625bff9e0ab021f095ce97eadf5f7a98fc60def62af87577ad",
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

function selectDevMuslSandboxTemplate(source: string): string {
  const grouped = `    case "$ARCH_LABEL" in
      x86_64)
        ASSETS+=("openshell-gateway-x86_64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz")
        ;;
      aarch64)
        ASSETS+=("openshell-gateway-aarch64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz")
        ;;
    esac`;
  const devMusl = `    SANDBOX_LIBC="gnu"
    if [ "$RESOLVED_CHANNEL" = "dev" ]; then
      SANDBOX_LIBC="musl"
    fi
    case "$ARCH_LABEL" in
      x86_64)
        ASSETS+=("openshell-gateway-x86_64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-x86_64-unknown-linux-\${SANDBOX_LIBC}.tar.gz")
        ;;
      aarch64)
        ASSETS+=("openshell-gateway-aarch64-unknown-linux-gnu.tar.gz")
        ASSETS+=("openshell-sandbox-aarch64-unknown-linux-\${SANDBOX_LIBC}.tar.gz")
        ;;
    esac`;
  const selected = source.replace(grouped, devMusl);
  expect(selected, "grouped GNU sandbox asset selection").not.toBe(source);
  return selected;
}

function bindMacosInstallMethod(source: string): string {
  const marker = `HOMEBREW_TAP="nvidia/openshell"
HOMEBREW_FORMULA_NAME="openshell"`;
  const methodBinding = `${marker}
MACOS_INSTALL_METHOD="\${_NEMOCLAW_OPENSHELL_INSTALL_METHOD:-auto}"
case "$MACOS_INSTALL_METHOD" in
  auto) ;;
  homebrew)
    [ "$OS" = "Darwin" ] || fail "The Homebrew OpenShell installation method is valid only on macOS."
    command -v brew >/dev/null 2>&1 \\
      || fail "The selected Homebrew OpenShell installation method became unavailable before installation."
    ;;
  standalone)
    [ "$OS" = "Darwin" ] || fail "The standalone macOS OpenShell installation method is valid only on macOS."
    ! command -v brew >/dev/null 2>&1 \\
      || fail "Homebrew appeared after standalone OpenShell installation was selected; refusing an ambiguous installation method."
    ;;
  *) fail "The internal macOS OpenShell installation method is invalid." ;;
esac`;
  expect(source.split(marker), "Homebrew install-method marker").toHaveLength(2);
  return source.replace(marker, methodBinding);
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

function expectTrustedTemplate(source: string, digest: string): void {
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
}

describe("installer Homebrew formula reuse trust", () => {
  const previousTemplate = restoreFlatInstallTestPaths(INSTALLER_SOURCE);
  const baseTemplate = removeHomebrewFormulaReuseRepair(previousTemplate);
  const prospectiveDevMuslTemplate = selectDevMuslSandboxTemplate(INSTALLER_SOURCE);
  const templates = [
    ["downstream", baseTemplate, TRUSTED_V00106_TEMPLATE_DIGESTS[0]],
    ["strings preflight", addStringsPreflight(baseTemplate), TRUSTED_V00106_TEMPLATE_DIGESTS[1]],
    ["formula repair", previousTemplate, TRUSTED_V00106_TEMPLATE_DIGESTS[2]],
    ["grouped install tests", INSTALLER_SOURCE, TRUSTED_V00106_TEMPLATE_DIGESTS[3]],
    ["dev MUSL sandbox", prospectiveDevMuslTemplate, TRUSTED_V00106_TEMPLATE_DIGESTS[4]],
    [
      "dev MUSL sandbox with flat test paths",
      restoreFlatInstallTestPaths(prospectiveDevMuslTemplate),
      TRUSTED_V00106_TEMPLATE_DIGESTS[5],
    ],
    ["method-bound downstream", bindMacosInstallMethod(baseTemplate), TRUSTED_V00106_TEMPLATE_DIGESTS[6]],
    [
      "method-bound strings preflight",
      bindMacosInstallMethod(addStringsPreflight(baseTemplate)),
      TRUSTED_V00106_TEMPLATE_DIGESTS[7],
    ],
    [
      "method-bound formula repair",
      bindMacosInstallMethod(previousTemplate),
      TRUSTED_V00106_TEMPLATE_DIGESTS[8],
    ],
    [
      "method-bound grouped install tests",
      bindMacosInstallMethod(INSTALLER_SOURCE),
      TRUSTED_V00106_TEMPLATE_DIGESTS[9],
    ],
  ] as const;

  // source-shape-contract: security -- Exact current, historical, and prospective installer bytes must be base-authorized before trusted CI can admit either dependent runtime change
  it.each(templates)(
    "accepts the reviewed %s OpenShell 0.0.106 installer template",
    (_label, source, digest) => {
      expect(INSTALLER_SOURCE).toContain('HOMEBREW_FORMULA_NAME="openshell"');
      expectTrustedTemplate(source, digest);
    },
  );

  // source-shape-contract: security -- An unreviewed installer byte change must fail before pull request code can authorize its own operational template
  it("rejects an unlisted OpenShell 0.0.106 installer template", () => {
    expect(INSTALLER_SOURCE).toContain('info "Detected $OS_LABEL ($ARCH_LABEL)"');
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
