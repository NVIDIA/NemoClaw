// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const BOOTSTRAP = path.join(
  REPO_ROOT,
  ".github",
  "actions",
  "setup-reviewed-npm",
  "verify-and-install-npm.sh",
);

function identity(archive: Buffer): Record<string, string> {
  return {
    npmArchiveSha256: createHash("sha256").update(archive).digest("hex"),
    npmIntegrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    npmVersion: "12.0.2",
  };
}

type BootstrapFixtureOptions = {
  archive: string;
  archiveManifest?: "invalid" | "matching" | "mismatched" | "missing";
  environment?: NodeJS.ProcessEnv;
  installedVersion?: string;
  mutateIdentity?: (identity: Record<string, string>) => Record<string, string>;
};

function createArchive(
  root: string,
  contents: string,
  manifest: NonNullable<BootstrapFixtureOptions["archiveManifest"]>,
): string {
  const packageRoot = path.join(root, "package");
  const archiveFile = path.join(root, "fixture.tgz");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "README.md"), contents);
  const writeManifest = {
    invalid: () => fs.writeFileSync(path.join(packageRoot, "package.json"), "{invalid json\n"),
    matching: () =>
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"version":"12.0.2"}\n'),
    mismatched: () =>
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"version":"12.0.3"}\n'),
    missing: () => undefined,
  } satisfies Record<NonNullable<BootstrapFixtureOptions["archiveManifest"]>, () => unknown>;
  writeManifest[manifest]();
  const packed = spawnSync("tar", ["-czf", archiveFile, "-C", root, "package"], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  return archiveFile;
}

function runBootstrapFixture(options: BootstrapFixtureOptions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-bootstrap-"));
  const bin = path.join(root, "bin");
  const npmLog = path.join(root, "npm.log");
  const installMarker = path.join(root, "install-called");
  const identityPath = path.join(root, "reviewed-npm-audit.json");
  const archiveFile = createArchive(root, options.archive, options.archiveManifest ?? "matching");
  const reviewedIdentity = identity(fs.readFileSync(archiveFile));

  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NEMOCLAW_TEST_NPM_LOG"
case "$1" in
  pack)
    pack_args="$*"
    shift
    download_dir=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--pack-destination" ]; then
        download_dir="$2"
        break
      fi
      shift
    done
    [ -n "$download_dir" ]
    [ "$pack_args" = "pack npm@12.0.2 --pack-destination $download_dir --userconfig /dev/null --registry https://registry.npmjs.org/ --ignore-scripts --no-audit --no-fund" ]
    cp "$NEMOCLAW_TEST_ARCHIVE_FILE" "$download_dir/npm-12.0.2.tgz"
    ;;
  install)
    : > "$NEMOCLAW_TEST_INSTALL_MARKER"
    ;;
  --version)
    printf '%s\\n' "$NEMOCLAW_TEST_INSTALLED_VERSION"
    ;;
  *)
    exit 2
    ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    identityPath,
    `${JSON.stringify(options.mutateIdentity?.(reviewedIdentity) ?? reviewedIdentity)}\n`,
  );
  const result = spawnSync("bash", [BOOTSTRAP, identityPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.environment,
      NEMOCLAW_TEST_ARCHIVE_FILE: archiveFile,
      NEMOCLAW_TEST_INSTALL_MARKER: installMarker,
      NEMOCLAW_TEST_INSTALLED_VERSION: options.installedVersion ?? "12.0.2",
      NEMOCLAW_TEST_NPM_LOG: npmLog,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
    },
  });
  return {
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    installCalled: fs.existsSync(installMarker),
    npmInvocations: fs.existsSync(npmLog) ? fs.readFileSync(npmLog, "utf8").trim().split("\n") : [],
    result,
  };
}

describe("reviewed npm bootstrap", () => {
  const archive = "verified archive\n";

  it.each([
    [
      "malformed version",
      { mutateIdentity: (identity) => ({ ...identity, npmVersion: "12.x" }) },
      "invalid npmVersion",
      0,
    ],
    [
      "malformed SRI",
      { mutateIdentity: (identity) => ({ ...identity, npmIntegrity: "invalid" }) },
      "invalid npmIntegrity",
      0,
    ],
    [
      "malformed SHA-256",
      { mutateIdentity: (identity) => ({ ...identity, npmArchiveSha256: "invalid" }) },
      "invalid npmArchiveSha256",
      0,
    ],
    [
      "SHA-256 mismatch",
      { mutateIdentity: (identity) => ({ ...identity, npmArchiveSha256: "0".repeat(64) }) },
      "archive integrity mismatch",
      1,
    ],
    [
      "SHA-512 SRI mismatch",
      {
        mutateIdentity: (identity) => ({
          ...identity,
          npmIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        }),
      },
      "archive integrity mismatch",
      1,
    ],
    ["archive version mismatch", { archiveManifest: "mismatched" }, "archive version 12.0.3", 1],
    ["missing archive metadata", { archiveManifest: "missing" }, "is missing or invalid", 1],
    ["invalid archive metadata", { archiveManifest: "invalid" }, "is missing or invalid", 1],
  ] as [string, Omit<BootstrapFixtureOptions, "archive">, string, number][])(
    "rejects %s before installation (#8253)",
    (_caseName, options, error, npmInvocations) => {
      const fixture = runBootstrapFixture({ archive, ...options });
      try {
        expect(fixture.result.status).toBe(1);
        expect(fixture.result.stderr).toContain(error);
        expect(fixture.npmInvocations).toHaveLength(npmInvocations);
        expect(fixture.installCalled).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("rejects a post-install npm version mismatch (#8253)", () => {
    const fixture = runBootstrapFixture({ archive, installedVersion: "12.0.3" });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "installed npm@12.0.3 does not match reviewed npm@12.0.2",
      );
      expect(fixture.npmInvocations).toHaveLength(3);
      expect(fixture.installCalled).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("installs a matching archive offline (#8253)", () => {
    const fixture = runBootstrapFixture({ archive });
    try {
      const { npmInvocations, result } = fixture;
      expect(result.status).toBe(0);
      expect(npmInvocations).toHaveLength(3);
      expect(npmInvocations[0]).toMatch(
        /^pack npm@12\.0\.2 --pack-destination .* --userconfig \/dev\/null --registry https:\/\/registry\.npmjs\.org\/ --ignore-scripts --no-audit --no-fund$/,
      );
      expect(npmInvocations[1]).toMatch(
        /^install --global .*\/npm-12\.0\.2\.tgz --userconfig \/dev\/null --ignore-scripts --no-audit --no-fund --offline$/,
      );
      expect(npmInvocations[2]).toBe("--version");
    } finally {
      fixture.cleanup();
    }
  });

  it("overrides ambient npm configuration for the archive download (#8253)", () => {
    const fixture = runBootstrapFixture({
      archive,
      environment: {
        NPM_CONFIG_REGISTRY: "https://registry.example.test/",
        NPM_CONFIG_USERCONFIG: "/tmp/untrusted-npmrc",
      },
    });
    try {
      expect(fixture.result.status).toBe(0);
      expect(fixture.npmInvocations[0]).toMatch(
        /^pack npm@12\.0\.2 --pack-destination .* --userconfig \/dev\/null --registry https:\/\/registry\.npmjs\.org\/ --ignore-scripts --no-audit --no-fund$/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
