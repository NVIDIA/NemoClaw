// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEWED_GATEWAY_UPGRADE_FIXTURE } from "../../../tools/e2e/openshell-gateway-upgrade-fixture.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  OLD_INSTALLER_ADVISORY_AUDIT,
  OLD_INSTALLER_ARCHIVE_CONTEXT_PATH,
  OLD_INSTALLER_BOOTSTRAP_NEEDLE,
  OLD_INSTALLER_CLONE_NEEDLE,
  patchOldInstallerFixture,
  reviewedOldOpenClawArchive,
} from "../live/openshell-gateway-upgrade-old-installer.ts";

const temporaryDirectories: string[] = [];
const HISTORICAL_BUILD_CONTEXT_MODULE = "src/lib/sandbox/build-context.ts";

function writeInstallerHarness(sourceRoot: string): {
  archive: string;
  dockerfile: string;
  installer: string;
  sourceRoot: string;
} {
  const root = path.dirname(sourceRoot);
  const dockerfile = path.join(sourceRoot, "Dockerfile");
  const archive = path.join(root, "reviewed-openclaw.tgz");
  const payload = path.join(root, "payload.sh");
  const installer = path.join(root, "install.sh");
  fs.writeFileSync(archive, "reviewed fixture archive");

  fs.writeFileSync(
    payload,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `nemoclaw_src=${JSON.stringify(sourceRoot)}`,
      "_CLI_DISPLAY=NemoClaw",
      "release_ref=fixture",
      'spin() { shift; "$@"; }',
      "clone_nemoclaw_ref() { :; }",
      OLD_INSTALLER_CLONE_NEEDLE.trimEnd(),
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    installer,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `payload_script=${JSON.stringify(payload)}`,
      `source_root=${JSON.stringify(sourceRoot)}`,
      OLD_INSTALLER_BOOTSTRAP_NEEDLE.trimEnd(),
      '"$payload_script"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return { archive, dockerfile, installer, sourceRoot };
}

function writeHistoricalFixture(advisoryAuditCount = 1): {
  archive: string;
  dockerfile: string;
  installer: string;
  sourceRoot: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-old-upgrade-installer-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(path.join(sourceRoot, "nemoclaw", "src"), { recursive: true });

  fs.writeFileSync(
    path.join(sourceRoot, "Dockerfile"),
    [
      "FROM fixture",
      `ARG OPENCLAW_VERSION=${REVIEWED_GATEWAY_UPGRADE_FIXTURE.openclawVersion}`,
      ...Array.from({ length: advisoryAuditCount }, () => OLD_INSTALLER_ADVISORY_AUDIT.trimEnd()),
      "    npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit signatures; \\",
      "    true",
      "",
    ].join("\n"),
  );
  return writeInstallerHarness(sourceRoot);
}

function extractReviewedHistoricalSource(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-old-upgrade-source-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);

  const archive = spawnSync(
    "git",
    ["-C", REPO_ROOT, "archive", REVIEWED_GATEWAY_UPGRADE_FIXTURE.nemoclawRef],
    {
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  expect(archive.status, archive.stderr.toString()).toBe(0);
  const extract = spawnSync("tar", ["-xf", "-", "-C", sourceRoot], {
    input: archive.stdout,
    maxBuffer: 128 * 1024 * 1024,
  });
  expect(extract.status, extract.stderr.toString()).toBe(0);
  return sourceRoot;
}

function stageFrozenOptimizedBuildContext(sourceRoot: string): string {
  const modulePath = path.join(sourceRoot, HISTORICAL_BUILD_CONTEXT_MODULE);
  const outputPath = path.join(path.dirname(sourceRoot), "staged-context-path.txt");
  const runner = String.raw`
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[1];
const sourceRoot = process.argv[2];
const temporaryRoot = process.argv[3];
const outputPath = process.argv[4];
const buildContext = await import(pathToFileURL(modulePath).href);
const staged = buildContext.stageOptimizedSandboxBuildContext(sourceRoot, temporaryRoot);
writeFileSync(outputPath, staged.buildCtx);
`;
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      runner,
      modulePath,
      sourceRoot,
      path.dirname(sourceRoot),
      outputPath,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(outputPath, "utf8");
}

function runReviewedHistoricalFixture(): string {
  const fixture = writeInstallerHarness(extractReviewedHistoricalSource());
  patchOldInstallerFixture(fixture.installer, REVIEWED_GATEWAY_UPGRADE_FIXTURE);

  const result = spawnSync("bash", [fixture.installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
      NEMOCLAW_OLD_OPENCLAW_VERSION: REVIEWED_GATEWAY_UPGRADE_FIXTURE.openclawVersion,
    },
  });
  expect(result.status, result.stderr).toBe(0);

  const dockerfile = fs.readFileSync(fixture.dockerfile, "utf8");
  const archiveContextPath = path.join(fixture.sourceRoot, OLD_INSTALLER_ARCHIVE_CONTEXT_PATH);
  expect(fs.readFileSync(archiveContextPath, "utf8")).toBe("reviewed fixture archive");
  expect(dockerfile).toContain(
    `COPY ${OLD_INSTALLER_ARCHIVE_CONTEXT_PATH} /tmp/nemoclaw-e2e-old-openclaw.tgz`,
  );
  expect(dockerfile).toContain(
    "npm install -g --ignore-scripts --no-audit --no-fund --no-progress /tmp/nemoclaw-e2e-old-openclaw.tgz",
  );
  expect(dockerfile).toContain(
    `test "$(openclaw --version | awk '{print $2}')" = "${REVIEWED_GATEWAY_UPGRADE_FIXTURE.openclawVersion}"`,
  );

  const stagedContext = stageFrozenOptimizedBuildContext(fixture.sourceRoot);
  expect(
    fs.readFileSync(path.join(stagedContext, OLD_INSTALLER_ARCHIVE_CONTEXT_PATH), "utf8"),
  ).toBe("reviewed fixture archive");
  return dockerfile;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("historical OpenShell gateway upgrade installer adapter", () => {
  it("accepts the retained fixture advisory and signature audit boundary", () => {
    const dockerfile = runReviewedHistoricalFixture();
    expect(dockerfile).not.toContain("audit --omit=dev --audit-level=low");
    expect(dockerfile).toContain(
      "Skipping current advisory audit for the immutable historical mcporter lock",
    );
    expect(dockerfile).toContain("audit signatures");
  }, 30_000);

  it("rejects an ambiguous historical advisory boundary", () => {
    const fixture = writeHistoricalFixture(2);
    patchOldInstallerFixture(fixture.installer, REVIEWED_GATEWAY_UPGRADE_FIXTURE);
    const originalDockerfile = fs.readFileSync(fixture.dockerfile, "utf8");

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
        NEMOCLAW_OLD_OPENCLAW_VERSION: REVIEWED_GATEWAY_UPGRADE_FIXTURE.openclawVersion,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("historical mcporter advisory audits; expected 1");
    expect(fs.readFileSync(fixture.dockerfile, "utf8")).toBe(originalDockerfile);
  });

  it("rejects a missing historical advisory boundary", () => {
    const fixture = writeHistoricalFixture(0);
    patchOldInstallerFixture(fixture.installer, REVIEWED_GATEWAY_UPGRADE_FIXTURE);
    const originalDockerfile = fs.readFileSync(fixture.dockerfile, "utf8");

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
        NEMOCLAW_OLD_OPENCLAW_VERSION: REVIEWED_GATEWAY_UPGRADE_FIXTURE.openclawVersion,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("found 0 historical mcporter advisory audits; expected 1");
    expect(fs.readFileSync(fixture.dockerfile, "utf8")).toBe(originalDockerfile);
  });

  it("rejects an unreviewed historical installer profile", () => {
    const fixture = writeHistoricalFixture();
    const originalInstaller = fs.readFileSync(fixture.installer, "utf8");

    expect(() =>
      patchOldInstallerFixture(fixture.installer, {
        nemoclawCommit: "4".repeat(40),
        nemoclawRef: "v0.0.75",
        openclawVersion: "2026.5.28",
      }),
    ).toThrow(/reviewed descriptor/u);
    expect(fs.readFileSync(fixture.installer, "utf8")).toBe(originalInstaller);
  });

  it("binds the retained historical OpenClaw version to its reviewed archive", () => {
    expect(reviewedOldOpenClawArchive(REVIEWED_GATEWAY_UPGRADE_FIXTURE.openclawVersion)).toBe(
      REVIEWED_GATEWAY_UPGRADE_FIXTURE.openClawArchive,
    );
  });

  it("rejects an unreviewed historical OpenClaw version", () => {
    expect(() => reviewedOldOpenClawArchive("2026.5.28")).toThrow(/no reviewed archive pin/);
  });
});
