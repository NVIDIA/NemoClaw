// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-openshell.sh");
const TEST_TIMEOUT_MS = 2 * 60_000;

test(
  "selects the supported OpenShell version when newer releases exist (#3474)",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-resolver-"));
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    writeExecutable(
      path.join(binDir, "gh"),
      `#!/bin/sh
printf '%s\\n' '${JSON.stringify([
        { tagName: "v0.0.99" },
        { tagName: "v0.0.107" },
        { tagName: "v0.0.106" },
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
  getBlueprintMinOpenshellVersion: () => "0.0.106",
  getBlueprintMaxOpenshellVersion: () => "0.0.106",
  versionGte: version.versionGte,
};
const resolution = pin.resolveOpenshellInstallPin(deps);
const replacement = pin.computeOpenshellInstallEnv(
  { INSTALLED_OPENSHELL_VERSION: "0.0.99" },
  deps,
);
process.stdout.write(JSON.stringify({
  installed: version.getInstalledOpenshellVersion("openshell 0.0.99"),
  resolution,
  replacement: replacement.env,
}));`,
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
          killSignal: "SIGKILL",
          timeout: 60_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        installed: "0.0.99",
        resolution: { kind: "pin", version: "0.0.106", latest: "0.0.107", reason: "max-cap" },
        replacement: {
          INSTALLED_OPENSHELL_VERSION: "0.0.99",
          NEMOCLAW_OPENSHELL_MIN_VERSION: "0.0.106",
          NEMOCLAW_OPENSHELL_MAX_VERSION: "0.0.106",
          NEMOCLAW_OPENSHELL_PIN_VERSION: "0.0.106",
        },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

const PINNED_OPEN_SHELL_SHA256 = {
  cliLinuxX64: "d1a885a91b3e5aaa006c36aca95dc78bed0638c1ba1a79b55f1da93211b8a0a0",
  gatewayLinuxX64: "b7760cb752a4363c2f21d32298dd0c683dc438f6edfd16c2e4242bc0baefbb7c",
  sandboxLinuxX64: "559b8aaad3a8eeab45c511e7de531d9baa98a311282dcb0c2c5f38cc2d4ca355",
};

type GhDownloadMode = "success" | "fail";

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

// Bash helpers shared by the gh and curl stubs: write a fake archive and emit
// the same pinned digest lines the real OpenShell v0.0.106 release uses. A fake
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

// Force Linux/x86_64 asset selection because the fake release data covers only that platform.
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

function runVersionPinTarget(options: {
  expectedDecision: RegExp;
  ghDownloadMode: GhDownloadMode;
  installedVersion: string;
}): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-version-pin-"));
  try {
    const fakeBin = path.join(tmp, "bin");
    const downloadLog = path.join(tmp, "downloads.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(downloadLog, "");

    createFakeUname(fakeBin);
    createFakeStickyOpenshell(fakeBin, options.installedVersion);
    createFakeHelperBinaries(fakeBin);
    createFakeGh(fakeBin, downloadLog, options.ghDownloadMode);
    createFakeCurl(fakeBin, downloadLog);
    createFakeTar(fakeBin, "0.0.106");
    createFakeStrings(fakeBin);
    createFakeSha256sum(fakeBin);

    const result = spawnSync("bash", [INSTALL_SCRIPT], {
      env: {
        ...process.env,
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 60_000,
    });

    // Assertion 1: installer-exits-zero — the selected replacement path
    // completes instead of stopping before the download.
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(options.expectedDecision);

    // Assertion 2: download-log-contains-v0.0.106 — pinned release tag was
    // requested from the release host.
    const downloads = fs.readFileSync(downloadLog, "utf-8");
    expect(downloads).toContain("v0.0.106");

    // Assertion 3: download-log-excludes-installed-version — the existing
    // release is never re-fetched in place of the pinned replacement.
    expect(downloads).not.toContain(`v${options.installedVersion}`);

    if (options.ghDownloadMode === "fail") {
      // Assertion 3b: curl-fallback-observed — the installer must recover from
      // gh download failure by re-requesting the pinned assets via curl.
      expect(downloads).toContain("gh download-fail v0.0.106");
      expect(downloads).toContain("curl ");
    } else {
      expect(downloads).toContain("gh download v0.0.106");
      expect(downloads).not.toContain("curl ");
    }

    // Assertion 4: replaced-openshell-reports-0.0.106 — the binary on disk in
    // the active install dir (== fakeBin, since ACTIVE_OPENSHELL_BIN resolved
    // there and it is writable) was overwritten with the pinned 0.0.106 build.
    const replacedVersion = spawnSync(path.join(fakeBin, "openshell"), ["--version"], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 30_000,
    });
    expect(replacedVersion.status).toBe(0);
    expect(replacedVersion.stdout).toContain("0.0.106");
    expect(replacedVersion.stdout).not.toContain(options.installedVersion);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test(
  "replaces an installed OpenShell version above the supported maximum (#3474)",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  () => {
    runVersionPinTarget({
      expectedDecision: /above the maximum.*reinstalling pinned OpenShell 0\.0\.106/u,
      ghDownloadMode: "success",
      installedVersion: "0.0.107",
    });
  },
);

test(
  "falls back to curl when GitHub release download fails (#3474)",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  () => {
    runVersionPinTarget({
      expectedDecision: /above the maximum.*reinstalling pinned OpenShell 0\.0\.106/u,
      ghDownloadMode: "fail",
      installedVersion: "0.0.107",
    });
  },
);

test(
  "replaces an installed OpenShell 0.0.99 with the pinned 0.0.106 release (#8606)",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  () => {
    runVersionPinTarget({
      expectedDecision: /below minimum 0\.0\.106.*upgrading/u,
      ghDownloadMode: "success",
      installedVersion: "0.0.99",
    });
  },
);
