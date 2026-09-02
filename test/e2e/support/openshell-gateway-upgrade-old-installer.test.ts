// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
const HISTORICAL_BUILD_CONTEXT_MODULES = Object.freeze({
  "v0.0.36": "src/lib/sandbox-build-context.ts",
  "v0.0.55": "src/lib/sandbox/build-context.ts",
  "v0.0.74": "src/lib/sandbox/build-context.ts",
  "v0.0.89": "src/lib/sandbox/build-context.ts",
});
const HISTORICAL_OPENCLAW_VERSIONS = Object.freeze({
  "v0.0.36": "2026.4.24",
  "v0.0.55": "2026.5.22",
  "v0.0.74": "2026.5.27",
  "v0.0.89": "2026.6.10",
});
const HISTORICAL_NEMOCLAW_COMMITS = Object.freeze({
  "v0.0.36": "3351fbdd4eb7d9b80ec471545083956327da2b10",
  "v0.0.55": "95d483fe2b6569d68e59493c60f19df09a068e8f",
  "v0.0.74": "3a05b54e8ec3e1d5550ec5c728de54af872bffe3",
  "v0.0.89": "1143aa5cce77f3bad1b3b5588bd7fddbe438237e",
});

type ReviewedHistoricalRef = keyof typeof HISTORICAL_BUILD_CONTEXT_MODULES;

function historicalFixtureIdentity(nemoclawRef: ReviewedHistoricalRef): {
  nemoclawCommit: string;
  nemoclawRef: ReviewedHistoricalRef;
  openclawVersion: string;
} {
  return {
    nemoclawCommit: HISTORICAL_NEMOCLAW_COMMITS[nemoclawRef],
    nemoclawRef,
    openclawVersion: HISTORICAL_OPENCLAW_VERSIONS[nemoclawRef],
  };
}

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
      "ARG OPENCLAW_VERSION=2026.5.27",
      ...Array.from({ length: advisoryAuditCount }, () => OLD_INSTALLER_ADVISORY_AUDIT.trimEnd()),
      "    npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit signatures; \\",
      "    true",
      "",
    ].join("\n"),
  );
  return writeInstallerHarness(sourceRoot);
}

function extractReviewedHistoricalSource(nemoclawRef: ReviewedHistoricalRef): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-old-upgrade-source-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);

  const archive = spawnSync("git", ["-C", REPO_ROOT, "archive", nemoclawRef], {
    maxBuffer: 128 * 1024 * 1024,
  });
  expect(archive.status, archive.stderr.toString()).toBe(0);
  const extract = spawnSync("tar", ["-xf", "-", "-C", sourceRoot], {
    input: archive.stdout,
    maxBuffer: 128 * 1024 * 1024,
  });
  expect(extract.status, extract.stderr.toString()).toBe(0);
  return sourceRoot;
}

function stageFrozenOptimizedBuildContext(
  sourceRoot: string,
  nemoclawRef: ReviewedHistoricalRef,
): string {
  const modulePath = path.join(sourceRoot, HISTORICAL_BUILD_CONTEXT_MODULES[nemoclawRef]);
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

function runReviewedHistoricalFixture(nemoclawRef: ReviewedHistoricalRef): string {
  const fixture = writeInstallerHarness(extractReviewedHistoricalSource(nemoclawRef));
  patchOldInstallerFixture(fixture.installer, historicalFixtureIdentity(nemoclawRef));

  const result = spawnSync("bash", [fixture.installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
      NEMOCLAW_OLD_OPENCLAW_VERSION: HISTORICAL_OPENCLAW_VERSIONS[nemoclawRef],
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
    `test "$(openclaw --version | awk '{print $2}')" = "${HISTORICAL_OPENCLAW_VERSIONS[nemoclawRef]}"`,
  );

  const stagedContext = stageFrozenOptimizedBuildContext(fixture.sourceRoot, nemoclawRef);
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
  it.each([
    "v0.0.36",
    "v0.0.55",
  ] as const)("accepts the reviewed %s profile without an advisory audit", (nemoclawRef) => {
    const dockerfile = runReviewedHistoricalFixture(nemoclawRef);
    expect(dockerfile).not.toContain("audit --omit=dev --audit-level=low");
    expect(dockerfile).not.toContain(
      "Skipping current advisory audit for the immutable historical mcporter lock",
    );
  }, 30_000);

  it.each([
    "v0.0.74",
    "v0.0.89",
  ] as const)("accepts the reviewed %s advisory and signature audit boundary", (nemoclawRef) => {
    const dockerfile = runReviewedHistoricalFixture(nemoclawRef);
    expect(dockerfile).not.toContain("audit --omit=dev --audit-level=low");
    expect(dockerfile).toContain(
      "Skipping current advisory audit for the immutable historical mcporter lock",
    );
    expect(dockerfile).toContain("audit signatures");
  }, 30_000);

  it("rejects an ambiguous historical advisory boundary", () => {
    const fixture = writeHistoricalFixture(2);
    patchOldInstallerFixture(fixture.installer, historicalFixtureIdentity("v0.0.74"));
    const originalDockerfile = fs.readFileSync(fixture.dockerfile, "utf8");

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
        NEMOCLAW_OLD_OPENCLAW_VERSION: "2026.5.27",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("historical mcporter advisory audits; expected 1");
    expect(fs.readFileSync(fixture.dockerfile, "utf8")).toBe(originalDockerfile);
  });

  it("rejects a missing historical advisory boundary", () => {
    const fixture = writeHistoricalFixture(0);
    patchOldInstallerFixture(fixture.installer, historicalFixtureIdentity("v0.0.74"));
    const originalDockerfile = fs.readFileSync(fixture.dockerfile, "utf8");

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
        NEMOCLAW_OLD_OPENCLAW_VERSION: "2026.5.27",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("found 0 historical mcporter advisory audits; expected 1");
    expect(fs.readFileSync(fixture.dockerfile, "utf8")).toBe(originalDockerfile);
  });

  it("rejects an advisory audit in a profile that predates the audit", () => {
    const fixture = writeHistoricalFixture(1);
    patchOldInstallerFixture(fixture.installer, historicalFixtureIdentity("v0.0.36"));
    const originalDockerfile = fs.readFileSync(fixture.dockerfile, "utf8");

    const result = spawnSync("bash", [fixture.installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_OLD_OPENCLAW_ARCHIVE: fixture.archive,
        NEMOCLAW_OLD_OPENCLAW_VERSION: "2026.4.24",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("found 1 historical mcporter advisory audits; expected 0");
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
    ).toThrow(/exact reviewed ref\/commit\/OpenClaw profile/u);
    expect(fs.readFileSync(fixture.installer, "utf8")).toBe(originalInstaller);
  });

  it("rejects a mixed historical installer profile", () => {
    const fixture = writeHistoricalFixture();
    const originalInstaller = fs.readFileSync(fixture.installer, "utf8");

    expect(() =>
      patchOldInstallerFixture(fixture.installer, {
        ...historicalFixtureIdentity("v0.0.55"),
        nemoclawCommit: HISTORICAL_NEMOCLAW_COMMITS["v0.0.36"],
      }),
    ).toThrow(/exact reviewed ref\/commit\/OpenClaw profile/u);
    expect(fs.readFileSync(fixture.installer, "utf8")).toBe(originalInstaller);
  });

  it.each([
    [
      "2026.4.24",
      "sha512-W6u4XeIIP4+uG4DYV9G3JeS6QNuKwfhQIej1GIoL4BdcnUFgrnB8kHYNXL3MxiHRKuhZB9OYwUMGs8jKFZR/Vg==",
    ],
    [
      "2026.5.22",
      "sha512-m+zgBELGbCHjWB1IWF5WSWNPr480cMKOMff2OF72c8A0AMD4hC/9+qwYtzjYmGkETcffnB711JymlVsQnh2Tow==",
    ],
    [
      "2026.5.27",
      "sha512-2N93zhdAo88KAbHt6T7KvYXf4s7XIkYXBgv1npYpn7e1Y9FvrtgtpsA38my9rtFW+70uXEojRPX5/OqnuDqJPw==",
    ],
    [
      "2026.6.10",
      "sha512-LcooND2tBQw8A+kc1Ujltu3lg30bJ0w7XaeRy7eYzobb8BBdcW6DOGbwJL4vpj1vl9+gjRceOtlh5nh9OARcug==",
    ],
  ])("binds historical OpenClaw %s to its reviewed archive", (version, expectedIntegrity) => {
    expect(reviewedOldOpenClawArchive(version)).toEqual({
      expectedIntegrity,
      label: `historical fixture OpenClaw ${version}`,
      packageSpec: `openclaw@${version}`,
      tarballUrl: `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`,
    });
  });

  it("rejects an unreviewed historical OpenClaw version", () => {
    expect(() => reviewedOldOpenClawArchive("2026.5.28")).toThrow(/no reviewed archive pin/);
  });
});
