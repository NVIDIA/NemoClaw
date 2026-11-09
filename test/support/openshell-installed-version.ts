// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENSHELL_FEATURE_MARKERS,
  OPENSHELL_REWRITE_FEATURE_MARKERS,
  OPENSHELL_MCP_FEATURE_MARKER,
  PINNED_OPEN_SHELL_SHA256,
} from "../helpers/openshell-release-fixtures";

type OpenShellFeaturePlacement = "openshell" | "gateway" | "split-mcp-gateway" | "none";

export type InstalledOpenShellOptions = {
  capability?: boolean;
  curlExitCode?: number;
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
};

export function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}
/** Keep real installer downloads inside the fixture on BSD and GNU hosts. */
export function writeFixtureMktemp(fakeBin: string, fixtureRoot: string): void {
  const template = path.join(fixtureRoot, "download.XXXXXX").replaceAll("'", "'\\''");
  writeExecutable(
    path.join(fakeBin, "mktemp"),
    `#!/usr/bin/env bash
if [ "$#" -eq 1 ] && [ "$1" = "-d" ]; then
  exec /usr/bin/mktemp -d '${template}'
fi
exec /usr/bin/mktemp "$@"`,
  );
}
export function createInstalledOpenShellFixture(
  version: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options: InstalledOpenShellOptions = {},
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

    writeFixtureMktemp(fakeBin, tmp);

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
printf '%s\n' "$*" >&2; out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift || true
done
[ -n "$out" ] || exit 1
printf '%s\n' '# downloaded OpenShell formula' 'class Openshell < Formula' > "$out"
exit 0`
        : `#!/usr/bin/env bash
echo "curl stub: $*" >&2
exit ${options.curlExitCode ?? 1}`,
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
    return {
      tmp,
      env: {
        ...process.env,
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        ...explicitDriverEnv,
        ...extraEnv,
        PATH: `${fakeBin}:${driverBin}:/usr/bin:/bin`,
      },
    };
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}
