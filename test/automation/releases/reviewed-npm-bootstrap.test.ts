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

describe("reviewed npm bootstrap", () => {
  it("rejects a mismatched archive before installation (#8253)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-bootstrap-"));
    const bin = path.join(root, "bin");
    const npmLog = path.join(root, "npm.log");
    const installMarker = path.join(root, "install-called");
    const npmStub = path.join(bin, "npm");
    const identityPath = path.join(root, "reviewed-npm-audit.json");

    try {
      fs.mkdirSync(bin);
      fs.writeFileSync(identityPath, `${JSON.stringify(identity("reviewed archive\n"))}\n`);
      fs.writeFileSync(
        npmStub,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> "$NEMOCLAW_TEST_NPM_LOG"
case "$1" in
  pack)
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
    printf 'tampered archive\\n' > "$download_dir/npm-12.0.2.tgz"
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

      const result = spawnSync("bash", [BOOTSTRAP, identityPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_TEST_INSTALL_MARKER: installMarker,
          NEMOCLAW_TEST_NPM_LOG: npmLog,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: root,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("npm@12.0.2 archive integrity mismatch");
      expect(fs.readFileSync(npmLog, "utf8")).toBe("pack\n");
      expect(fs.existsSync(installMarker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs a matching archive offline (#8253)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-bootstrap-"));
    const bin = path.join(root, "bin");
    const npmLog = path.join(root, "npm.log");
    const npmStub = path.join(bin, "npm");
    const identityPath = path.join(root, "reviewed-npm-audit.json");
    const archive = "verified archive\n";

    try {
      fs.mkdirSync(bin);
      fs.writeFileSync(
        npmStub,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NEMOCLAW_TEST_NPM_LOG"
case "$1" in
  pack)
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
    printf 'verified archive\\n' > "$download_dir/npm-12.0.2.tgz"
    ;;
  install)
    ;;
  --version)
    printf '12.0.2\n'
    ;;
  *)
    exit 2
    ;;
esac
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(identityPath, `${JSON.stringify(identity(archive))}\n`);
      const result = spawnSync("bash", [BOOTSTRAP, identityPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_TEST_NPM_LOG: npmLog,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: root,
        },
      });

      const npmInvocations = fs.readFileSync(npmLog, "utf8").trim().split("\n");
      expect(result.status).toBe(0);
      expect(npmInvocations).toHaveLength(3);
      expect(npmInvocations[0]).toContain("pack npm@12.0.2 --pack-destination");
      expect(npmInvocations[1]).toMatch(
        /^install --global .*\/npm-12\.0\.2\.tgz --userconfig \/dev\/null --ignore-scripts --no-audit --no-fund --offline$/,
      );
      expect(npmInvocations[2]).toBe("--version");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
