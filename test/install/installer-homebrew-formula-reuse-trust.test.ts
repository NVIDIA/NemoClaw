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
const TRUSTED_V00106_DEV_MUSL_TEMPLATE_DIGESTS = [
  "293f45ea1d54e1531c3a070123c04b47f972f29504bd8902a44ab71acdfe6cca",
  "ee3db19d06d34a625bff9e0ab021f095ce97eadf5f7a98fc60def62af87577ad",
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
  // source-shape-contract: security -- Exact prospective installer bytes must be base-authorized before trusted CI can admit the dependent runtime change
  it("accepts the prospective dev MUSL sandbox template with its trusted digest", () => {
    const prospectiveTemplate = INSTALLER_SOURCE;
    expect(prospectiveTemplate).toContain(
      'if [ "$RESOLVED_CHANNEL" = "dev" ]; then\n      SANDBOX_LIBC="musl"',
    );
    expectTrustedTemplate(prospectiveTemplate, TRUSTED_V00106_DEV_MUSL_TEMPLATE_DIGESTS[0]);
    expectTrustedTemplate(
      restoreFlatInstallTestPaths(prospectiveTemplate),
      TRUSTED_V00106_DEV_MUSL_TEMPLATE_DIGESTS[1],
    );
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
