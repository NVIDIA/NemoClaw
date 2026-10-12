// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const BOOTSTRAP = path.join(
  REPO_ROOT,
  ".github/actions/setup-reviewed-npm/verify-and-install-npm.sh",
);

export type ReviewedNpmIdentity = Record<
  "npmArchiveSha256" | "npmIntegrity" | "npmVersion" | "registryOrigin",
  string
>;

type FixtureOptions = {
  archiveManifest?: "invalid" | "matching" | "mismatched" | "missing";
  command?: string;
  configFile?: (root: string) => string;
  environment?: (root: string) => NodeJS.ProcessEnv;
  installedVersion?: string;
  packFailure?: boolean;
  packFailureDebugLog?: boolean;
  mutateIdentity?: (identity: ReviewedNpmIdentity) => ReviewedNpmIdentity;
  prepare?: (root: string) => void;
};

function createArchive(root: string, manifest: NonNullable<FixtureOptions["archiveManifest"]>) {
  const packageRoot = path.join(root, "package");
  const archiveFile = path.join(root, "fixture.tgz");
  fs.mkdirSync(packageRoot);
  if (manifest === "missing") {
    fs.writeFileSync(path.join(packageRoot, "README.md"), "missing package manifest\n");
  } else {
    const source =
      manifest === "invalid"
        ? "{invalid json\n"
        : `${JSON.stringify({ version: manifest === "mismatched" ? "12.0.3" : "12.0.2" })}\n`;
    fs.writeFileSync(path.join(packageRoot, "package.json"), source);
  }
  const packed = spawnSync("tar", ["-czf", archiveFile, "-C", root, "package"], {
    encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(packed.stderr);
  return { archive: fs.readFileSync(archiveFile), archiveFile };
}

export function prepareReviewedNpmBootstrap(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-bootstrap-"));
  const bin = path.join(root, "bin");
  const installMarker = path.join(root, "install-called");
  const npmLog = path.join(root, "npm.log");
  const tarLog = path.join(root, "tar.log");
  fs.mkdirSync(bin);
  options.prepare?.(root);

  const { archive, archiveFile } = createArchive(root, options.archiveManifest ?? "matching");
  fs.writeFileSync(
    path.join(bin, "tar"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$PWD|$*" >> "$NEMOCLAW_TEST_TAR_LOG"
exec /usr/bin/tar "$@"
`,
    { mode: 0o755 },
  );
  const identity: ReviewedNpmIdentity = {
    npmArchiveSha256: createHash("sha256").update(archive).digest("hex"),
    npmIntegrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    npmVersion: "12.0.2",
    registryOrigin: "https://registry.npmjs.org/",
  };
  const configFile = options.configFile?.(root) ?? path.join(root, "reviewed-npm-audit.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(
    configFile,
    `${JSON.stringify(options.mutateIdentity?.(identity) ?? identity)}\n`,
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NEMOCLAW_TEST_NPM_LOG"
case "$1" in
  pack)
    if [ "$NEMOCLAW_TEST_PACK_FAILURE" = "1" ] || [ "$NEMOCLAW_TEST_PACK_FAILURE_DEBUG_LOG" = "1" ]; then
      secret="fixture-secret-token"
      if [ "$NEMOCLAW_TEST_PACK_FAILURE_DEBUG_LOG" = "1" ]; then
        printf 'npm error Log files were not written due to the config logs-max=0\\n'
        while [ "$#" -gt 1 ]; do
          if [ "$1" = "--logs-dir" ]; then
            mkdir -p "$2"
            exec >"$2/fixture-debug-0.log" 2>&1
            break
          fi
          shift
        done
      fi
      printf 'npm error code E_FIXTURE_PACK\\n'
      for index in {1..300}; do
        printf 'verbose diagnostic line %03d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' "$index"
      done
      printf 'npm error Authorization: Bearer %s\\n' "$secret"
      printf 'npm error registry=https://fixture:%s@registry.example.test/package\\n' "$secret" >&2
      printf 'npm error token prefix ghp_1234567890abcdef\\n'
      printf 'npm error jwt eyJfixture1.payload.fixturepayload12345\\n'
      printf 'npm error opaque abcdefghijklmnopqrstuvwxyz0123456789ABCD\\n'
      printf '%s%s\\n%s\\n%s%s\\n' \\
        '-----BEGIN PRIVATE' ' KEY-----' "$secret" '-----END PRIVATE' ' KEY-----'
      printf '_authToken=%s\\npassword=%s\\n' "$secret" "$secret"
      exit 47
    fi
    pack_args="$*"
    while [ "$#" -gt 1 ]; do
      if [ "$1" = "--pack-destination" ]; then
        [ "$pack_args" = "pack npm@12.0.2 --pack-destination $2 --userconfig /dev/null --registry https://registry.npmjs.org/ --logs-dir $2/npm-logs --logs-max 1 --ignore-scripts --no-audit --no-fund" ]
        [ -d "$2/npm-logs" ]
        cp "$NEMOCLAW_TEST_ARCHIVE_FILE" "$2/npm-12.0.2.tgz"
        exit 0
      fi
      shift
    done
    exit 2
    ;;
  install) : > "$NEMOCLAW_TEST_INSTALL_MARKER" ;;
  --version) printf '%s\n' "$NEMOCLAW_TEST_INSTALLED_VERSION" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );

  return {
    args: options.command ? ["-c", options.command] : [BOOTSTRAP, configFile],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    installMarker,
    npmLog,
    tarLog,
    spawnOptions: {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ...options.environment?.(root),
        NEMOCLAW_TEST_ARCHIVE_FILE: archiveFile,
        NEMOCLAW_TEST_INSTALL_MARKER: installMarker,
        NEMOCLAW_TEST_INSTALLED_VERSION: options.installedVersion ?? "12.0.2",
        NEMOCLAW_TEST_NPM_LOG: npmLog,
        NEMOCLAW_TEST_TAR_LOG: tarLog,
        NEMOCLAW_TEST_PACK_FAILURE: options.packFailure ? "1" : "0",
        NEMOCLAW_TEST_PACK_FAILURE_DEBUG_LOG: options.packFailureDebugLog ? "1" : "0",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
      },
    },
  } as const;
}

export function runReviewedNpmBootstrap(options: FixtureOptions = {}) {
  const fixture = prepareReviewedNpmBootstrap(options);
  const result = spawnSync("bash", fixture.args, fixture.spawnOptions);
  return {
    cleanup: fixture.cleanup,
    installCalled: fs.existsSync(fixture.installMarker),
    npmInvocations: fs.existsSync(fixture.npmLog)
      ? fs.readFileSync(fixture.npmLog, "utf8").trim().split("\n")
      : [],
    tarInvocations: fs.existsSync(fixture.tarLog)
      ? fs.readFileSync(fixture.tarLog, "utf8").trim().split("\n")
      : [],
    result,
  };
}
