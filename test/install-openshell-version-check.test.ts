// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");
const PINNED_OPEN_SHELL_SHA256 = {
  cliDarwinArm64: "117b5354cc42d80bc4d5e070ea5ac4e341208ff6d3c29b516d8a9c80e2310f8d",
  cliLinuxArm64: "a5ff01a3240d73c72ec1700eda6cc6c752a86cf50c5dd1b5bdc459f544d03045",
  cliLinuxX64: "37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4",
  gatewayDarwinArm64: "8c07362107393eb5f4ae4b9ee9f4257fd53862c51ad8dd96f2fe31bb6d8d7ffb",
  gatewayLinuxArm64: "a97dcb3acb04fb2d1170c1a2170228990c2337e25bb8c18817e5a6e952204108",
  gatewayLinuxX64: "03225fb9388b682af1a5f1614b26b75f828da6031e3ffc1fd920b6fbe5f70877",
  sandboxLinuxArm64: "2cf62cbd651e55d0f8750804e2b4025e0d6c8eea4564c87cda47a2c922941db0",
  sandboxLinuxX64: "811f914b6a6a3a3f4533449ddebebb6422333861a27a5fa848db6cbfdffdd230",
};
const ZERO_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";

function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

/**
 * Run install-openshell.sh with a fake `openshell` binary that reports the
 * given version. The download/install code path is never reached because we
 * either exit early (version + capability ok / missing capability)
 * or hit an upgrade/reinstall warn and then the script tries to download — so we stub
 * curl and gh to fail fast.
 */
function runWithInstalledVersion(
  version: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options: {
    capability?: boolean;
    driverBins?: boolean | "gateway" | "gateway-vm";
    os?: string;
    arch?: string;
  } = {},
) {
  const capability = options.capability ?? true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-ver-"));
  try {
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);

    writeExecutable(
      path.join(fakeBin, "uname"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then echo "${options.arch ?? "x86_64"}"; else echo "${options.os ?? "Linux"}"; fi`,
    );

    // Fake openshell that reports the given version
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell ${version}"; exit 0; fi
${capability ? "# request-body-credential-rewrite websocket-credential-rewrite" : ""}
exit 99`,
    );

    if (options.driverBins !== false) {
      writeExecutable(
        path.join(fakeBin, "openshell-gateway"),
        `#!/usr/bin/env bash
exit 0`,
      );
    }
    if (options.driverBins !== false && options.driverBins !== "gateway") {
      writeExecutable(
        path.join(fakeBin, "openshell-sandbox"),
        `#!/usr/bin/env bash
exit 0`,
      );
    }
    if (options.driverBins === "gateway-vm") {
      writeExecutable(
        path.join(fakeBin, "openshell-driver-vm"),
        `#!/usr/bin/env bash
exit 0`,
      );
    }

    // Stub curl to fail so the install path exits without doing real network I/O
    writeExecutable(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
echo "curl stub: $*" >&2
exit 1`,
    );

    // Stub gh CLI similarly
    writeExecutable(
      path.join(fakeBin, "gh"),
      `#!/usr/bin/env bash
exit 1`,
    );

    if ((options.os ?? "Linux") === "Darwin") {
      writeExecutable(
        path.join(fakeBin, "codesign"),
        `#!/usr/bin/env bash
state="\${NEMOCLAW_FAKE_CODESIGN_STATE:-}"
if [ "\${1:-}" = "-d" ]; then
  if [ "\${NEMOCLAW_FAKE_CODESIGN_HAS_ENTITLEMENT:-1}" = "1" ] || { [ -n "$state" ] && [ -f "$state" ]; }; then
    printf '%s\\n' '<plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>'
  fi
  exit 0
fi
if [ -n "\${NEMOCLAW_FAKE_CODESIGN_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "$NEMOCLAW_FAKE_CODESIGN_LOG"
fi
if [ -n "$state" ]; then
  : > "$state"
fi
exit 0`,
      );
    }

    return spawnSync("bash", [SCRIPT], {
      env: {
        ...process.env,
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        ...extraEnv,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("install-openshell.sh version check", { timeout: 15_000 }, () => {
  it("exits cleanly when openshell 0.0.72 and driver binaries are already installed", () => {
    const result = runWithInstalledVersion("0.0.72");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/already installed.*0\.0\.72/);
  });

  it("triggers reinstall when openshell 0.0.72 is missing Docker-driver binaries", () => {
    const result = runWithInstalledVersion("0.0.72", {}, { driverBins: false, os: "Linux" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/missing Docker-driver binaries/);
    expect(result.stdout).toMatch(/Installing OpenShell from release 'v0\.0\.72'/);
  });

  it("fails closed when openshell 0.0.72 lacks required messaging rewrite support", () => {
    const result = runWithInstalledVersion("0.0.72", {}, { capability: false });
    expect(result.status).toBe(1);
    // `fail()` writes to stderr as of #3446; previously stdout.
    expect(result.stderr).toMatch(/missing request-body-credential-rewrite support/);
  });

  it("accepts macOS openshell 0.0.72 when the gateway binary is installed", () => {
    const result = runWithInstalledVersion(
      "0.0.72",
      {},
      {
        driverBins: "gateway",
        os: "Darwin",
        arch: "arm64",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/already installed.*0\.0\.72/);
  });

  it("does not require the macOS VM driver entitlement for Docker-driver onboarding", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-codesign-"));
    try {
      const state = path.join(tmp, "codesign-state");
      const log = path.join(tmp, "codesign.log");
      const result = runWithInstalledVersion(
        "0.0.72",
        {
          NEMOCLAW_FAKE_CODESIGN_HAS_ENTITLEMENT: "0",
          NEMOCLAW_FAKE_CODESIGN_STATE: state,
          NEMOCLAW_FAKE_CODESIGN_LOG: log,
        },
        {
          driverBins: "gateway-vm",
          os: "Darwin",
          arch: "arm64",
        },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/already installed.*0\.0\.72/);
      expect(result.stdout).not.toMatch(/missing the macOS Hypervisor entitlement/);
      expect(result.stdout).not.toMatch(/Signing openshell-driver-vm/);
      expect(result.stdout).not.toMatch(/Installing OpenShell from release/);
      expect(fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "").toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("triggers reinstall on macOS when openshell 0.0.72 is missing required gateway binaries", () => {
    const result = runWithInstalledVersion(
      "0.0.72",
      {},
      {
        driverBins: false,
        os: "Darwin",
        arch: "arm64",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/missing Docker-driver binaries/);
    expect(result.stdout).toMatch(/Installing OpenShell from release 'v0\.0\.72'/);
  });

  it("downloads the macOS arm64 gateway asset during reinstall", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-macos-assets-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const downloadLog = path.join(tmp, "downloads.log");
      fs.mkdirSync(fakeBin);

      writeExecutable(
        path.join(fakeBin, "uname"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then echo "arm64"; else echo "Darwin"; fi`,
      );
      writeExecutable(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi
exit 99`,
      );
      writeExecutable(
        path.join(fakeBin, "gh"),
        `#!/usr/bin/env bash
exit 1`,
      );
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(downloadLog)}
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="$1"
  fi
  shift || true
done
if [ -n "$out" ]; then
  case "$(basename "$out")" in
  openshell-checksums-sha256.txt)
    printf '%s\n' \
      '${PINNED_OPEN_SHELL_SHA256.cliDarwinArm64}  openshell-aarch64-apple-darwin.tar.gz' > "$out"
    ;;
  openshell-gateway-checksums-sha256.txt)
    printf '%s\n' \
      '${PINNED_OPEN_SHELL_SHA256.gatewayDarwinArm64}  openshell-gateway-aarch64-apple-darwin.tar.gz' > "$out"
    ;;
  *)
    : > "$out"
    ;;
  esac
fi
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "sha256sum"),
        `#!/usr/bin/env bash
cat >/dev/null
echo "checksum OK"
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "tar"),
        `#!/usr/bin/env bash
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "install"),
        `#!/usr/bin/env bash
dest="\${@: -1}"
mkdir -p "$(dirname "$dest")"
cat > "$dest" <<'EOF'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell 0.0.72"; exit 0; fi
# request-body-credential-rewrite websocket-credential-rewrite
exit 0
EOF
chmod +x "$dest"
exit 0`,
      );

      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          XDG_BIN_HOME: path.join(tmp, "local-bin"),
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const downloads = fs.readFileSync(downloadLog, "utf-8");
      expect(downloads).toContain("openshell-aarch64-apple-darwin.tar.gz");
      expect(downloads).toContain("openshell-gateway-aarch64-apple-darwin.tar.gz");
      expect(downloads).not.toContain("openshell-driver-vm-aarch64-apple-darwin.tar.gz");
      expect(downloads).toContain("openshell-gateway-checksums-sha256.txt");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("downloads and verifies every Linux arm64 release asset during reinstall", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-linux-arm64-assets-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const downloadLog = path.join(tmp, "downloads.log");
      const checksumLog = path.join(tmp, "checksums.log");
      fs.mkdirSync(fakeBin);

      writeExecutable(
        path.join(fakeBin, "uname"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then echo "aarch64"; else echo "Linux"; fi`,
      );
      writeExecutable(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi
exit 99`,
      );
      writeExecutable(path.join(fakeBin, "gh"), "#!/usr/bin/env bash\nexit 1\n");
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(downloadLog)}
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift || true
done
case "$(basename "$out")" in
openshell-checksums-sha256.txt)
  printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.cliLinuxArm64}  openshell-aarch64-unknown-linux-musl.tar.gz' > "$out" ;;
openshell-gateway-checksums-sha256.txt)
  printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.gatewayLinuxArm64}  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz' > "$out" ;;
openshell-sandbox-checksums-sha256.txt)
  printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.sandboxLinuxArm64}  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz' > "$out" ;;
*) : > "$out" ;;
esac
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "sha256sum"),
        `#!/usr/bin/env bash
[ "$#" -eq 2 ] && [ "$1" = "-c" ] && [ "$2" = "-" ] || exit 9
line="$(cat)"
case "$line" in
'${PINNED_OPEN_SHELL_SHA256.cliLinuxArm64}  openshell-aarch64-unknown-linux-musl.tar.gz'|\
'${PINNED_OPEN_SHELL_SHA256.gatewayLinuxArm64}  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz'|\
'${PINNED_OPEN_SHELL_SHA256.sandboxLinuxArm64}  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz') ;;
*) exit 10 ;;
esac
printf '%s\n' "$line" >> ${JSON.stringify(checksumLog)}
printf '%s\n' 'checksum OK'`,
      );
      writeExecutable(
        path.join(fakeBin, "tar"),
        `#!/usr/bin/env bash
outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then outdir="$arg"; break; fi
  prev="$arg"
done
case "$*" in
*openshell-gateway*) name="openshell-gateway" ;;
*openshell-sandbox*) name="openshell-sandbox" ;;
*) name="openshell" ;;
esac
printf '#!/usr/bin/env bash\nexit 0\n' > "$outdir/$name"
chmod 755 "$outdir/$name"`,
      );
      writeExecutable(
        path.join(fakeBin, "install"),
        `#!/usr/bin/env bash
dest="\${@: -1}"
mkdir -p "$(dirname "$dest")"
case "$(basename "$dest")" in
openshell)
  printf '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "openshell 0.0.72"; else exit 0; fi\n# request-body-credential-rewrite websocket-credential-rewrite\n' > "$dest" ;;
*) printf '#!/usr/bin/env bash\nexit 0\n' > "$dest" ;;
esac
chmod 755 "$dest"`,
      );

      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          XDG_BIN_HOME: path.join(tmp, "local-bin"),
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const downloads = fs.readFileSync(downloadLog, "utf8");
      expect(downloads).toContain("openshell-aarch64-unknown-linux-musl.tar.gz");
      expect(downloads).toContain("openshell-gateway-aarch64-unknown-linux-gnu.tar.gz");
      expect(downloads).toContain("openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz");
      expect(fs.readFileSync(checksumLog, "utf8").trim().split("\n")).toEqual([
        `${PINNED_OPEN_SHELL_SHA256.cliLinuxArm64}  openshell-aarch64-unknown-linux-musl.tar.gz`,
        `${PINNED_OPEN_SHELL_SHA256.gatewayLinuxArm64}  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz`,
        `${PINNED_OPEN_SHELL_SHA256.sandboxLinuxArm64}  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz`,
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("upgrades into the active writable openshell directory to avoid PATH shadowing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-active-dir-"));
    try {
      const activeBin = path.join(tmp, "active-bin");
      const fakeBin = path.join(tmp, "fake-bin");
      const installLog = path.join(tmp, "install.log");
      fs.mkdirSync(activeBin);
      fs.mkdirSync(fakeBin);

      writeExecutable(
        path.join(activeBin, "openshell"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi
exit 99`,
      );

      writeExecutable(
        path.join(fakeBin, "uname"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then echo "x86_64"; else echo "Linux"; fi`,
      );
      writeExecutable(
        path.join(fakeBin, "gh"),
        `#!/usr/bin/env bash
exit 1`,
      );
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="$1"
  fi
  shift || true
done
if [ -n "$out" ]; then
  case "$(basename "$out")" in
  openshell-checksums-sha256.txt)
    printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.cliLinuxX64}  openshell-x86_64-unknown-linux-musl.tar.gz' > "$out"
    ;;
  openshell-gateway-checksums-sha256.txt)
    printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.gatewayLinuxX64}  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz' > "$out"
    ;;
  openshell-sandbox-checksums-sha256.txt)
    printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.sandboxLinuxX64}  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz' > "$out"
    ;;
  *)
    : > "$out"
    ;;
  esac
fi
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "sha256sum"),
        `#!/usr/bin/env bash
cat >/dev/null
echo "checksum OK"
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "tar"),
        `#!/usr/bin/env bash
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
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$outdir/$name"
chmod 755 "$outdir/$name"
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "install"),
        `#!/usr/bin/env bash
dest="\${@: -1}"
printf '%s\\n' "$dest" >> ${JSON.stringify(installLog)}
mkdir -p "$(dirname "$dest")"
case "$(basename "$dest")" in
openshell)
  printf '#!/usr/bin/env bash\\nif [ "$1" = "--version" ]; then echo "openshell 0.0.72"; else exit 0; fi\\n# request-body-credential-rewrite websocket-credential-rewrite\\n' > "$dest"
  ;;
*)
  printf '#!/usr/bin/env bash\\nexit 0\\n' > "$dest"
  ;;
esac
chmod 755 "$dest"
exit 0`,
      );

      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${fakeBin}:${activeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const installedTargets = fs.readFileSync(installLog, "utf-8");
      expect(installedTargets).toContain(path.join(activeBin, "openshell"));
      expect(installedTargets).toContain(path.join(activeBin, "openshell-gateway"));
      expect(installedTargets).toContain(path.join(activeBin, "openshell-sandbox"));
      expect(installedTargets).not.toContain("/usr/local/bin/openshell");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects release checksum files that disagree with NemoClaw-pinned OpenShell digests", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-pinned-digest-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const tarLog = path.join(tmp, "tar.log");
      const installLog = path.join(tmp, "install.log");
      fs.mkdirSync(fakeBin);

      writeExecutable(
        path.join(fakeBin, "uname"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then echo "x86_64"; else echo "Linux"; fi`,
      );
      writeExecutable(
        path.join(fakeBin, "openshell"),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell 0.0.36"; exit 0; fi
# request-body-credential-rewrite websocket-credential-rewrite
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "gh"),
        `#!/usr/bin/env bash
exit 1`,
      );
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    out="$1"
  fi
  shift || true
done
if [ -n "$out" ]; then
  case "$(basename "$out")" in
  openshell-checksums-sha256.txt)
    printf '%s\n' '${ZERO_SHA256}  openshell-x86_64-unknown-linux-musl.tar.gz' > "$out"
    ;;
  openshell-gateway-checksums-sha256.txt)
    printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.gatewayLinuxX64}  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz' > "$out"
    ;;
  openshell-sandbox-checksums-sha256.txt)
    printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.sandboxLinuxX64}  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz' > "$out"
    ;;
  *)
    : > "$out"
    ;;
  esac
fi
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "sha256sum"),
        `#!/usr/bin/env bash
cat >/dev/null
echo "checksum OK"
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "tar"),
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(tarLog)}
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "install"),
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(installLog)}
exit 0`,
      );

      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(
        "OpenShell release checksum for openshell-x86_64-unknown-linux-musl.tar.gz does not match NemoClaw-pinned v0.0.72 digest",
      );
      expect(fs.existsSync(tarLog) ? fs.readFileSync(tarLog, "utf-8") : "").toBe("");
      expect(fs.existsSync(installLog) ? fs.readFileSync(installLog, "utf-8") : "").toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("triggers upgrade when openshell 0.0.38 is installed (below current floor)", () => {
    const result = runWithInstalledVersion("0.0.38");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/below minimum.*upgrading/);
  });

  it("triggers upgrade when openshell 0.0.28 is installed (below MIN_VERSION)", () => {
    const result = runWithInstalledVersion("0.0.28");
    // Script should warn about upgrade then fail at the download step (curl stub fails)
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/below minimum.*upgrading/);
  });

  it("triggers upgrade when openshell 0.0.26 is installed (Landlock-vulnerable version)", () => {
    const result = runWithInstalledVersion("0.0.26");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/below minimum.*upgrading/);
  });

  it("triggers upgrade when openshell 0.0.24 is installed (old minimum)", () => {
    const result = runWithInstalledVersion("0.0.24");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/below minimum.*upgrading/);
  });

  it("reinstalls the pinned release when openshell is above MAX_VERSION", () => {
    const result = runWithInstalledVersion("0.0.73");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/above the maximum.*reinstalling pinned OpenShell 0\.0\.72/);
    expect(result.stdout).toMatch(/Installing OpenShell from release 'v0\.0\.72'/);
    expect(result.stderr).not.toMatch(/Upgrade NemoClaw first/);
  });

  it("reinstalls the pinned release when openshell is at a much newer version", () => {
    const result = runWithInstalledVersion("0.1.0");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/above the maximum.*reinstalling pinned OpenShell 0\.0\.72/);
    expect(result.stdout).toMatch(/Installing OpenShell from release 'v0\.0\.72'/);
    expect(result.stderr).not.toMatch(/Upgrade NemoClaw first/);
  });

  it("accepts an installed OpenShell dev-channel Docker-driver build", () => {
    const result = runWithInstalledVersion("0.0.72.dev84+g6b2180425", {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dev channel/);
    expect(result.stdout).toMatch(/Dev channel install skips SHA-256 verification/);
  });

  it("fails closed for dev-channel installs without explicit risk acceptance", () => {
    const result = runWithInstalledVersion("0.0.72.dev84+g6b2180425", {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Set NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL=1 to explicitly accept an unverified OpenShell dev-channel install.",
    );
  });

  it("upgrades stable OpenShell when the dev channel is requested", () => {
    const result = runWithInstalledVersion("0.0.36", {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/required dev-channel messaging-rewrite build/);
  });

  it("proceeds to install when openshell is not present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-noop-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      fs.mkdirSync(fakeBin);

      // No openshell binary — just stub curl/gh to fail fast
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
echo "curl stub: $*" >&2
exit 1`,
      );
      writeExecutable(
        path.join(fakeBin, "gh"),
        `#!/usr/bin/env bash
exit 1`,
      );

      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      // Should attempt install (not exit 0 early) and fail at the download step
      expect(result.stdout).toMatch(/Installing OpenShell from release/);
      expect(result.status).not.toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
