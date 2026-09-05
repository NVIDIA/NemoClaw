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

function identity(archive: string): Record<string, string> {
  return {
    npmArchiveSha256: createHash("sha256").update(archive).digest("hex"),
    npmIntegrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    npmVersion: "12.0.2",
  };
}

type BootstrapFixtureOptions = {
  archive: string;
  environment?: NodeJS.ProcessEnv;
  installedVersion?: string;
  reviewedIdentity?: Record<string, string>;
};

function runBootstrapFixture(options: BootstrapFixtureOptions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-bootstrap-"));
  const bin = path.join(root, "bin");
  const npmLog = path.join(root, "npm.log");
  const installMarker = path.join(root, "install-called");
  const identityPath = path.join(root, "reviewed-npm-audit.json");

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
    printf '%s' "$NEMOCLAW_TEST_ARCHIVE" > "$download_dir/npm-12.0.2.tgz"
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
    `${JSON.stringify(options.reviewedIdentity ?? identity(options.archive))}\n`,
  );
  const result = spawnSync("bash", [BOOTSTRAP, identityPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.environment,
      NEMOCLAW_TEST_ARCHIVE: options.archive,
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
    npmInvocations: fs.readFileSync(npmLog, "utf8").trim().split("\n"),
    result,
  };
}

describe("reviewed npm bootstrap", () => {
  const archive = "verified archive\n";

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
