// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "scripts", "install-openshell.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function addReviewedStringsPreflight(source: string): string {
  const marker = 'info "Detected $OS_LABEL ($ARCH_LABEL)"\n';
  expect(source).toContain(marker);
  const preflight = [
    marker.trimEnd(),
    "command -v strings >/dev/null 2>&1 \\",
    "  || fail \"'strings' (from binutils) is required to install and verify OpenShell. Install it first (Debian/Ubuntu: sudo apt-get install -y binutils) and retry.\"",
    "",
  ].join("\n");
  return source.replace(marker, preflight);
}

function inspectInstaller(source: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-template-trust-"));
  const installer = path.join(tempDir, "install-openshell.sh");
  tempDirs.push(tempDir);
  fs.writeFileSync(installer, source);
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(REPO_ROOT, "scripts", "checks", "extract-installer-pins.mts"),
      "--blueprint",
      path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml"),
      "--installer",
      installer,
      "--brev-installer",
      path.join(REPO_ROOT, "scripts", "brev-launchable-ci-cpu.sh"),
      "--supervisor-runtime",
      path.join(REPO_ROOT, "src", "lib", "onboard", "docker-driver-gateway-runtime.ts"),
      "--format",
      "release-tsv",
    ],
    { encoding: "utf8" },
  );
}

describe("installer operational-template trust", () => {
  it("accepts the reviewed early strings dependency check (#9705)", () => {
    const source = addReviewedStringsPreflight(fs.readFileSync(INSTALLER, "utf8"));
    const result = inspectInstaller(source);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("rejects a bypass of the reviewed early strings dependency check (#9705)", () => {
    const source = addReviewedStringsPreflight(fs.readFileSync(INSTALLER, "utf8")).replace(
      "command -v strings",
      "command -v true",
    );
    const result = inspectInstaller(source);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installer operational template is not base-trusted");
  });
});
