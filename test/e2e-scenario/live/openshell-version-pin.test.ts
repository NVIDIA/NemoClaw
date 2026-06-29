// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type ArtifactSink } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

// Migrated from test/e2e/test-openshell-version-pin.sh (regression guard for
// #3474). The legacy bash script is a hermetic installer-script behavioral
// test: it runs scripts/install-openshell.sh under a stubbed PATH where the
// already-installed openshell reports a too-new version (0.0.45) and the
// downloaded archives produce a binary that reports the pinned 0.0.44.
//
// This is a free-standing live test (per #5049's pattern) — it does not exercise
// the registry-driven steady-state probe model. There is no OpenClaw instance,
// no environment phase, no lifecycle. The test consumes only the `artifacts`
// fixture from e2e-test.ts so failures attach the per-scenario artifact root.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-openshell.sh");

type GhDownloadMode = "success" | "fail";

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

// Bash helpers shared by the gh and curl stubs: write a fake archive, compute
// a real sha256 digest of it (so install-openshell.sh's `sha256sum -c` step
// validates), and emit the matching checksum file.
const SHARED_DOWNLOAD_BASH_HELPERS = `\
write_asset() {
  local asset_name="$1"
  local asset_path="$2"
  printf 'fake OpenShell release asset: %s\\n' "$asset_name" >"$asset_path"
}
sha256_digest() {
  if [ -x /usr/bin/sha256sum ]; then
    /usr/bin/sha256sum "$1" | awk '{print $1}'
  elif [ -x /bin/sha256sum ]; then
    /bin/sha256sum "$1" | awk '{print $1}'
  elif [ -x /usr/bin/shasum ]; then
    /usr/bin/shasum -a 256 "$1" | awk '{print $1}'
  else
    exit 3
  fi
}
write_checksum() {
  local checksum_file="$1"
  local asset_name="$2"
  local asset_path="$3"
  [ -f "$asset_path" ] || write_asset "$asset_name" "$asset_path"
  printf '%s  %s\\n' "$(sha256_digest "$asset_path")" "$asset_name" >"$checksum_file"
}`;

// Force Linux/x86_64 asset selection regardless of host arch (legacy script
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

// tar stub: write the corresponding binary into the -C outdir. Each binary
// reports the replacement version + carries the messaging-rewrite capability
// marker so the post-install feature probe passes.
function createFakeTar(binDir: string, replacementVersion: string): void {
  writeExecutable(
    path.join(binDir, "tar"),
    `#!/usr/bin/env bash
set -euo pipefail
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
case "$*" in
  *openshell-gateway*) name="openshell-gateway" ;;
  *openshell-sandbox*) name="openshell-sandbox" ;;
  *) name="openshell" ;;
esac
cat > "$outdir/$name" <<'EOS'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell ${replacementVersion}"; exit 0; fi
# request-body-credential-rewrite websocket-credential-rewrite
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

async function runVersionPinScenario(
  artifacts: ArtifactSink,
  options: { ghDownloadMode: GhDownloadMode },
): Promise<void> {
  await artifacts.writeJson("scenario.json", {
    id: "openshell-version-pin",
    runner: "vitest",
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
    createFakeStickyOpenshell(fakeBin, "0.0.45");
    createFakeHelperBinaries(fakeBin);
    createFakeGh(fakeBin, downloadLog, options.ghDownloadMode);
    createFakeCurl(fakeBin, downloadLog);
    createFakeTar(fakeBin, "0.0.44");
    createFakeStrings(fakeBin);

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

    // Assertion 2: download-log-contains-v0.0.44 — pinned release tag was
    // requested from the release host.
    const downloads = fs.readFileSync(downloadLog, "utf-8");
    expect(downloads).toContain("v0.0.44");

    // Assertion 3: download-log-excludes-v0.0.45 — the too-new sticky version
    // is never re-fetched.
    expect(downloads).not.toContain("v0.0.45");

    if (options.ghDownloadMode === "fail") {
      // Assertion 3b: curl-fallback-observed — the installer must recover from
      // gh download failure by re-requesting the pinned assets via curl.
      expect(downloads).toContain("gh download-fail v0.0.44");
      expect(downloads).toContain("curl ");
    } else {
      expect(downloads).toContain("gh download v0.0.44");
      expect(downloads).not.toContain("curl ");
    }

    // Assertion 4: replaced-openshell-reports-0.0.44 — the binary on disk in
    // the active install dir (== fakeBin, since ACTIVE_OPENSHELL_BIN resolved
    // there and it is writable) was overwritten with the pinned 0.0.44 build.
    const replacedVersion = spawnSync(path.join(fakeBin, "openshell"), ["--version"], {
      encoding: "utf8",
    });
    expect(replacedVersion.status).toBe(0);
    expect(replacedVersion.stdout).toContain("0.0.44");
    expect(replacedVersion.stdout).not.toContain("0.0.45");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("openshell-version-pin: replaces sticky too-new openshell with pinned 0.0.44 via gh download", async ({
  artifacts,
}) => {
  await runVersionPinScenario(artifacts, { ghDownloadMode: "success" });
});

test("openshell-version-pin: falls back to curl when gh cannot fetch the pinned release", async ({
  artifacts,
}) => {
  await runVersionPinScenario(artifacts, { ghDownloadMode: "fail" });
});
