// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createLinuxArm64DownloadFixture } from "../support/openshell-arm64-download";
import {
  createInstalledOpenShellFixture,
  type InstalledOpenShellOptions,
  writeExecutable,
  writeFixtureMktemp,
} from "../support/openshell-installed-version";

import credentialBoundaryManifest from "../../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.116.json";
import {
  BREW_OUTCOMES,
  CANDIDATE_RUNTIME,
  CANDIDATE_RUNTIME_ENABLED,
  OPENSHELL_FEATURE_MARKERS,
  OPENSHELL_MCP_FEATURE_MARKER,
  PINNED_OPEN_SHELL_SHA256,
  trustedFormulaBoundaryEvents,
  ZERO_SHA256,
} from "../helpers/openshell-release-fixtures";

const SCRIPT = path.join(import.meta.dirname, "../..", "scripts", "install-openshell.sh");
const REQUIRED_OPENSHELL_VERSION = credentialBoundaryManifest.openshellVersion;
const LEGACY_OPENSHELL_VERSION = "0.0.44";

function runWithInstalledVersion(
  version: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options: InstalledOpenShellOptions = {},
) {
  const fixture = createInstalledOpenShellFixture(version, extraEnv, options);
  try {
    return spawnSync("bash", [SCRIPT], { env: fixture.env, encoding: "utf8" });
  } finally {
    fs.rmSync(fixture.tmp, { recursive: true, force: true });
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

  it("requests the Darwin Arm64 gateway archive instead of the VM-driver archive when driver binaries are missing", () => {
    const result = runWithInstalledVersion(
      REQUIRED_OPENSHELL_VERSION,
      {},
      {
        arch: "arm64",
        driverBins: false,
        homebrewAvailable: false,
        homebrewFormulaDownload: true,
        os: "Darwin",
      },
    );
    expect(result.stderr).toContain("openshell-gateway-aarch64-apple-darwin.tar.gz");
    expect(result.stderr).not.toContain("openshell-driver-vm-aarch64-apple-darwin.tar.gz");
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
      writeFixtureMktemp(fakeBin, tmp);

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
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds stalled Linux arm64 release downloads and verifies every asset (#11281)", () => {
    const { tmp, fakeBin, downloadLog, checksumLog } = createLinuxArm64DownloadFixture();
    try {
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
      const boundedInvocation = new RegExp(
        "^(?!.*--(?:max-time|retry-all-errors)\\b)" +
          "(?=.*--connect-timeout[ \\t]+10(?:[ \\t]|$))" +
          "(?=.*--retry[ \\t]+3(?:[ \\t]|$))" +
          "(?=.*--retry-delay[ \\t]+2(?:[ \\t]|$))" +
          "(?=.*--speed-limit[ \\t]+1024(?:[ \\t]|$))" +
          "(?=.*--speed-time[ \\t]+60(?:[ \\t]|$)).*$",
        "gm",
      );
      expect(downloads.match(boundedInvocation)).toHaveLength(6);
      expect(downloads).toContain("openshell-aarch64-unknown-linux-musl.tar.gz");
      expect(downloads).toContain("openshell-gateway-aarch64-unknown-linux-gnu.tar.gz");
      expect(downloads).toContain("openshell-sandbox-aarch64-unknown-linux-musl.tar.gz");
      expect(fs.readFileSync(checksumLog, "utf8").trim().split("\n")).toEqual([
        `${PINNED_OPEN_SHELL_SHA256.cliLinuxArm64}  openshell-aarch64-unknown-linux-musl.tar.gz`,
        `${PINNED_OPEN_SHELL_SHA256.gatewayLinuxArm64}  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz`,
        `${PINNED_OPEN_SHELL_SHA256.sandboxLinuxArm64}  openshell-sandbox-aarch64-unknown-linux-musl.tar.gz`,
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("creates owner-safe user-local directories in a direct install under umask 0002 (#12496)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    try {
      fs.rmSync(path.join(fakeBin, "openshell"));
      const bashEnv = path.join(tmp, "force-user-local-install.sh");
      fs.writeFileSync(
        bashEnv,
        `function [ {
  if [[ "$#" -eq 3 && "$1" = "-w" && "$2" = "/usr/local/bin" && "$3" = "]" ]]; then
    return 1
  fi
  builtin [ "$@"
}
`,
      );
      const previousUmask = process.umask(0o002);
      let directInstall;
      try {
        directInstall = spawnSync("bash", [SCRIPT], {
          env: {
            ...process.env,
            BASH_ENV: bashEnv,
            HOME: tmp,
            XDG_BIN_HOME: "",
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            NEMOCLAW_TEST_USER_LOCAL_ONLY: "1",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
          encoding: "utf8",
        });
      } finally {
        process.umask(previousUmask);
      }
      expect(directInstall.status, `${directInstall.stdout}\n${directInstall.stderr}`).toBe(0);
      expect({
        local: fs.statSync(path.join(tmp, ".local")).mode & 0o777,
        bin: fs.statSync(path.join(tmp, ".local", "bin")).mode & 0o777,
      }).toEqual({ local: 0o755, bin: 0o755 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("falls back from a writable unsafe system default in interactive mode (#12496)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    try {
      fs.rmSync(path.join(fakeBin, "openshell"));
      const localBin = path.join(tmp, ".local", "bin");
      const bashEnv = path.join(tmp, "unsafe-system-target.sh");
      fs.writeFileSync(
        bashEnv,
        `function [ {
  if [[ "$#" -eq 3 && "$1" = "-w" && "$2" = "/usr/local/bin" && "$3" = "]" ]]; then return 0; fi
  if [[ "$#" -eq 4 && "$1" = "!" && "$2" = "-t" && "$3" = "0" && "$4" = "]" ]]; then return 1; fi
  builtin [ "$@"
}
function stat {
  if [[ " $* " == *" /usr/local/bin "* ]]; then printf "0 775\\n"; return 0; fi
  command stat "$@"
}
`,
      );
      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          BASH_ENV: bashEnv,
          HOME: tmp,
          XDG_BIN_HOME: "",
          NEMOCLAW_NON_INTERACTIVE: "",
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.existsSync(path.join(localBin, "openshell"))).toBe(true);
      expect(fs.existsSync(path.join(localBin, "openshell-gateway"))).toBe(true);
      expect(fs.statSync(localBin).mode & 0o777).toBe(0o755);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it.each(["", "1"])(
    "replaces an unsafe existing destination through the private directory with noninteractive=%s (#14268)",
    (nonInteractive) => {
      const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
      try {
        const oldBinary = fs.readFileSync(path.join(fakeBin, "openshell"));
        fs.chmodSync(fakeBin, 0o775);
        const privateBin = path.join(tmp, ".local", "bin");
        const result = spawnSync("bash", [SCRIPT], {
          env: {
            ...process.env,
            HOME: tmp,
            XDG_BIN_HOME: "",
            NEMOCLAW_NON_INTERACTIVE: nonInteractive,
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
          encoding: "utf8",
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fs.readFileSync(path.join(fakeBin, "openshell"))).toEqual(oldBinary);
        expect(fs.statSync(fakeBin).mode & 0o777).toBe(0o775);
        const installedVersion = spawnSync(path.join(privateBin, "openshell"), ["--version"], {
          encoding: "utf8",
        });
        expect(installedVersion.status).toBe(0);
        expect(installedVersion.stdout).toContain(`openshell ${REQUIRED_OPENSHELL_VERSION}`);
        expect(fs.existsSync(path.join(privateBin, "openshell-gateway"))).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("replaces the safe nonwritable active system binary in interactive mode (#14268)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    const systemBin = path.join(tmp, "system-bin");
    fs.mkdirSync(systemBin);
    try {
      fs.renameSync(path.join(fakeBin, "openshell"), path.join(systemBin, "openshell"));
      const sudoLog = path.join(tmp, "sudo.log");
      writeExecutable(
        path.join(fakeBin, "sudo"),
        `#!/usr/bin/env bash
[[ "$1" = install && "\${@: -1}" == "$HOME/system-bin/"* ]] || exit 97
printf '%s\\n' "$*" >> "$HOME/sudo.log"
chmod u+w "$HOME/system-bin"
"$@"
status=$?
chmod 555 "$HOME/system-bin"
exit "$status"
`,
      );
      const bashEnv = path.join(tmp, "interactive-safe-system.sh");
      fs.writeFileSync(
        bashEnv,
        `function [ {
  if [[ "$#" = 3 && "$1" = -t && "$2" = 0 ]]; then return 0; fi
  if [[ "$#" = 4 && "$1" = '!' && "$2" = -t && "$3" = 0 ]]; then return 1; fi
  builtin [ "$@"
}
function stat {
  if [[ " $* " == *" $HOME/system-bin "* ]]; then printf '0 755\\n'; return 0; fi
  command stat "$@"
}
`,
      );
      fs.chmodSync(systemBin, 0o555);
      // Confine the system destination to the fixture before executing the real installer.
      const installer = path.join(tmp, "install-openshell.sh");
      fs.writeFileSync(
        installer,
        fs.readFileSync(SCRIPT, "utf8").replaceAll("/usr/local/bin", systemBin),
      );
      const result = spawnSync("bash", [installer], {
        env: {
          ...process.env,
          BASH_ENV: bashEnv,
          HOME: tmp,
          XDG_BIN_HOME: "",
          NEMOCLAW_NON_INTERACTIVE: "",
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          PATH: `${systemBin}:${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const active = spawnSync(path.join(systemBin, "openshell"), ["--version"], {
        encoding: "utf8",
      });
      expect(active.status).toBe(0);
      expect(active.stdout.trim()).toBe(`openshell ${REQUIRED_OPENSHELL_VERSION}`);
      expect(fs.readFileSync(sudoLog, "utf8")).toContain(` ${path.join(systemBin, "openshell")}`);
      expect(fs.existsSync(path.join(tmp, ".local", "bin", "openshell"))).toBe(false);
    } finally {
      fs.chmodSync(systemBin, 0o755);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("selects the prepared replacement when its directory already occurs later on PATH (#14268)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    try {
      const privateBin = path.join(tmp, ".local", "bin");
      fs.mkdirSync(privateBin, { recursive: true });
      fs.chmodSync(fakeBin, 0o775);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
source "$1/scripts/install.sh" >/dev/null 2>&1
NEMOCLAW_SOURCE_ROOT="$1"
_NEMOCLAW_PREPARED_OPENSHELL_INSTALL_DIR="$2"
spin() { shift; "$@"; }
install_nemoclaw_openshell_gateway_user_service() { :; }
maybe_install_openshell_during_install force
[ "$(command -v openshell)" = "$2/openshell" ]
[ "$NEMOCLAW_OPENSHELL_BIN" = "$2/openshell" ]
[ "$(resolve_openshell_gateway_bin_for_service)" = "$2/openshell-gateway" ]
`,
          "test",
          path.resolve(import.meta.dirname, "../.."),
          privateBin,
        ],
        {
          env: {
            ...process.env,
            HOME: tmp,
            XDG_BIN_HOME: "",
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            PATH: `${fakeBin}:${privateBin}:/usr/bin:/bin`,
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rechecks the prepared directory through the installer caller before replacement (#14268)", () => {
    const { tmp, fakeBin, downloadLog } = createLinuxArm64DownloadFixture();
    try {
      const env = {
        ...process.env,
        HOME: tmp,
        XDG_BIN_HOME: "",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        PATH: `${fakeBin}:/usr/bin:/bin`,
      };
      const preparation = spawnSync("bash", [SCRIPT, "--prepare-install-directory"], {
        env,
        encoding: "utf8",
      });
      expect(preparation.status, preparation.stdout + preparation.stderr).toBe(0);
      expect(preparation.stdout.trim()).toBe(fakeBin);
      expect(fs.existsSync(downloadLog)).toBe(false);
      const oldBinary = fs.readFileSync(path.join(fakeBin, "openshell"));
      fs.chmodSync(fakeBin, 0o775);
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
source "$1/scripts/install.sh" >/dev/null 2>&1
NEMOCLAW_SOURCE_ROOT="$1"
_NEMOCLAW_PREPARED_OPENSHELL_INSTALL_DIR="$2"
spin() { shift; "$@"; }
install_nemoclaw_openshell_gateway_user_service() { :; }
maybe_install_openshell_during_install force
`,
          "test",
          path.resolve(import.meta.dirname, "../.."),
          preparation.stdout.trim(),
        ],
        { env, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unsafe prepared executable directory");
      expect(fs.readFileSync(path.join(fakeBin, "openshell"))).toEqual(oldBinary);
      expect(fs.existsSync(path.join(tmp, ".local", "bin"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe system directory before invoking sudo (#12496)", () => {
    const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
    try {
      fs.rmSync(path.join(fakeBin, "openshell"));
      const sudoLog = path.join(tmp, "sudo.log");
      writeExecutable(
        path.join(fakeBin, "sudo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$NEMOCLAW_TEST_SUDO_LOG"\nexit 99\n',
      );
      const bashEnv = path.join(tmp, "unsafe-privileged-system-target.sh");
      fs.writeFileSync(
        bashEnv,
        `function [ {
  if [[ "$#" -eq 3 && "$1" = "-w" && "$2" = "/usr/local/bin" && "$3" = "]" ]]; then return 1; fi
  if [[ "$#" -eq 4 && "$1" = "!" && "$2" = "-t" && "$3" = "0" && "$4" = "]" ]]; then return 1; fi
  if [[ "$#" -eq 3 && "$1" = "-t" && "$2" = "0" && "$3" = "]" ]]; then return 0; fi
  builtin [ "$@"
}
function stat {
  if [[ " $* " == *" /usr/local/bin "* ]]; then printf "0 775\\n"; return 0; fi
  command stat "$@"
}
`,
      );
      const result = spawnSync("bash", [SCRIPT], {
        env: {
          ...process.env,
          BASH_ENV: bashEnv,
          HOME: tmp,
          NEMOCLAW_NON_INTERACTIVE: "",
          NEMOCLAW_OPENSHELL_CHANNEL: "stable",
          NEMOCLAW_TEST_SUDO_LOG: sudoLog,
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("Unsafe executable directory /usr/local/bin");
      expect(fs.existsSync(sudoLog)).toBe(false);
      expect(fs.existsSync(path.join(tmp, ".local", "bin", "openshell"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it.each(["writable ancestor", "symlinked bin"])(
    "rejects a %s before publishing a direct user-local binary (#12496)",
    (unsafePath) => {
      const { tmp, fakeBin } = createLinuxArm64DownloadFixture();
      try {
        fs.rmSync(path.join(fakeBin, "openshell"));
        const local = path.join(tmp, ".local");
        const bin = path.join(local, "bin");
        const outside = path.join(tmp, "outside");
        fs.mkdirSync(local);
        const makeUnsafe: Record<string, () => void> = {
          "writable ancestor": () => {
            fs.mkdirSync(bin);
            fs.chmodSync(local, 0o775);
          },
          "symlinked bin": () => {
            fs.mkdirSync(outside);
            fs.symlinkSync(outside, bin);
          },
        };
        makeUnsafe[unsafePath]();
        const bashEnv = path.join(tmp, "force-user-local-install.sh");
        fs.writeFileSync(
          bashEnv,
          `function [ {
  if [[ "$#" -eq 3 && "$1" = "-w" && "$2" = "/usr/local/bin" && "$3" = "]" ]]; then
    return 1
  fi
  builtin [ "$@"
}
`,
        );
        const result = spawnSync("bash", [SCRIPT], {
          env: {
            ...process.env,
            BASH_ENV: bashEnv,
            HOME: tmp,
            XDG_BIN_HOME: "",
            NEMOCLAW_NON_INTERACTIVE: "1",
            NEMOCLAW_OPENSHELL_CHANNEL: "stable",
            NEMOCLAW_TEST_USER_LOCAL_ONLY: "1",
            PATH: `${fakeBin}:/usr/bin:/bin`,
          },
          encoding: "utf8",
        });

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
        expect(result.stderr).toContain(unsafePath === "writable ancestor" ? local : bin);
        expect(
          fs.existsSync(path.join(unsafePath === "writable ancestor" ? bin : outside, "openshell")),
        ).toBe(false);
        const assertUnchanged: Record<string, () => void> = {
          "writable ancestor": () => expect(fs.statSync(local).mode & 0o777).toBe(0o775),
          "symlinked bin": () => expect(fs.lstatSync(bin).isSymbolicLink()).toBe(true),
        };
        assertUnchanged[unsafePath]();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("upgrades into the active writable openshell directory to avoid PATH shadowing", () => {
    const tmp = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "nemoclaw-openshell-active-dir-"),
    );
    try {
      const activeBin = path.join(tmp, "active-bin");
      const fakeBin = path.join(tmp, "fake-bin");
      const installLog = path.join(tmp, "install.log");
      fs.mkdirSync(activeBin);
      fs.mkdirSync(fakeBin);
      writeFixtureMktemp(fakeBin, tmp);

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
    printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.sandboxLinuxX64}  openshell-sandbox-x86_64-unknown-linux-musl.tar.gz' > "$out"
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
      writeFixtureMktemp(fakeBin, tmp);

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
    printf '%s\n' '${PINNED_OPEN_SHELL_SHA256.sandboxLinuxX64}  openshell-sandbox-x86_64-unknown-linux-musl.tar.gz' > "$out"
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
        `OpenShell release checksum for openshell-x86_64-unknown-linux-musl.tar.gz does not match NemoClaw-pinned v${REQUIRED_OPENSHELL_VERSION} digest`,
      );
      expect(fs.existsSync(tarLog) ? fs.readFileSync(tarLog, "utf-8") : "").toBe("");
      expect(fs.existsSync(installLog) ? fs.readFileSync(installLog, "utf-8") : "").toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([22, 28])(
    "stops before verification when curl exits with status %i (#11281)",
    (status) => {
      const result = runWithInstalledVersion("0.0.38", {}, { curlExitCode: status });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
      expect(result.stderr).toContain("curl stub:");
      expect(result.stdout).toContain("Downloading OpenShell release assets");
      expect(result.stdout).not.toContain("Verifying SHA-256 checksum");
    },
  );

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

  it("reinstalls the pinned release when openshell 0.0.117 is above MAX_VERSION", () => {
    const result = runWithInstalledVersion("0.0.117");
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

  it("rejects the OpenShell dev channel even with the former risk-acceptance flag", () => {
    const result = runWithInstalledVersion("0.0.116.dev84+g6b2180425", {
      NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "NemoClaw requires exact stable OpenShell 0.0.116; the dev channel is not supported.",
    );
    expect(result.stdout).not.toContain("Installing OpenShell from release 'dev'");
  });

  it.each([
    "NEMOCLAW_OPENSHELL_MIN_VERSION",
    "NEMOCLAW_OPENSHELL_MAX_VERSION",
    "NEMOCLAW_OPENSHELL_PIN_VERSION",
  ] as const)("rejects a non-0.0.116 %s override before installation", (variable) => {
    const result = runWithInstalledVersion(REQUIRED_OPENSHELL_VERSION, {
      [variable]: "0.0.115",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${variable} must equal immutable OpenShell ${REQUIRED_OPENSHELL_VERSION}.`,
    );
    expect(result.stdout).not.toContain("Installing OpenShell from release");
  });

  it("reconciles an installed development build to the exact stable release", () => {
    const result = runWithInstalledVersion("0.0.116-dev.8+g7bce1223d");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("OpenShell development builds are unsupported");
    expect(result.stdout).toContain(
      `Installing OpenShell from release 'v${REQUIRED_OPENSHELL_VERSION}'`,
    );
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

  it("rejects the removed artifact channel", () => {
    const result = runWithInstalledVersion("0.0.72", {
      NEMOCLAW_OPENSHELL_CHANNEL: "artifact",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEMOCLAW_OPENSHELL_CHANNEL must be one of: stable, auto");
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
