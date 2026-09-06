// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

function identity(archive: string | Buffer): Record<string, string> {
  return {
    npmArchiveSha256: createHash("sha256").update(archive).digest("hex"),
    npmIntegrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    npmVersion: "12.0.2",
  };
}

type BootstrapFixtureOptions = {
  archive: string | Buffer;
  archiveVersion?: string;
  environment?: NodeJS.ProcessEnv;
  realTar?: boolean;
  reviewedIdentity?: Record<string, string>;
};

function runBootstrapFixture(options: BootstrapFixtureOptions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-bootstrap-"));
  const bin = path.join(root, "bin");
  const npmLog = path.join(root, "npm.log");
  const installMarker = path.join(root, "install-called");
  const identityPath = path.join(root, "reviewed-npm-audit.json");
  const archivePath = path.join(root, "fixture.tgz");

  fs.mkdirSync(bin);
  fs.writeFileSync(archivePath, options.archive);
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
  *)
    exit 2
    ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "tar"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$NEMOCLAW_TEST_REAL_TAR" in
  true)
    exec env PATH="$NEMOCLAW_TEST_ORIGINAL_PATH" tar "$@"
    ;;
  false)
[ "$1" = "-xOf" ]
[ "$3" = "package/package.json" ]
printf '{"version":"%s"}\\n' "$NEMOCLAW_TEST_ARCHIVE_VERSION"
    ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    identityPath,
    `${JSON.stringify(options.reviewedIdentity ?? identity(options.archive))}\n`,
  );
  const result = spawnSync("bash", [BOOTSTRAP, identityPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.environment,
      NEMOCLAW_TEST_ARCHIVE_FILE: archivePath,
      NEMOCLAW_TEST_ARCHIVE_VERSION: options.archiveVersion ?? "12.0.2",
      NEMOCLAW_TEST_INSTALL_MARKER: installMarker,
      NEMOCLAW_TEST_NPM_LOG: npmLog,
      NEMOCLAW_TEST_ORIGINAL_PATH: process.env.PATH ?? "",
      NEMOCLAW_TEST_REAL_TAR: String(options.realTar ?? false),
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

function createRealArchive(version?: string): { archive: Buffer; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-archive-"));
  const packageRoot = path.join(root, "package");
  const archivePath = path.join(root, "fixture.tgz");
  fs.mkdirSync(packageRoot);
  const entry =
    version === undefined
      ? { contents: "missing package manifest\n", name: "README.md" }
      : { contents: `${JSON.stringify({ version })}\n`, name: "package.json" };
  fs.writeFileSync(path.join(packageRoot, entry.name), entry.contents);
  const packed = spawnSync("tar", ["-czf", archivePath, "-C", root, "package"], {
    encoding: "utf8",
  });
  expect(packed.status, packed.stderr).toBe(0);
  return {
    archive: fs.readFileSync(archivePath),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("reviewed npm bootstrap", () => {
  const archive = "verified archive\n";

  it("rejects a malformed reviewed archive SHA-256 before download (#8253)", () => {
    const fixture = runBootstrapFixture({
      archive,
      reviewedIdentity: { ...identity(archive), npmArchiveSha256: "not-a-reviewed-digest" },
    });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "reviewed npm audit configuration has an invalid npmArchiveSha256",
      );
      expect(fixture.npmInvocations).toEqual([]);
      expect(fixture.installCalled).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["SHA-256", { ...identity(archive), npmArchiveSha256: "0".repeat(64) }],
    [
      "SHA-512 SRI",
      { ...identity(archive), npmIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}` },
    ],
  ])(
    "rejects an independent %s mismatch before installation (#8253)",
    (_digest, reviewedIdentity) => {
      const fixture = runBootstrapFixture({ archive, reviewedIdentity });
      try {
        expect(fixture.result.status).toBe(1);
        expect(fixture.result.stderr).toContain("npm@12.0.2 archive integrity mismatch");
        expect(fixture.npmInvocations).toHaveLength(1);
        expect(fixture.npmInvocations[0]).toContain("pack npm@12.0.2 --pack-destination");
        expect(fixture.installCalled).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("rejects an archive package version mismatch before installation (#8253)", () => {
    const fixture = runBootstrapFixture({ archive, archiveVersion: "12.0.3" });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "npm archive version 12.0.3 does not match reviewed npm@12.0.2",
      );
      expect(fixture.npmInvocations).toHaveLength(1);
      expect(fixture.installCalled).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["matching", "12.0.2", true],
    ["mismatched", "12.0.3", false],
    ["missing", undefined, false],
  ] as const)(
    "%s real tar package metadata reaches installation only for the reviewed version (#8253)",
    (_condition, archiveVersion, expectedInstall) => {
      const archiveFixture = createRealArchive(archiveVersion);
      const fixture = runBootstrapFixture({ archive: archiveFixture.archive, realTar: true });
      try {
        expect(fixture.result.status === 0).toBe(expectedInstall);
        expect(fixture.installCalled).toBe(expectedInstall);
        expect(fixture.npmInvocations).toHaveLength(expectedInstall ? 2 : 1);
      } finally {
        fixture.cleanup();
        archiveFixture.cleanup();
      }
    },
  );

  it("installs a matching archive offline (#8253)", () => {
    const fixture = runBootstrapFixture({ archive });
    try {
      const { npmInvocations, result } = fixture;
      expect(result.status).toBe(0);
      expect(npmInvocations).toHaveLength(2);
      expect(npmInvocations[0]).toMatch(
        /^pack npm@12\.0\.2 --pack-destination .* --userconfig \/dev\/null --registry https:\/\/registry\.npmjs\.org\/ --ignore-scripts --no-audit --no-fund$/,
      );
      expect(npmInvocations[1]).toMatch(
        /^install --global .*\/npm-12\.0\.2\.tgz --userconfig \/dev\/null --ignore-scripts --no-audit --no-fund --offline$/,
      );
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
