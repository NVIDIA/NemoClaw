// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ArtifactSink } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

// #3474). The former bash script is a self-contained installer-script behavioral
// test: it runs scripts/install-openshell.sh under a stubbed PATH where the
// already-installed openshell reports a too-new version (0.0.86) and the
// downloaded archives produce a binary that reports the pinned 0.0.85.
//
// This credential-free E2E test does not exercise
// the registry-driven steady-state probe model. There is no OpenClaw instance,
// no environment phase, no lifecycle. The test consumes only the `artifacts`
// fixture from e2e-test.ts so failures attach the per-target artifact root.

const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-openshell.sh");

test("openshell-version-pin: selects shipping 0.0.85 between older and too-new releases", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-resolver-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(
    path.join(binDir, "gh"),
    `#!/bin/sh
printf '%s\\n' '${JSON.stringify([
      { tagName: "v0.0.81" },
      { tagName: "v0.0.86" },
      { tagName: "v0.0.85" },
    ])}'`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `
const pin = require(${JSON.stringify(path.join(REPO_ROOT, "src/lib/onboard/openshell-pin.ts"))});
const version = require(${JSON.stringify(path.join(REPO_ROOT, "src/lib/onboard/openshell-version.ts"))});
const deps = {
  getBlueprintMinOpenshellVersion: () => "0.0.85",
  getBlueprintMaxOpenshellVersion: () => "0.0.85",
  versionGte: version.versionGte,
};
const resolution = pin.resolveOpenshellInstallPin(deps);
const replacement = pin.computeOpenshellInstallEnv(
  { INSTALLED_OPENSHELL_VERSION: "0.0.81" },
  deps,
);
process.stdout.write(JSON.stringify({
  installed: version.getInstalledOpenshellVersion("openshell 0.0.81"),
  resolution,
  replacement: replacement.env,
}));`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      installed: "0.0.81",
      resolution: { kind: "pin", version: "0.0.85", latest: "0.0.86", reason: "max-cap" },
      replacement: {
        INSTALLED_OPENSHELL_VERSION: "0.0.81",
        NEMOCLAW_OPENSHELL_MIN_VERSION: "0.0.85",
        NEMOCLAW_OPENSHELL_MAX_VERSION: "0.0.85",
        NEMOCLAW_OPENSHELL_PIN_VERSION: "0.0.85",
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const PINNED_OPEN_SHELL_SHA256 = {
  cliLinuxX64: "078fa086f506832c3d47d992e6109f26074bdd55916ce268e47c3971423459eb",
  gatewayLinuxX64: "718cc9f942f88565cacb13c39717b128d6acc8d336212d42d26243f36ab19ece",
  sandboxLinuxX64: "94306f057d862cd5c34a0daa7692491733bc5ca528a7b92f9f62f717fb70a9be",
};

type GhDownloadMode = "success" | "fail";

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

// Bash helpers shared by the gh and curl stubs: write a fake archive and emit
// the same pinned digest lines the real OpenShell v0.0.85 release uses. A fake
// sha256sum below keeps this test self-contained even though the tarball bytes are
// synthetic.
const SHARED_DOWNLOAD_BASH_HELPERS = `\
write_asset() {
  local asset_name="$1"
  local asset_path="$2"
  printf 'fake OpenShell release asset: %s\\n' "$asset_name" >"$asset_path"
}
pinned_sha256() {
  case "$1" in
    openshell-x86_64-unknown-linux-musl.tar.gz) printf '%s\\n' ${JSON.stringify(PINNED_OPEN_SHELL_SHA256.cliLinuxX64)} ;;
    openshell-gateway-x86_64-unknown-linux-gnu.tar.gz) printf '%s\\n' ${JSON.stringify(PINNED_OPEN_SHELL_SHA256.gatewayLinuxX64)} ;;
    openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz) printf '%s\\n' ${JSON.stringify(PINNED_OPEN_SHELL_SHA256.sandboxLinuxX64)} ;;
    *) exit 4 ;;
  esac
}
write_checksum() {
  local checksum_file="$1"
  local asset_name="$2"
  local asset_path="$3"
  [ -f "$asset_path" ] || write_asset "$asset_name" "$asset_path"
  printf '%s  %s\\n' "$(pinned_sha256 "$asset_name")" "$asset_name" >"$checksum_file"
}`;

// Force Linux/x86_64 asset selection regardless of host arch (former shell test
// is dispatched on ubuntu-latest via regression-e2e.yaml).
function createFakeUname(binDir: string): void {
  writeExecutable(
    path.join(binDir, "uname"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then echo "x86_64"; else echo "Linux"; fi`,
  );
}

// Sticky openshell at the configured (too-new) version we expect the
// installer to replace. Includes the messaging-rewrite capability marker so
// the post-install feature probe doesn't reject pre-replacement.
function createFakeStickyOpenshell(binDir: string, version: string): void {
  writeExecutable(
    path.join(binDir, "openshell"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell ${version}"; exit 0; fi
# request-body-credential-rewrite websocket-credential-rewrite
exit 0`,
  );
}

// Helper Docker-driver binaries exist so the only reason to reinstall is the
// too-new version, not missing helpers.
function createFakeHelperBinaries(binDir: string): void {
  for (const name of ["openshell-gateway", "openshell-sandbox"]) {
    writeExecutable(
      path.join(binDir, name),
      `#!/usr/bin/env bash
exit 0`,
    );
  }
}

// gh writes fake archives + matching sha256 checksum files into the requested
// --dir unless the test case asks it to fail so the installer must use curl.
// Logs every invocation to DOWNLOAD_LOG.
function createFakeGh(binDir: string, downloadLog: string, mode: GhDownloadMode): void {
  const failureBranch =
    mode === "fail"
      ? `\
  printf 'gh download-fail %s %s\\n' "$tag" "$pattern" >> ${JSON.stringify(downloadLog)}
  exit 1
`
      : "";
  writeExecutable(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
${SHARED_DOWNLOAD_BASH_HELPERS}
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "download" ]; then
  tag="\${3:-}"
  pattern=""
  dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) shift; pattern="\${1:-}" ;;
      --dir) shift; dir="\${1:-}" ;;
    esac
    shift || true
  done
  [ -n "$tag" ] && [ -n "$pattern" ] && [ -n "$dir" ] || exit 2
${failureBranch}
  printf 'gh download %s %s\\n' "$tag" "$pattern" >> ${JSON.stringify(downloadLog)}
  mkdir -p "$dir"
  case "$pattern" in
    openshell-checksums-sha256.txt)
      asset_name="openshell-x86_64-unknown-linux-musl.tar.gz"
      write_checksum "$dir/$pattern" "$asset_name" "$dir/$asset_name"
      ;;
    openshell-gateway-checksums-sha256.txt)
      asset_name="openshell-gateway-x86_64-unknown-linux-gnu.tar.gz"
      write_checksum "$dir/$pattern" "$asset_name" "$dir/$asset_name"
      ;;
    openshell-sandbox-checksums-sha256.txt)
      asset_name="openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz"
      write_checksum "$dir/$pattern" "$asset_name" "$dir/$asset_name"
      ;;
    *)
      write_asset "$pattern" "$dir/$pattern"
      ;;
  esac
  exit 0
fi
exit 1`,
  );
}

// curl mirror of the gh stub for the curl fallback download path. Logs every
// invocation to DOWNLOAD_LOG so we can assert which release tag was requested.
function createFakeCurl(binDir: string, downloadLog: string): void {
  writeExecutable(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
${SHARED_DOWNLOAD_BASH_HELPERS}
printf 'curl %s\\n' "$*" >> ${JSON.stringify(downloadLog)}
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="\${1:-}"
  fi
  shift || true
done
[ -n "$out" ] || exit 0
case "$(basename "$out")" in
  openshell-checksums-sha256.txt)
    asset_name="openshell-x86_64-unknown-linux-musl.tar.gz"
    write_checksum "$out" "$asset_name" "$(dirname "$out")/$asset_name"
    ;;
  openshell-gateway-checksums-sha256.txt)
    asset_name="openshell-gateway-x86_64-unknown-linux-gnu.tar.gz"
    write_checksum "$out" "$asset_name" "$(dirname "$out")/$asset_name"
    ;;
  openshell-sandbox-checksums-sha256.txt)
    asset_name="openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz"
    write_checksum "$out" "$asset_name" "$(dirname "$out")/$asset_name"
    ;;
  *)
    write_asset "$(basename "$out")" "$out"
    ;;
esac`,
  );
}

// tar stub: model archive listing, inspection, and extraction. Each extracted
// binary reports the replacement version + carries the messaging-rewrite and
// MCP-L7 capability markers so the post-install feature probes pass.
function createFakeTar(binDir: string, replacementVersion: string): void {
  writeExecutable(
    path.join(binDir, "tar"),
    `#!/usr/bin/env bash
set -euo pipefail
mode="\${1:-}"
archive="\${2:-}"
case "$(basename "$archive")" in
  openshell-gateway-*) name="openshell-gateway" ;;
  openshell-sandbox-*) name="openshell-sandbox" ;;
  openshell-*) name="openshell" ;;
  *) exit 2 ;;
esac

case "$mode" in
  -tzf)
    printf '%s\\n' "$name"
    exit 0
    ;;
  -tvzf)
    printf '%s\\n' "-rwxr-xr-x 0/0 0 2026-01-01 00:00 $name"
    exit 0
    ;;
  xzf|-xzf)
    ;;
  *)
    exit 2
    ;;
esac

outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then
    outdir="$arg"
    break
  fi
  prev="$arg"
done
[ -n "$outdir" ] || exit 1
cat > "$outdir/$name" <<'EOS'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell ${replacementVersion}"; exit 0; fi
# request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods
exit 0
EOS
chmod 755 "$outdir/$name"`,
  );
}

// The capability probe shells out to `strings` against the installed openshell
// binary. Our fake openshell binaries are scripts whose contents already
// include the marker comments, so cat-ing them satisfies the probe.
function createFakeStrings(binDir: string): void {
  writeExecutable(
    path.join(binDir, "strings"),
    `#!/usr/bin/env bash
cat "$@" 2>/dev/null || true`,
  );
}

function createFakeSha256sum(binDir: string): void {
  writeExecutable(
    path.join(binDir, "sha256sum"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-c" ]; then
  cat >/dev/null
  echo "checksum OK"
  exit 0
fi
exec /usr/bin/sha256sum "$@"`,
  );
}

async function runVersionPinTarget(
  artifacts: ArtifactSink,
  options: { ghDownloadMode: GhDownloadMode },
): Promise<void> {
  await artifacts.target.declare({
    id: "openshell-version-pin",
    boundary: "installer-script-unit",
    regressionTarget: "#3474",
    ghDownloadMode: options.ghDownloadMode,
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-version-pin-"));
  try {
    const fakeBin = path.join(tmp, "bin");
    const downloadLog = path.join(tmp, "downloads.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(downloadLog, "");

    createFakeUname(fakeBin);
    createFakeStickyOpenshell(fakeBin, "0.0.86");
    createFakeHelperBinaries(fakeBin);
    createFakeGh(fakeBin, downloadLog, options.ghDownloadMode);
    createFakeCurl(fakeBin, downloadLog);
    createFakeTar(fakeBin, "0.0.85");
    createFakeStrings(fakeBin);
    createFakeSha256sum(fakeBin);

    const result = spawnSync("bash", [INSTALL_SCRIPT], {
      env: {
        ...process.env,
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      encoding: "utf8",
    });

    // Persist the install transcript so failures can be diagnosed without
    // re-running the test.
    await artifacts.writeText("install-openshell.stdout", result.stdout ?? "");
    await artifacts.writeText("install-openshell.stderr", result.stderr ?? "");
    await artifacts.writeText("downloads.log", fs.readFileSync(downloadLog, "utf-8"));

    // Assertion 1: installer-exits-zero — the happy path completes (no
    // "above the maximum" hard-fail before download).
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    // Assertion 2: download-log-contains-v0.0.85 — pinned release tag was
    // requested from the release host.
    const downloads = fs.readFileSync(downloadLog, "utf-8");
    expect(downloads).toContain("v0.0.85");

    // Assertion 3: download-log-excludes-v0.0.86 — the too-new sticky version
    // is never re-fetched.
    expect(downloads).not.toContain("v0.0.86");

    if (options.ghDownloadMode === "fail") {
      // Assertion 3b: curl-fallback-observed — the installer must recover from
      // gh download failure by re-requesting the pinned assets via curl.
      expect(downloads).toContain("gh download-fail v0.0.85");
      expect(downloads).toContain("curl ");
    } else {
      expect(downloads).toContain("gh download v0.0.85");
      expect(downloads).not.toContain("curl ");
    }

    // Assertion 4: replaced-openshell-reports-0.0.85 — the binary on disk in
    // the active install dir (== fakeBin, since ACTIVE_OPENSHELL_BIN resolved
    // there and it is writable) was overwritten with the pinned 0.0.85 build.
    const replacedVersion = spawnSync(path.join(fakeBin, "openshell"), ["--version"], {
      encoding: "utf8",
    });
    expect(replacedVersion.status).toBe(0);
    expect(replacedVersion.stdout).toContain("0.0.85");
    expect(replacedVersion.stdout).not.toContain("0.0.86");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("openshell-version-pin: replaces sticky too-new openshell with pinned 0.0.85 via gh download", async ({
  artifacts,
}) => {
  await runVersionPinTarget(artifacts, { ghDownloadMode: "success" });
});

test("openshell-version-pin: falls back to curl when gh cannot fetch the pinned release", async ({
  artifacts,
}) => {
  await runVersionPinTarget(artifacts, { ghDownloadMode: "fail" });
});
