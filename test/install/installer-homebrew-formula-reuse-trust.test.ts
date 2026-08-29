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
  "293f45ea1d54e1531c3a070123c04b47f972f29504bd8902a44ab71acdfe6cca",
  "ee3db19d06d34a625bff9e0ab021f095ce97eadf5f7a98fc60def62af87577ad",
  "4b45161017a5936331300e982168160575701632711328cbbb97480eb087fb51",
] as const;
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function restoreFlatInstallTestPaths(source: string): string {
  return source.replaceAll(
    "test/install/install-openshell-version-check.test.ts",
    "test/install-openshell-version-check.test.ts",
  );
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
  const methodBoundTemplate = bindMacosInstallMethod(INSTALLER_SOURCE);
  const trustedTemplates = [
    ["dev MUSL sandbox", INSTALLER_SOURCE, TRUSTED_V00106_TEMPLATE_DIGESTS[0]],
    [
      "dev MUSL sandbox with flat test paths",
      restoreFlatInstallTestPaths(INSTALLER_SOURCE),
      TRUSTED_V00106_TEMPLATE_DIGESTS[1],
    ],
    ["method-bound dev MUSL sandbox", methodBoundTemplate, TRUSTED_V00106_TEMPLATE_DIGESTS[2]],
  ] as const;
  const untrustedTemplates = [
    [
      "method-bound dev MUSL sandbox with flat test paths",
      bindMacosInstallMethod(restoreFlatInstallTestPaths(INSTALLER_SOURCE)),
    ],
    [
      "mutated dev MUSL sandbox",
      INSTALLER_SOURCE.replace(
        'info "Detected $OS_LABEL ($ARCH_LABEL)"',
        'info "Detected $OS_LABEL ($ARCH_LABEL)"\n# unlisted installer template',
      ),
    ],
  ] as const;

  // source-shape-contract: security -- Exact current and successor installer bytes must be base-authorized before trusted CI can admit the dependent runtime change
  it.each(trustedTemplates)(
    "accepts the reviewed %s OpenShell 0.0.106 installer template",
    (_label, source, digest) => {
      expect(INSTALLER_SOURCE).toContain(
        'if [ "$RESOLVED_CHANNEL" = "dev" ]; then\n      SANDBOX_LIBC="musl"',
      );
      expectTrustedTemplate(source, digest);
    },
  );

  it.each(untrustedTemplates)(
    "rejects the unreviewed %s OpenShell 0.0.106 installer template",
    (_label, source) => {
      const result = runTrustCheck(source);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("installer operational template is not base-trusted");
    },
  );
});
