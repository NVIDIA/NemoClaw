// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const OLLAMA_FIXTURE = "fixture installer\n";
const FIXTURE_DIGEST = "a".repeat(64);
const ASSETS = [
  "openshell-x86_64-unknown-linux-musl.tar.gz",
  "openshell-aarch64-unknown-linux-musl.tar.gz",
  "openshell-aarch64-apple-darwin.tar.gz",
  "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
  "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz",
  "openshell-gateway-aarch64-apple-darwin.tar.gz",
  "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
  "openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz",
];
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createFixture(): string {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-hash-"));
  const scriptsDir = path.join(fixtureRoot, "scripts");
  const binDir = path.join(fixtureRoot, "bin");
  tempDirs.push(fixtureRoot);
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "check-installer-hash.sh"),
    path.join(scriptsDir, "check-installer-hash.sh"),
  );

  const ollamaDigest = createHash("sha256").update(OLLAMA_FIXTURE).digest("hex");
  fs.writeFileSync(
    path.join(scriptsDir, "install.sh"),
    `OLLAMA_INSTALL_SHA256="${ollamaDigest}"\n`,
  );
  const cases = ASSETS.map(
    (asset) => `    v0.0.72:${asset})\n      printf '%s\\n' "${FIXTURE_DIGEST}"\n      ;;`,
  ).join("\n");
  fs.writeFileSync(
    path.join(scriptsDir, "install-openshell.sh"),
    `openshell_pinned_sha256() {\n  case "\${1}:\${2}" in\n${cases}\n  esac\n}\n`,
  );
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *api.github.com*)
    case "\${NEMOCLAW_TEST_CURL_MODE}" in
      failure) exit 22 ;;
      partial)
        printf '%s\\n' '{"assets":[{"name":"${ASSETS[0]}","digest":"sha256:${FIXTURE_DIGEST}"}]}' >"$output"
        ;;
    esac
    ;;
  *) printf '%s' '${OLLAMA_FIXTURE}' >"$output" ;;
esac
`,
  );
  fs.chmodSync(path.join(binDir, "curl"), 0o755);
  return fixtureRoot;
}

function runFixture(mode: "failure" | "partial") {
  const fixtureRoot = createFixture();
  return spawnSync("bash", ["scripts/check-installer-hash.sh"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      NEMOCLAW_TEST_CURL_MODE: mode,
      PATH: `${path.join(fixtureRoot, "bin")}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("installer hash verification", () => {
  it("fails closed when the OpenShell release API is unreachable", () => {
    const result = runFixture("failure");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when the OpenShell release omits a pinned asset", () => {
    const result = runFixture("partial");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("upstream: missing");
    expect(result.stdout).toContain("expected all 8 pinned assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });
});
