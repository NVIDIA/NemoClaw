// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "install-openshell.sh");
const REQUIRED_OPENSHELL_VERSION = "0.0.72";
const LEGACY_OPENSHELL_VERSION = "0.0.44";
const OPENSHELL_REWRITE_FEATURE_MARKERS =
  "request-body-credential-rewrite websocket-credential-rewrite";
const OPENSHELL_MCP_FEATURE_MARKER = "allow_all_known_mcp_methods";
const OPENSHELL_LIFECYCLE_FEATURE_MARKER = "policy-authorized-lifecycle-exec-v1";
const OPENSHELL_HERMES_MCP_OPERATION = "nemoclaw.hermes-mcp-config-transaction-v1";
const OPENSHELL_FEATURE_MARKERS = `${OPENSHELL_REWRITE_FEATURE_MARKERS} ${OPENSHELL_MCP_FEATURE_MARKER} ${OPENSHELL_LIFECYCLE_FEATURE_MARKER} ${OPENSHELL_HERMES_MCP_OPERATION}`;
const OPENSHELL_MCP_TRANSPORT_FEATURE_MARKER =
  "authenticated-mcp-policy-bound-credential-rewrite-v1";
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
        ? `${OPENSHELL_MCP_FEATURE_MARKER} ${OPENSHELL_LIFECYCLE_FEATURE_MARKER} ${OPENSHELL_HERMES_MCP_OPERATION}`
        : "";
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
                    markers: `${OPENSHELL_MCP_TRANSPORT_FEATURE_MARKER} ${OPENSHELL_LIFECYCLE_FEATURE_MARKER} ${OPENSHELL_HERMES_MCP_OPERATION}`,
                  },
                ]),
            ...(options.driverBins === "gateway-vm"
              ? [
                  {
                    name: "openshell-driver-vm",
                    markers: `${OPENSHELL_MCP_TRANSPORT_FEATURE_MARKER} ${OPENSHELL_LIFECYCLE_FEATURE_MARKER} ${OPENSHELL_HERMES_MCP_OPERATION}`,
                  },
                ]
              : []),
          ];
    for (const fixture of driverFixtures) {
      writeExecutable(
        path.join(fakeBin, fixture.name),
        `#!/usr/bin/env bash
# ${fixture.markers}
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
      'ignored  openshell-aarch64-apple-darwin.tar.gz' > "$out"
    ;;
  openshell-gateway-checksums-sha256.txt)
    printf '%s\n' \
      'ignored  openshell-gateway-aarch64-apple-darwin.tar.gz' > "$out"
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
if [ "\${1:-}" = "--version" ]; then echo "openshell ${REQUIRED_OPENSHELL_VERSION}"; exit 0; fi
# ${OPENSHELL_FEATURE_MARKERS} ${OPENSHELL_MCP_TRANSPORT_FEATURE_MARKER}
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
    printf '%s\n' 'ignored  openshell-x86_64-unknown-linux-musl.tar.gz' > "$out"
    ;;
  openshell-gateway-checksums-sha256.txt)
    printf '%s\n' 'ignored  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz' > "$out"
    ;;
  openshell-sandbox-checksums-sha256.txt)
    printf '%s\n' 'ignored  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz' > "$out"
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
  printf '#!/usr/bin/env bash\\nif [ "$1" = "--version" ]; then echo "openshell ${REQUIRED_OPENSHELL_VERSION}"; else exit 0; fi\\n# ${OPENSHELL_FEATURE_MARKERS}\\n' > "$dest"
  ;;
openshell-sandbox|openshell-driver-vm)
  printf '#!/usr/bin/env bash\\n# ${OPENSHELL_MCP_TRANSPORT_FEATURE_MARKER} ${OPENSHELL_LIFECYCLE_FEATURE_MARKER} ${OPENSHELL_HERMES_MCP_OPERATION}\\nexit 0\\n' > "$dest"
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
    const result = runWithInstalledVersion(`${LEGACY_OPENSHELL_VERSION}.dev84+g6b2180425`, {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dev channel/);
  });

  it("refreshes an installed dev build when current main is required", () => {
    const result = runWithInstalledVersion(`${LEGACY_OPENSHELL_VERSION}.dev84+g6b2180425`, {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_OPENSHELL_FORCE_INSTALL: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("refreshing the moving dev release");
    expect(result.stdout).toContain("Installing OpenShell from release 'dev'");
  });

  it("upgrades stable OpenShell when the dev channel is requested", () => {
    const result = runWithInstalledVersion("0.0.36", {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
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
