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
const TRUSTED_V00116_TEMPLATE_DIGEST =
  "24cb9e67b855e8a69df32aae992f4756ef2b29bcdc7846ef57bcfeacb3c1a9a3";
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function runTrustCheck(source: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-homebrew-reuse-trust-"));
  const installer = path.join(tempDir, "install-openshell.sh");
  tempDirs.push(tempDir);
  fs.writeFileSync(installer, source);
  return spawnSync(
    process.execPath,
    [
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
  const supersededV00106Template = INSTALLER_SOURCE.replace(
    'MIN_VERSION="0.0.116"',
    'MIN_VERSION="0.0.106"',
  )
    .replace('MAX_VERSION="0.0.116"', 'MAX_VERSION="0.0.106"')
    .replace('DEV_MIN_VERSION="0.0.116"', 'DEV_MIN_VERSION="0.0.106"');
  const untrustedTemplate = INSTALLER_SOURCE.replace(
    'info "Detected $OS_LABEL ($ARCH_LABEL)"',
    'info "Detected $OS_LABEL ($ARCH_LABEL)"\n# unlisted installer template',
  );

  // source-shape-contract: security -- Exact current installer bytes must be base-authorized before trusted CI can admit the dependent runtime change
  it("accepts only the reviewed OpenShell 0.0.116 installer template", () => {
    expect(INSTALLER_SOURCE).toContain('MIN_VERSION="0.0.116"');
    expect(INSTALLER_SOURCE).toContain('MAX_VERSION="0.0.116"');
    expectTrustedTemplate(INSTALLER_SOURCE, TRUSTED_V00116_TEMPLATE_DIGEST);
  });

  it("rejects an unreviewed mutation of the OpenShell 0.0.116 installer template", () => {
    const result = runTrustCheck(untrustedTemplate);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installer operational template is not base-trusted");
  });

  it("rejects the superseded OpenShell 0.0.106 installer path", () => {
    const result = runTrustCheck(supersededV00106Template);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "installer pin-table release 0.0.116 must match installer MIN_VERSION 0.0.106",
    );
  });
});
