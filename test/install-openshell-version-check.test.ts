// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import credentialBoundaryManifest from "../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.72.json";
import { buildRebuildHermesChildEnv } from "./e2e/live/rebuild-hermes-env.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");
const CANDIDATE_RUNTIME = {
  cli: process.env.OPENSHELL_BIN,
  gateway: process.env.OPENSHELL_GATEWAY_BIN,
  resolutionId: process.env.NEMOCLAW_CANDIDATE_RESOLUTION_ID,
  sandbox: process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN,
  version: process.env.NEMOCLAW_CANDIDATE_VERSION,
};
const CANDIDATE_RUNTIME_ENABLED = Object.values(CANDIDATE_RUNTIME).every(Boolean);
const PINNED_OPEN_SHELL_SHA256 = {
  cliDarwinArm64: "117b5354cc42d80bc4d5e070ea5ac4e341208ff6d3c29b516d8a9c80e2310f8d",
  cliLinuxArm64: "a5ff01a3240d73c72ec1700eda6cc6c752a86cf50c5dd1b5bdc459f544d03045",
  cliLinuxX64: "37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4",
  gatewayDarwinArm64: "8c07362107393eb5f4ae4b9ee9f4257fd53862c51ad8dd96f2fe31bb6d8d7ffb",
  gatewayLinuxArm64: "a97dcb3acb04fb2d1170c1a2170228990c2337e25bb8c18817e5a6e952204108",
  gatewayLinuxX64: "03225fb9388b682af1a5f1614b26b75f828da6031e3ffc1fd920b6fbe5f70877",
  sandboxLinuxArm64: "2cf62cbd651e55d0f8750804e2b4025e0d6c8eea4564c87cda47a2c922941db0",
  sandboxLinuxX64: "811f914b6a6a3a3f4533449ddebebb6422333861a27a5fa848db6cbfdffdd230",
  sandboxBinaryLinuxX64: "f9f991a24d10772ad5d24ae27a8ea6baad8cac671695bd90fcd0355e0e0ad198",
};
const ZERO_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";
const REQUIRED_OPENSHELL_VERSION = credentialBoundaryManifest.openshellVersion;
const LEGACY_OPENSHELL_VERSION = "0.0.44";
const OPENSHELL_REWRITE_FEATURE_MARKERS =
  "request-body-credential-rewrite websocket-credential-rewrite";
const OPENSHELL_MCP_FEATURE_MARKER = "allow_all_known_mcp_methods";
const OPENSHELL_FEATURE_MARKERS = `${OPENSHELL_REWRITE_FEATURE_MARKERS} ${OPENSHELL_MCP_FEATURE_MARKER}`;
type OpenShellFeaturePlacement = "openshell" | "gateway" | "split-mcp-gateway" | "none";

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
    featurePlacement?: OpenShellFeaturePlacement;
    driverBins?: boolean | "gateway" | "gateway-vm";
    driverLocation?: "path" | "explicit" | "symlink";
    driverVersion?: string;
    sandboxVersion?: string;
    sandboxVersionExit?: number;
    sandboxBinaryDigest?: string;
    driverVersionExit?: number;
    driverReadable?: boolean;
    os?: string;
    arch?: string;
  } = {},
) {
  const capability = options.capability ?? true;
  const featurePlacement: OpenShellFeaturePlacement = capability
    ? (options.featurePlacement ?? "openshell")
    : "none";
  const openshellMarkers =
    featurePlacement === "openshell"
      ? OPENSHELL_FEATURE_MARKERS
      : featurePlacement === "split-mcp-gateway"
        ? OPENSHELL_REWRITE_FEATURE_MARKERS
        : "";
  const gatewayMarkers =
    featurePlacement === "gateway"
      ? OPENSHELL_FEATURE_MARKERS
      : featurePlacement === "split-mcp-gateway"
        ? OPENSHELL_MCP_FEATURE_MARKER
        : "";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-ver-"));
  try {
    const fakeBin = path.join(tmp, "bin");
    const driverBin = options.driverLocation ? path.join(tmp, "driver-bin") : fakeBin;
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(driverBin, { recursive: true });

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
${openshellMarkers ? `# ${openshellMarkers}` : ""}
exit 99`,
    );

    const driverFixtures: Array<{ name: string; markers: string }> =
      options.driverBins === false
        ? []
        : [
            { name: "openshell-gateway", markers: gatewayMarkers },
            ...(options.driverBins === "gateway"
              ? []
              : [
                  {
                    name: "openshell-sandbox",
                    markers: OPENSHELL_MCP_FEATURE_MARKER,
                  },
                ]),
            ...(options.driverBins === "gateway-vm"
              ? [
                  {
                    name: "openshell-driver-vm",
                    markers: OPENSHELL_MCP_FEATURE_MARKER,
                  },
                ]
              : []),
          ];
    for (const fixture of driverFixtures) {
      writeExecutable(
        path.join(driverBin, fixture.name),
        `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "${fixture.name} ${fixture.name === "openshell-sandbox" ? (options.sandboxVersion ?? options.driverVersion ?? version) : (options.driverVersion ?? version)}"; exit ${fixture.name === "openshell-sandbox" ? (options.sandboxVersionExit ?? options.driverVersionExit ?? 0) : (options.driverVersionExit ?? 0)}; fi
# ${fixture.markers}
exit 0`,
      );
      if (options.driverReadable === false) fs.chmodSync(path.join(driverBin, fixture.name), 0o111);
      if (options.driverLocation === "symlink") {
        fs.symlinkSync(path.join(driverBin, fixture.name), path.join(fakeBin, fixture.name));
      }
    }

    switch (options.sandboxBinaryDigest) {
      case undefined:
        break;
      default:
        writeExecutable(
          path.join(fakeBin, "sha256sum"),
          `#!/usr/bin/env bash
case "\${1:-}" in
  */openshell-sandbox)
    printf '%s  %s\\n' '${options.sandboxBinaryDigest}' "$1"
    exit 0
    ;;
esac
exit 1`,
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

    const explicitDriverEnv =
      options.driverLocation === "explicit"
        ? {
            NEMOCLAW_OPENSHELL_GATEWAY_BIN: path.join(driverBin, "openshell-gateway"),
            NEMOCLAW_OPENSHELL_SANDBOX_BIN: path.join(driverBin, "openshell-sandbox"),
          }
        : {};
    return spawnSync("bash", [SCRIPT], {
      env: {
        ...process.env,
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        ...explicitDriverEnv,
        ...extraEnv,
        PATH: `${fakeBin}:${driverBin}:/usr/bin:/bin`,
      },
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("install-openshell.sh version check", { timeout: 15_000 }, () => {
  it.runIf(CANDIDATE_RUNTIME_ENABLED)(
    "validates the receipt-bound candidate through the installer path (#6691)",
    () => {
      const context = `installer:${CANDIDATE_RUNTIME.resolutionId}`;
      const result = spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_CANDIDATE_INVOCATION_CONTEXT: context,
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          NEMOCLAW_OPENSHELL_GATEWAY_BIN: CANDIDATE_RUNTIME.gateway,
          NEMOCLAW_OPENSHELL_MAX_VERSION: CANDIDATE_RUNTIME.version,
          NEMOCLAW_OPENSHELL_MIN_VERSION: CANDIDATE_RUNTIME.version,
          NEMOCLAW_OPENSHELL_PIN_VERSION: CANDIDATE_RUNTIME.version,
          NEMOCLAW_OPENSHELL_SANDBOX_BIN: CANDIDATE_RUNTIME.sandbox,
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(`openshell already installed: ${CANDIDATE_RUNTIME.version}`);
    },
  );

  it("exits cleanly when the required OpenShell and driver binaries are already installed", () => {
    const result = runWithInstalledVersion(REQUIRED_OPENSHELL_VERSION);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`already installed: ${REQUIRED_OPENSHELL_VERSION}`);
  });

  it("accepts MCP L7 support from the installed gateway sidecar", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { featurePlacement: "split-mcp-gateway" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`already installed: ${REQUIRED_OPENSHELL_VERSION}`);
  });

  it("does not combine the OpenShell CLI with driver binaries from another PATH root", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { driverLocation: "path" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/missing Docker-driver binaries/);
    expect(result.stdout).toContain(
      `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
    );
  });

  it("accepts cross-prefix driver binaries only through explicit overrides", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { driverLocation: "explicit" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`already installed: ${REQUIRED_OPENSHELL_VERSION}`);
  });

  it("rejects mixed release components hidden behind one symlink directory", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { driverLocation: "symlink" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/gateway resolves outside the active CLI install root/);
  });

  it("rejects stale components copied into the active install root", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { driverVersion: "0.0.71" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/gateway does not match the active CLI build/);
  });

  it("rejects a component whose version probe fails after printing a version", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { driverVersionExit: 42 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/gateway does not match the active CLI build/);
  });

  it("accepts the exact pinned sandbox when its host-side version probe cannot load", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      {
        sandboxVersionExit: 127,
        sandboxBinaryDigest: PINNED_OPEN_SHELL_SHA256.sandboxBinaryLinuxX64,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`already installed: ${REQUIRED_OPENSHELL_VERSION}`);
  });

  it("rejects a non-runnable sandbox whose digest is not a pinned release artifact", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { sandboxVersionExit: 127, sandboxBinaryDigest: ZERO_SHA256 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/sandbox does not match the active CLI build/);
  });

  it("rejects a selected component that cannot be scanned", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { driverReadable: false },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/gateway is not readable and executable/);
  });

  it("rejects an executable directory supplied as an explicit component", () => {
    const explicitDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-openshell-component-dir-"),
    );
    try {
      const result = runWithInstalledVersion(
        REQUIRED_OPENSHELL_VERSION,
        {
          NEMOCLAW_OPENSHELL_GATEWAY_BIN: explicitDirectory,
          NEMOCLAW_OPENSHELL_SANDBOX_BIN: explicitDirectory,
        },
        { os: "Darwin", arch: "arm64" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/explicit OpenShell gateway binary.*missing.*not executable/);
    } finally {
      fs.rmSync(explicitDirectory, { recursive: true, force: true });
    }
  });

  it("triggers reinstall when the required OpenShell is missing Docker-driver binaries", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { driverBins: false, os: "Linux" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/missing Docker-driver binaries/);
    expect(result.stdout).toContain(
      `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
    );
  });

  it("fails closed when the required OpenShell lacks required messaging rewrite support", () => {
    const result = runWithInstalledVersion(REQUIRED_OPENSHELL_VERSION, {}, { capability: false });
    expect(result.status).toBe(1);
    // `fail()` writes to stderr as of #3446; previously stdout.
    expect(result.stderr).toMatch(/missing request-body-credential-rewrite support/);
  });

  it("accepts macOS OpenShell when the gateway binary is installed", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      {
        driverBins: "gateway",
        os: "Darwin",
        arch: "arm64",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`already installed: ${REQUIRED_OPENSHELL_VERSION}`);
  });

  it("ignores a stale sibling sandbox binary for a macOS VM-driver install", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      { os: "Darwin", arch: "arm64", sandboxVersion: LEGACY_OPENSHELL_VERSION },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`already installed: ${REQUIRED_OPENSHELL_VERSION}`);
  });

  it("does not require the macOS VM driver entitlement for Docker-driver onboarding", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-codesign-"));
    try {
      const state = path.join(tmp, "codesign-state");
      const log = path.join(tmp, "codesign.log");
      const result = runWithInstalledVersion(
        REQUIRED_OPENSHELL_VERSION,
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
      expect(result.stdout).toContain(`already installed: ${REQUIRED_OPENSHELL_VERSION}`);
      expect(result.stdout).not.toMatch(/missing the macOS Hypervisor entitlement/);
      expect(result.stdout).not.toMatch(/Signing openshell-driver-vm/);
      expect(result.stdout).not.toMatch(/Installing OpenShell from release/);
      expect(fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "").toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("triggers reinstall on macOS when OpenShell is missing required gateway binaries", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      {
        driverBins: false,
        os: "Darwin",
        arch: "arm64",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/missing Docker-driver binaries/);
    expect(result.stdout).toContain(
      `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
    );
  });

  it.each([
    { archiveShape: "safe", status: 0, unsafe: false },
    { archiveShape: "absolute", status: 1, unsafe: true },
    { archiveShape: "traversal", status: 1, unsafe: true },
    { archiveShape: "duplicate", status: 1, unsafe: true },
    { archiveShape: "extra", status: 1, unsafe: true },
    { archiveShape: "symlink", status: 1, unsafe: true },
    { archiveShape: "hardlink", status: 1, unsafe: true },
    { archiveShape: "device", status: 1, unsafe: true },
    { archiveShape: "late-traversal", status: 1, unsafe: true },
  ] as const)("$archiveShape macOS arm64 archives are checked before extraction", (expected) => {
    const { archiveShape } = expected;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-macos-assets-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const downloadLog = path.join(tmp, "downloads.log");
      const tarLog = path.join(tmp, "tar.log");
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
printf '%s\\n' "$*" >> ${JSON.stringify(tarLog)}
case "$*" in
*openshell-gateway*) name="openshell-gateway" ;;
*) name="openshell" ;;
esac
case "\${1:-}" in
-tzf)
  case ${JSON.stringify(archiveShape)} in
    absolute) printf '/tmp/%s\\n' "$name" ;;
    traversal) printf '../%s\\n' "$name" ;;
    duplicate) printf '%s\\n%s\\n' "$name" "$name" ;;
    extra) printf '%s\\nunexpected\\n' "$name" ;;
    late-traversal)
      if [ "$name" = "openshell-gateway" ]; then printf '../%s\\n' "$name"; else printf '%s\\n' "$name"; fi
      ;;
    *) printf '%s\\n' "$name" ;;
  esac
  exit 0
  ;;
-tvzf)
  case ${JSON.stringify(archiveShape)} in
    symlink) printf 'lrwxrwxrwx 0/0 0 2026-01-01 00:00 %s -> target\\n' "$name" ;;
    hardlink) printf 'hrwxr-xr-x 0/0 0 2026-01-01 00:00 %s link to target\\n' "$name" ;;
    device) printf 'crw-rw-rw- 0/0 1,3 2026-01-01 00:00 %s\\n' "$name" ;;
    *) printf '%s\\n' "-rwxr-xr-x 0/0 1 2026-01-01 00:00 $name" ;;
  esac
  exit 0
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
printf '#!/usr/bin/env bash\nexit 0\n' > "$outdir/$name"
chmod 755 "$outdir/$name"
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "install"),
        `#!/usr/bin/env bash
dest="\${@: -1}"
mkdir -p "$(dirname "$dest")"
  cat > "$dest" <<'EOF'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell ${REQUIRED_OPENSHELL_VERSION}"; exit 0; fi
# ${OPENSHELL_FEATURE_MARKERS}
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

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expected.status);
      expect(result.stderr.includes("Unsafe OpenShell archive")).toBe(expected.unsafe);
      const installedVersion = spawnSync(path.join(fakeBin, "openshell"), ["--version"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(installedVersion).toBe(
        expected.unsafe ? "openshell 0.0.36" : `openshell ${REQUIRED_OPENSHELL_VERSION}`,
      );
      expect(/^xzf /m.test(fs.readFileSync(tarLog, "utf8"))).toBe(!expected.unsafe);
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
case "$*" in
*openshell-gateway*) name="openshell-gateway" ;;
*openshell-sandbox*) name="openshell-sandbox" ;;
*) name="openshell" ;;
esac
case "\${1:-}" in
-tzf) printf '%s\\n' "$name"; exit 0 ;;
-tvzf) printf '%s\\n' "-rwxr-xr-x 0/0 1 2026-01-01 00:00 $name"; exit 0 ;;
esac
outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then outdir="$arg"; break; fi
  prev="$arg"
done
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
  printf '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "openshell ${REQUIRED_OPENSHELL_VERSION}"; else exit 0; fi\n# ${OPENSHELL_FEATURE_MARKERS}\n' > "$dest"
  ;;
openshell-sandbox)
  printf '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "openshell-sandbox ${REQUIRED_OPENSHELL_VERSION}"; exit 0; fi\n# ${OPENSHELL_MCP_FEATURE_MARKER}\nexit 0\n' > "$dest"
  ;;
openshell-gateway)
  printf '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "openshell-gateway ${REQUIRED_OPENSHELL_VERSION}"; exit 0; fi\nexit 0\n' > "$dest"
  ;;
*)
  printf '#!/usr/bin/env bash\nexit 0\n' > "$dest"
  ;;
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
case "$*" in
*openshell-gateway*) name="openshell-gateway" ;;
*openshell-sandbox*) name="openshell-sandbox" ;;
*) name="openshell" ;;
esac
case "\${1:-}" in
-tzf) printf '%s\\n' "$name"; exit 0 ;;
-tvzf) printf '%s\\n' "-rwxr-xr-x 0/0 1 2026-01-01 00:00 $name"; exit 0 ;;
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
  printf '#!/usr/bin/env bash\\nif [ "$1" = "--version" ]; then echo "openshell ${REQUIRED_OPENSHELL_VERSION}"; else exit 0; fi\\n# ${OPENSHELL_FEATURE_MARKERS}\\n' > "$dest"
  ;;
openshell-sandbox)
  printf '#!/usr/bin/env bash\\nif [ "$1" = "--version" ]; then echo "openshell-sandbox ${REQUIRED_OPENSHELL_VERSION}"; exit 0; fi\\n# ${OPENSHELL_MCP_FEATURE_MARKER}\\nexit 0\\n' > "$dest"
  ;;
openshell-gateway)
  printf '#!/usr/bin/env bash\\nif [ "$1" = "--version" ]; then echo "openshell-gateway ${REQUIRED_OPENSHELL_VERSION}"; exit 0; fi\\nexit 0\\n' > "$dest"
  ;;
openshell-driver-vm)
  printf '#!/usr/bin/env bash\\n# ${OPENSHELL_MCP_FEATURE_MARKER}\\nexit 0\\n' > "$dest"
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
    expect(result.stdout).toContain(
      `above the maximum (${REQUIRED_OPENSHELL_VERSION}) supported by this NemoClaw release`,
    );
    expect(result.stdout).toContain(`reinstalling pinned OpenShell ${REQUIRED_OPENSHELL_VERSION}`);
    expect(result.stdout).toContain(
      `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
    );
    expect(result.stderr).not.toMatch(/Upgrade NemoClaw first/);
  });

  it("reinstalls the pinned release when openshell is at a much newer version", () => {
    const result = runWithInstalledVersion("0.1.0");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      `above the maximum (${REQUIRED_OPENSHELL_VERSION}) supported by this NemoClaw release`,
    );
    expect(result.stdout).toContain(`reinstalling pinned OpenShell ${REQUIRED_OPENSHELL_VERSION}`);
    expect(result.stdout).toContain(
      `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
    );
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

  it("accepts coherent dev components with different git-prefix lengths", () => {
    const result = runWithInstalledVersion(
      "0.0.72-dev.8+g7bce1223d",
      {
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      },
      { driverVersion: "0.0.72-dev.8+g7bce1223" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/dev channel/);
  });

  it("refreshes a dev build when Docker-driver binaries are missing", () => {
    const result = runWithInstalledVersion(
      `${LEGACY_OPENSHELL_VERSION}.dev84+g6b2180425`,
      {
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      },
      { driverBins: false, os: "Linux" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/required dev-channel messaging-rewrite\/MCP-L7 build/);
    expect(result.stdout).toContain("Installing OpenShell from release 'dev'");
  });

  it("refreshes a Linux dev build when the sandbox binary alone is missing", () => {
    const result = runWithInstalledVersion(
      `${LEGACY_OPENSHELL_VERSION}.dev84+g6b2180425`,
      {
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      },
      { driverBins: "gateway", os: "Linux" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Installing OpenShell from release 'dev'");
  });

  it("reuses a macOS dev build with its required standalone gateway", () => {
    const result = runWithInstalledVersion(
      "0.0.72-dev.8+g7bce1223d",
      {
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      },
      { driverBins: "gateway", os: "Darwin", arch: "arm64" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/dev channel/);
  });

  it("refreshes an installed dev build when current main is required", () => {
    const result = runWithInstalledVersion("0.0.72-dev.8+g7bce1223d", {
      NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_OPENSHELL_FORCE_INSTALL: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("refreshing the moving dev release");
    expect(result.stdout).toContain("Installing OpenShell from release 'dev'");
  });

  it("keeps auto on the stable release-selection contract", () => {
    const result = runWithInstalledVersion("0.0.36", {
      NEMOCLAW_OPENSHELL_CHANNEL: "auto",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
    );
    expect(result.stdout).not.toContain("Installing OpenShell from release 'dev'");
  });

  it("preserves the rebuild Hermes requested channel through the real installer boundary", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        BUILDX_BUILDER: "external-builder",
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
        NVIDIA_API_KEY: "must-not-reach-child",
      },
      {},
    );
    const result = runWithInstalledVersion("0.0.36", childEnv);

    expect(childEnv.NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL).toBe("1");
    expect(childEnv.NEMOCLAW_OPENSHELL_CHANNEL).toBe("dev");
    expect(childEnv.NVIDIA_API_KEY).toBeUndefined();
    expect(childEnv.BUILDX_BUILDER).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Installing OpenShell from release 'dev'");
    expect(result.stdout).not.toContain(
      `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
    );
  });

  it("upgrades stable OpenShell when the dev channel is requested", () => {
    const result = runWithInstalledVersion("0.0.36", {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/required dev-channel messaging-rewrite\/MCP-L7 build/);
  });

  it("rejects the removed artifact channel", () => {
    const result = runWithInstalledVersion("0.0.72", {
      NEMOCLAW_OPENSHELL_CHANNEL: "artifact",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEMOCLAW_OPENSHELL_CHANNEL must be one of: stable, dev, auto");
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
