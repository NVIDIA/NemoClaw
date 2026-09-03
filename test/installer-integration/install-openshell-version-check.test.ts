// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import credentialBoundaryManifest from "../../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.106.json";
import {
  BREW_OUTCOMES,
  CANDIDATE_RUNTIME,
  CANDIDATE_RUNTIME_ENABLED,
  OPENSHELL_FEATURE_MARKERS,
  OPENSHELL_MCP_FEATURE_MARKER,
  OPENSHELL_REWRITE_FEATURE_MARKERS,
  PINNED_OPEN_SHELL_SHA256,
  trustedFormulaBoundaryEvents,
  unverifiedFormulaBoundaryEvents,
  ZERO_SHA256,
} from "../helpers/openshell-release-fixtures";

const SCRIPT = path.join(import.meta.dirname, "../..", "scripts", "install-openshell.sh");
const REQUIRED_OPENSHELL_VERSION = credentialBoundaryManifest.openshellVersion;
const LEGACY_OPENSHELL_VERSION = "0.0.44";
type OpenShellFeaturePlacement = "openshell" | "gateway" | "split-mcp-gateway" | "none";

function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}
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
    homebrewAvailable?: boolean;
    homebrewFormulaDownload?: boolean;
    homebrewFormulaDigest?: string;
    homebrewOperationLog?: string;
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

    writeExecutable(
      path.join(fakeBin, "curl"),
      options.homebrewFormulaDownload
        ? `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift || true
done
[ -n "$out" ] || exit 1
printf '%s\n' '# downloaded OpenShell formula' 'class Openshell < Formula' > "$out"
exit 0`
        : `#!/usr/bin/env bash
echo "curl stub: $*" >&2
exit 1`,
    );

    writeExecutable(
      path.join(fakeBin, "gh"),
      `#!/usr/bin/env bash
exit 1`,
    );

    if ((options.os ?? "Linux") === "Darwin") {
      const tap = path.join(tmp, "tap");
      const formula = path.join(tap, "Formula", "openshell.rb");
      fs.mkdirSync(path.dirname(formula), { recursive: true });
      fs.writeFileSync(formula, "class Openshell < Formula\nend\n");
      writeExecutable(
        path.join(fakeBin, "sha256sum"),
        `#!/usr/bin/env bash
case "\${1:-}" in
  ${JSON.stringify(formula)})
    if grep -q '^# downloaded OpenShell formula$' "$1"; then
      printf '%s  %s\\n' '${PINNED_OPEN_SHELL_SHA256.formula}' "$1"
    else
      printf '%s  %s\\n' '${options.homebrewFormulaDigest ?? PINNED_OPEN_SHELL_SHA256.formula}' "$1"
    fi
    ;;
  */openshell.rb) printf '%s  %s\\n' '${PINNED_OPEN_SHELL_SHA256.formula}' "$1" ;;
  *) /usr/bin/sha256sum "$@" ;;
esac`,
      );
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
      switch (options.homebrewAvailable ?? true) {
        case true:
          writeExecutable(
            path.join(fakeBin, "brew"),
            `#!/usr/bin/env bash
${options.homebrewOperationLog ? `printf '%s\\n' "$*" >> ${JSON.stringify(options.homebrewOperationLog)}` : ""}
case "$*" in
  "--repository nvidia/openshell") printf '%s\\n' ${JSON.stringify(tap)}; exit 0 ;;
  "list --formula openshell")
    exit 0
    ;;
  "info --json=v2 openshell")
    printf '%s\n' '{"formulae":[{"name":"openshell","tap":"nvidia/openshell"}]}'
    exit 0
    ;;
  "services restart openshell")
    exit 0
    ;;
  "install --formula nvidia/openshell/openshell"|"reinstall --formula nvidia/openshell/openshell")
    exit "\${NEMOCLAW_TEST_BREW_INSTALL_STATUS:-0}"
    ;;
  "--prefix")
    printf '%s\\n' ${JSON.stringify(tmp)}
    exit 0
    ;;
esac
exit 0`,
          );
          break;
      }
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

  it("reuses the standalone macOS gateway when Homebrew is unavailable", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      {
        driverBins: "gateway-vm",
        homebrewAvailable: false,
        os: "Darwin",
        arch: "arm64",
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "Homebrew is not installed; reusing the standalone OpenShell gateway without reboot persistence.",
    );
    expect(result.stdout).toContain(`already installed: ${REQUIRED_OPENSHELL_VERSION}`);
    expect(result.stdout).not.toContain("Installing OpenShell from release");
  });

  it("triggers reinstall on macOS when the Homebrew formula digest is stale", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-stale-formula-"));
    try {
      const brewLog = path.join(tmp, "brew.log");
      const result = runWithInstalledVersion(
        REQUIRED_OPENSHELL_VERSION,
        { NEMOCLAW_TEST_BREW_INSTALL_STATUS: "1" },
        {
          driverBins: "gateway",
          homebrewFormulaDigest: ZERO_SHA256,
          homebrewFormulaDownload: true,
          homebrewOperationLog: brewLog,
          os: "Darwin",
          arch: "arm64",
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toMatch(/cannot confirm the pinned Homebrew gateway formula/);
      expect(result.stdout).toContain(
        `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
      );
      expect(fs.readFileSync(brewLog, "utf-8")).toContain(
        trustedFormulaBoundaryEvents("reinstall --formula nvidia/openshell/openshell").join("\n"),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the macOS Homebrew formula does not match the pinned digest", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-macos-formula-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const downloadLog = path.join(tmp, "downloads.log");
      const brewLog = path.join(tmp, "brew.log");
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
[ -n "$out" ] || exit 1
printf '%s\\n' 'class Openshell < Formula' > "$out"
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "sha256sum"),
        `#!/usr/bin/env bash
printf '%s  %s\\n' '${ZERO_SHA256}' "$1"`,
      );
      writeExecutable(
        path.join(fakeBin, "brew"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(brewLog)}
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
        `OpenShell Homebrew formula checksum does not match NemoClaw-pinned v${REQUIRED_OPENSHELL_VERSION} digest`,
      );
      expect(fs.readFileSync(downloadLog, "utf-8")).toContain("openshell.rb");
      expect(fs.existsSync(brewLog) ? fs.readFileSync(brewLog, "utf-8") : "").toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("revokes verified macOS Homebrew formula trust after install and reinstall outcomes (#7451)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-macos-formula-"));
    try {
      const fakeBin = path.join(tmp, "bin");
      const homebrewPrefix = path.join(tmp, "homebrew");
      const tapRepo = path.join(tmp, "tap");
      const downloadLog = path.join(tmp, "downloads.log");
      const brewLog = path.join(tmp, "brew.log");
      const formulaTmpDir = path.join(tmp, "formula-tmp");
      const untrustCount = path.join(tmp, "untrust-count");
      fs.mkdirSync(fakeBin);
      fs.mkdirSync(path.join(homebrewPrefix, "bin"), { recursive: true });

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
      writeExecutable(path.join(fakeBin, "gh"), "#!/usr/bin/env bash\nexit 1\n");
      writeExecutable(
        path.join(fakeBin, "mktemp"),
        `#!/usr/bin/env bash
mkdir -p ${JSON.stringify(formulaTmpDir)}
printf '%s\\n' ${JSON.stringify(formulaTmpDir)}`,
      );
      writeExecutable(
        path.join(fakeBin, "curl"),
        `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(downloadLog)}
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift; out="$1"
  fi
  shift || true
done
[ -n "$out" ] || exit 1
cat > "$out" <<'EOF'
class Openshell < Formula
  def post_install
    entitlements.write <<~XML
      <plist/>
    XML
  end
end
EOF
exit 0`,
      );
      writeExecutable(
        path.join(fakeBin, "sha256sum"),
        `#!/usr/bin/env bash
printf '%s  %s\\n' '${PINNED_OPEN_SHELL_SHA256.formula}' "$1"`,
      );
      writeExecutable(
        path.join(fakeBin, "brew"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(brewLog)}
case "$*" in
  "tap-info nvidia/openshell")
    exit 1
    ;;
  "tap-new --no-git nvidia/openshell")
    mkdir -p ${JSON.stringify(path.join(tapRepo, "Formula"))}
    exit 0
    ;;
  "--repository nvidia/openshell")
    printf '%s\\n' ${JSON.stringify(tapRepo)}
    exit 0
    ;;
  "help trust")
    exit "\${NEMOCLAW_TEST_BREW_TRUST_HELP_STATUS:-0}"
    ;;
  "help untrust")
    exit "\${NEMOCLAW_TEST_BREW_UNTRUST_HELP_STATUS:-0}"
    ;;
  "trust --formula nvidia/openshell/openshell")
    exit "\${NEMOCLAW_TEST_BREW_TRUST_STATUS:-0}"
    ;;
  "untrust --formula nvidia/openshell/openshell")
    count=0
    if [ -f ${JSON.stringify(untrustCount)} ]; then
      count="$(cat ${JSON.stringify(untrustCount)})"
    fi
    count=$((count + 1))
    printf '%s\\n' "$count" > ${JSON.stringify(untrustCount)}
    if [ "$count" -gt 1 ]; then
      exit "\${NEMOCLAW_TEST_BREW_UNTRUST_CLEANUP_STATUS:-\${NEMOCLAW_TEST_BREW_UNTRUST_STATUS:-0}}"
    fi
    exit "\${NEMOCLAW_TEST_BREW_UNTRUST_STATUS:-0}"
    ;;
  "list --formula openshell")
    exit "\${NEMOCLAW_TEST_BREW_LIST_STATUS:-1}"
    ;;
  "install --formula nvidia/openshell/openshell"|"reinstall --formula nvidia/openshell/openshell")
    if [ "\${NEMOCLAW_TEST_BREW_INSTALL_STATUS:-0}" -ne 0 ]; then
      exit "$NEMOCLAW_TEST_BREW_INSTALL_STATUS"
    fi
    cat > ${JSON.stringify(path.join(homebrewPrefix, "bin", "openshell"))} <<'EOF'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell \${NEMOCLAW_TEST_INSTALLED_VERSION:-${REQUIRED_OPENSHELL_VERSION}}"; exit 0; fi
# ${OPENSHELL_FEATURE_MARKERS}
exit 0
EOF
    cat > ${JSON.stringify(path.join(homebrewPrefix, "bin", "openshell-gateway"))} <<'EOF'
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell-gateway \${NEMOCLAW_TEST_INSTALLED_VERSION:-${REQUIRED_OPENSHELL_VERSION}}"; exit 0; fi
exit 0
EOF
    chmod 755 ${JSON.stringify(path.join(homebrewPrefix, "bin", "openshell"))} ${JSON.stringify(path.join(homebrewPrefix, "bin", "openshell-gateway"))}
    exit 0
    ;;
  "--prefix")
    printf '%s\\n' ${JSON.stringify(homebrewPrefix)}
    exit 0
    ;;
esac
exit 1`,
      );

      const runStable = (overrides: NodeJS.ProcessEnv = {}) =>
        spawnSync("bash", [SCRIPT], {
          env: {
            ...process.env,
            HOME: tmp,
            XDG_BIN_HOME: path.join(tmp, "local-bin"),
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            PATH: `${fakeBin}:/usr/bin:/bin`,
            ...overrides,
          },
          encoding: "utf8",
        });
      const result = runStable();

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const downloads = fs.readFileSync(downloadLog, "utf-8");
      expect(downloads).toContain("openshell.rb");
      expect(downloads).not.toContain("openshell-aarch64-apple-darwin.tar.gz");
      const brewEvents = fs.readFileSync(brewLog, "utf-8").trim().split("\n");
      expect(brewEvents).toEqual([
        "tap-info nvidia/openshell",
        "tap-new --no-git nvidia/openshell",
        "--repository nvidia/openshell",
        ...trustedFormulaBoundaryEvents("list --formula openshell"),
        ...trustedFormulaBoundaryEvents("install --formula nvidia/openshell/openshell"),
        "--prefix",
      ]);
      expect(result.stdout).toContain(
        "OpenShell Homebrew service staged; onboarding will start it after gateway validation.",
      );
      const stagedFormula = fs.readFileSync(path.join(tapRepo, "Formula", "openshell.rb"), "utf-8");
      expect(stagedFormula).toContain("entitlements.write <<~XML");

      for (const [listStatus, actionStatus, action, expectedStatus] of BREW_OUTCOMES) {
        fs.writeFileSync(brewLog, "");
        fs.writeFileSync(untrustCount, "0");
        const attempt = runStable({
          NEMOCLAW_TEST_BREW_INSTALL_STATUS: actionStatus,
          NEMOCLAW_TEST_BREW_LIST_STATUS: listStatus,
        });
        expect(attempt.status, `${attempt.stdout}\n${attempt.stderr}`).toBe(expectedStatus);
        expect(fs.readFileSync(brewLog, "utf-8").trim().split("\n")).toEqual([
          "tap-info nvidia/openshell",
          "tap-new --no-git nvidia/openshell",
          "--repository nvidia/openshell",
          ...trustedFormulaBoundaryEvents("list --formula openshell"),
          ...trustedFormulaBoundaryEvents(`${action} --formula nvidia/openshell/openshell`),
          ...(expectedStatus === 0 ? ["--prefix"] : []),
        ]);
        expect(fs.readFileSync(untrustCount, "utf-8").trim()).toBe("4");
        expect(fs.existsSync(formulaTmpDir)).toBe(false);
      }

      fs.writeFileSync(brewLog, "");
      const refusedTrust = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          XDG_BIN_HOME: path.join(tmp, "local-bin"),
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          NEMOCLAW_TEST_BREW_TRUST_STATUS: "1",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(refusedTrust.status, `${refusedTrust.stdout}\n${refusedTrust.stderr}`).toBeGreaterThan(
        0,
      );
      expect(refusedTrust.stderr).toContain(
        "OpenShell Homebrew formula verification or temporary trust setup failed (status 67)",
      );
      const refusedTrustEvents = fs.readFileSync(brewLog, "utf-8").trim().split("\n");
      expect(refusedTrustEvents).toContain("help trust");
      expect(refusedTrustEvents).toContain("trust --formula nvidia/openshell/openshell");
      expect(refusedTrustEvents).not.toContain("install --formula nvidia/openshell/openshell");
      expect(refusedTrustEvents).not.toContain("reinstall --formula nvidia/openshell/openshell");

      fs.writeFileSync(brewLog, "");
      const unsupportedTrust = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          XDG_BIN_HOME: path.join(tmp, "local-bin"),
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          NEMOCLAW_TEST_BREW_TRUST_HELP_STATUS: "1",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(
        unsupportedTrust.status,
        `${unsupportedTrust.stdout}\n${unsupportedTrust.stderr}`,
      ).toBeGreaterThan(0);
      expect(unsupportedTrust.stderr).toContain(
        "OpenShell Homebrew formula verification or temporary trust setup failed (status 67)",
      );
      const unsupportedTrustEvents = fs.readFileSync(brewLog, "utf-8").trim().split("\n");
      expect(unsupportedTrustEvents).toContain("help trust");
      expect(unsupportedTrustEvents).not.toContain("trust --formula nvidia/openshell/openshell");
      expect(unsupportedTrustEvents).not.toContain("install --formula nvidia/openshell/openshell");

      fs.writeFileSync(brewLog, "");
      const missingUntrust = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          XDG_BIN_HOME: path.join(tmp, "local-bin"),
          NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
          NEMOCLAW_OPENSHELL_CHANNEL: "dev",
          NEMOCLAW_TEST_BREW_UNTRUST_HELP_STATUS: "1",
          NEMOCLAW_TEST_INSTALLED_VERSION: "0.0.106-dev.8+g7bce1223d",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(
        missingUntrust.status,
        `${missingUntrust.stdout}\n${missingUntrust.stderr}`,
      ).toBeGreaterThan(0);
      expect(missingUntrust.stderr).toContain(
        "OpenShell Homebrew formula verification or temporary trust setup failed (status 67)",
      );
      const missingUntrustEvents = fs.readFileSync(brewLog, "utf-8").trim().split("\n");
      expect(missingUntrustEvents).toContain("help trust");
      expect(missingUntrustEvents).toContain("help untrust");
      expect(missingUntrustEvents).not.toContain("untrust --formula nvidia/openshell/openshell");
      expect(missingUntrustEvents).not.toContain("install --formula nvidia/openshell/openshell");

      fs.writeFileSync(brewLog, "");
      fs.writeFileSync(untrustCount, "0");
      const refusedUntrust = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          XDG_BIN_HOME: path.join(tmp, "local-bin"),
          NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
          NEMOCLAW_OPENSHELL_CHANNEL: "dev",
          NEMOCLAW_TEST_BREW_UNTRUST_STATUS: "1",
          NEMOCLAW_TEST_INSTALLED_VERSION: "0.0.106-dev.8+g7bce1223d",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(
        refusedUntrust.status,
        `${refusedUntrust.stdout}\n${refusedUntrust.stderr}`,
      ).toBeGreaterThan(0);
      expect(refusedUntrust.stderr).toContain(
        "OpenShell Homebrew formula verification or temporary trust setup failed (status 67)",
      );
      const refusedUntrustEvents = fs.readFileSync(brewLog, "utf-8").trim().split("\n");
      expect(refusedUntrustEvents).toContain("help trust");
      expect(refusedUntrustEvents).toContain("help untrust");
      expect(refusedUntrustEvents).toContain("untrust --formula nvidia/openshell/openshell");
      expect(refusedUntrustEvents).not.toContain("install --formula nvidia/openshell/openshell");

      fs.writeFileSync(brewLog, "");
      fs.writeFileSync(untrustCount, "0");
      const failedCleanupUntrust = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          XDG_BIN_HOME: path.join(tmp, "local-bin"),
          NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
          NEMOCLAW_OPENSHELL_CHANNEL: "dev",
          NEMOCLAW_TEST_BREW_INSTALL_STATUS: "1",
          NEMOCLAW_TEST_BREW_UNTRUST_CLEANUP_STATUS: "1",
          NEMOCLAW_TEST_INSTALLED_VERSION: "0.0.106-dev.8+g7bce1223d",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(
        failedCleanupUntrust.status,
        `${failedCleanupUntrust.stdout}\n${failedCleanupUntrust.stderr}`,
      ).toBeGreaterThan(0);
      expect(failedCleanupUntrust.stderr).toContain(
        "OpenShell Homebrew formula verification or temporary trust setup failed (status 68)",
      );
      expect(fs.readFileSync(brewLog, "utf-8").trim().split("\n")).toEqual([
        "tap-info nvidia/openshell",
        "tap-new --no-git nvidia/openshell",
        "--repository nvidia/openshell",
        ...unverifiedFormulaBoundaryEvents("list --formula openshell"),
      ]);
      expect(fs.existsSync(path.join(formulaTmpDir, "openshell.rb"))).toBe(false);

      fs.writeFileSync(brewLog, "");
      fs.writeFileSync(untrustCount, "0");
      const devInstall = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          HOME: tmp,
          XDG_BIN_HOME: path.join(tmp, "local-bin"),
          NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
          NEMOCLAW_OPENSHELL_CHANNEL: "dev",
          NEMOCLAW_TEST_BREW_TRUST_STATUS: "1",
          NEMOCLAW_TEST_INSTALLED_VERSION: "0.0.106-dev.8+g7bce1223d",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });

      expect(devInstall.status, `${devInstall.stdout}\n${devInstall.stderr}`).toBe(0);
      const devBrewEvents = fs.readFileSync(brewLog, "utf-8").trim().split("\n");
      expect(devBrewEvents).toEqual([
        "tap-info nvidia/openshell",
        "tap-new --no-git nvidia/openshell",
        "--repository nvidia/openshell",
        ...unverifiedFormulaBoundaryEvents("list --formula openshell"),
        ...unverifiedFormulaBoundaryEvents("install --formula nvidia/openshell/openshell"),
        "--prefix",
      ]);
      expect(devBrewEvents).not.toContain("trust --formula nvidia/openshell/openshell");
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
        "OpenShell release checksum for openshell-x86_64-unknown-linux-musl.tar.gz does not match NemoClaw-pinned v0.0.106 digest",
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

  it("reinstalls the pinned release when openshell 0.0.107 is above MAX_VERSION", () => {
    const result = runWithInstalledVersion("0.0.107");
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
    const result = runWithInstalledVersion("0.0.106.dev84+g6b2180425", {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/dev channel/);
    expect(result.stdout).toMatch(/Dev channel install skips SHA-256 verification/);
  });

  it("fails closed for dev-channel installs without explicit risk acceptance", () => {
    const result = runWithInstalledVersion("0.0.106.dev84+g6b2180425", {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Set NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL=1 to explicitly accept an unverified OpenShell dev-channel install.",
    );
  });

  it("accepts coherent dev components with different git-prefix lengths", () => {
    const result = runWithInstalledVersion(
      "0.0.106-dev.8+g7bce1223d",
      {
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      },
      { driverVersion: "0.0.106-dev.8+g7bce1223" },
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

  it("reuses a macOS dev build with its required Homebrew gateway service", () => {
    const result = runWithInstalledVersion(
      "0.0.106-dev.8+g7bce1223d",
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
    const result = runWithInstalledVersion("0.0.106-dev.8+g7bce1223d", {
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
