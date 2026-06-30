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
const ASSET_DIGESTS = new Map([
  [
    "openshell-x86_64-unknown-linux-musl.tar.gz",
    "37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4",
  ],
  [
    "openshell-aarch64-unknown-linux-musl.tar.gz",
    "a5ff01a3240d73c72ec1700eda6cc6c752a86cf50c5dd1b5bdc459f544d03045",
  ],
  [
    "openshell-aarch64-apple-darwin.tar.gz",
    "117b5354cc42d80bc4d5e070ea5ac4e341208ff6d3c29b516d8a9c80e2310f8d",
  ],
  [
    "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
    "03225fb9388b682af1a5f1614b26b75f828da6031e3ffc1fd920b6fbe5f70877",
  ],
  [
    "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz",
    "a97dcb3acb04fb2d1170c1a2170228990c2337e25bb8c18817e5a6e952204108",
  ],
  [
    "openshell-gateway-aarch64-apple-darwin.tar.gz",
    "8c07362107393eb5f4ae4b9ee9f4257fd53862c51ad8dd96f2fe31bb6d8d7ffb",
  ],
  [
    "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
    "811f914b6a6a3a3f4533449ddebebb6422333861a27a5fa848db6cbfdffdd230",
  ],
  [
    "openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz",
    "2cf62cbd651e55d0f8750804e2b4025e0d6c8eea4564c87cda47a2c922941db0",
  ],
]);
const ASSETS = [...ASSET_DIGESTS.keys()];
const CHECKSUM_MANIFESTS = new Map([
  [
    "openshell-checksums-sha256.txt",
    `37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4  openshell-x86_64-unknown-linux-musl.tar.gz
a5ff01a3240d73c72ec1700eda6cc6c752a86cf50c5dd1b5bdc459f544d03045  openshell-aarch64-unknown-linux-musl.tar.gz
117b5354cc42d80bc4d5e070ea5ac4e341208ff6d3c29b516d8a9c80e2310f8d  openshell-aarch64-apple-darwin.tar.gz
911dd804074c620b3ba353f17e39a8195222c0764072621a154164432d7906d0  openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz
5e6ba04030938e7be21b8b83af9a34b888deffb4c65e7e70dd6845c3bc7e264f  openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz
cdcdf0d0b5a231c0c7631787de014462093ffdeb5c85de853594fd215b0fa98a  openshell-driver-vm-aarch64-apple-darwin.tar.gz
f4807cdaf3598c1fbcd0f35c888bf7f42210e1f4ab27700a1200d5bf80e56e9a  openshell_0.0.72-1_amd64.deb
e38eca3badbba827c7342e2d738b277c8714081a54700ce4dc6c5395e1608d6b  openshell_0.0.72-1_arm64.deb
626aa3c781027231a2085ebbdb5a4e2ae88c1c0977bfb1fd7ddaab501efe37c5  openshell-0.0.72-1.fc44.aarch64.rpm
abca83026aa8192a82c54316e6f15f38583fdd59d936535d07fe7bb5e6824a32  openshell-0.0.72-1.fc44.x86_64.rpm
cf349d3cd5fb5f05419ee088a4784206ce117af07f427e0667290955659c7530  openshell-gateway-0.0.72-1.fc44.aarch64.rpm
523087b888d6641a1798c3400492028d5c236870f321ab87d28918e3ae523c20  openshell-gateway-0.0.72-1.fc44.x86_64.rpm
fc590490e1a89c00b8f95b5449de9107cb9f070bd4a8cefb0f2389baf0d95f67  openshell-0.0.72-py3-none-macosx_13_0_arm64.whl
e104152e6840dc2bed10856251ed6b3a020ed5f5550e735a325028a0990b475b  openshell-0.0.72-py3-none-manylinux_2_39_aarch64.whl
c7feaca0c8c97ace952bd047408a91732fbcb298517481152d8e53d49c5fc88f  openshell-0.0.72-py3-none-manylinux_2_39_x86_64.whl
`,
  ],
  [
    "openshell-gateway-checksums-sha256.txt",
    `03225fb9388b682af1a5f1614b26b75f828da6031e3ffc1fd920b6fbe5f70877  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz
a97dcb3acb04fb2d1170c1a2170228990c2337e25bb8c18817e5a6e952204108  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz
8c07362107393eb5f4ae4b9ee9f4257fd53862c51ad8dd96f2fe31bb6d8d7ffb  openshell-gateway-aarch64-apple-darwin.tar.gz
`,
  ],
  [
    "openshell-sandbox-checksums-sha256.txt",
    `811f914b6a6a3a3f4533449ddebebb6422333861a27a5fa848db6cbfdffdd230  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz
2cf62cbd651e55d0f8750804e2b4025e0d6c8eea4564c87cda47a2c922941db0  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz
`,
  ],
]);
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
    (asset) =>
      `    v0.0.72:${asset})\n      printf '%s\\n' "${ASSET_DIGESTS.get(asset)}"\n      ;;`,
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
  *releases/download/v0.0.72/*)
    case "\${NEMOCLAW_TEST_CURL_MODE}" in
      failure) exit 22 ;;
    esac
    case "\${url##*/}" in
      openshell-checksums-sha256.txt)
        case "\${NEMOCLAW_TEST_CURL_MODE}" in
          partial) printf '%s\\n' '${CHECKSUM_MANIFESTS.get("openshell-checksums-sha256.txt")?.split("\n")[0]}' >"$output" ;;
          *) printf '%s' '${CHECKSUM_MANIFESTS.get("openshell-checksums-sha256.txt")}' >"$output" ;;
        esac
        ;;
      openshell-gateway-checksums-sha256.txt)
        printf '%s' '${CHECKSUM_MANIFESTS.get("openshell-gateway-checksums-sha256.txt")}' >"$output"
        ;;
      openshell-sandbox-checksums-sha256.txt)
        printf '%s' '${CHECKSUM_MANIFESTS.get("openshell-sandbox-checksums-sha256.txt")}' >"$output"
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

function runFixture(mode: "complete" | "failure" | "partial") {
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
  it("verifies all eight pins from complete token-free checksum manifests", () => {
    const result = runFixture("complete");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("fails closed when the OpenShell checksum release assets are unreachable", () => {
    const result = runFixture("failure");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when an OpenShell checksum manifest is incomplete", () => {
    const result = runFixture("partial");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("digest does not match the pinned v0.0.72 release asset");
    expect(result.stdout).toContain("expected all 8 pinned assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });
});
