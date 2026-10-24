// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../../src/lib/core/shell-quote";
import {
  OPENSHELL_FEATURE_MARKERS,
  OPENSHELL_MCP_FEATURE_MARKER,
  OPENSHELL_REWRITE_FEATURE_MARKERS,
  PINNED_OPEN_SHELL_SHA256,
} from "../helpers/openshell-release-fixtures";

const SCRIPTS = path.join(import.meta.dirname, "../..", "scripts");
type OpenShellFeaturePlacement = "openshell" | "gateway" | "split-mcp-gateway" | "none";

export function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}
export function prepareInstallerBin(dir: string) {
  fs.mkdirSync(dir);
  fs.symlinkSync(process.execPath, path.join(dir, "node"));
  writeExecutable(
    path.join(dir, "mktemp"),
    `#!/usr/bin/env bash
if [ "$*" = "-d" ]; then exec /usr/bin/mktemp -d ${shellQuote(path.join(path.dirname(dir), "install.XXXXXX"))}; fi
exec /usr/bin/mktemp "$@"`,
  );
}
export function runCommandWithInstalledVersion(
  version: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options: {
    entrypoint?: "direct" | "feature-check";
    capability?: boolean;
    curlExitCode?: number;
    featurePlacement?: OpenShellFeaturePlacement;
    driverBins?: boolean | "gateway" | "gateway-vm";
    driverLocation?: "path" | "explicit" | "symlink";
    driverVersion?: string;
    sandboxVersion?: string;
    sandboxMarkers?: string;
    sandboxVersionExit?: number;
    sandboxBinaryDigest?: string;
    driverVersionExit?: number;
    driverReadable?: boolean;
    homebrewAvailable?: boolean;
    homebrewFormulaDownload?: boolean;
    homebrewFormulaDigest?: string;
    homebrewOperationLog?: string;
    legacyGateway?:
      | true
      | "empty"
      | "partial"
      | "invalid"
      | "unreachable"
      | "stderr"
      | "retired"
      | "metadata-link"
      | "metadata-directory"
      | "corrupt"
      | "fixed-system"
      | "system";
    legacyInventory?: unknown;
    retainedRegistry?: string;
    registryGatewayPort?: string;
    missingCli?: boolean;
    missingNode?: boolean;
    systemGatewayDirectory?: string;
    versionExit?: number;
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
    const downloads = path.join(tmp, "downloads");
    const fakeBin = path.join(tmp, "bin");
    const driverBin = options.driverLocation ? path.join(tmp, "driver-bin") : fakeBin;
    prepareInstallerBin(fakeBin);
    if (options.missingNode) {
      fs.unlinkSync(path.join(fakeBin, "node"));
      // Exclude system PATH entries that can contain Node.js on CI hosts.
      for (const name of ["bash", "awk", "cat", "chmod", "dirname", "grep", "mkdir", "rm", "sed"]) {
        const binary = ["/usr/bin", "/bin"]
          .map((root) => path.join(root, name))
          .find(fs.existsSync);
        if (!binary) throw new Error(`Missing installer fixture tool: ${name}`);
        fs.symlinkSync(binary, path.join(fakeBin, name));
      }
    }
    fs.mkdirSync(driverBin, { recursive: true });
    const configHome = path.join(tmp, "config");
    const retainedFiles = new Map<string, string>();
    if (options.retainedRegistry !== undefined) {
      const registry = path.join(
        tmp,
        ".nemoclaw",
        ...(options.registryGatewayPort ? ["gateways", options.registryGatewayPort] : []),
        "sandboxes.json",
      );
      fs.mkdirSync(path.dirname(registry), { recursive: true });
      fs.writeFileSync(registry, options.retainedRegistry);
      retainedFiles.set(registry, options.retainedRegistry);
    }
    if (options.legacyGateway) {
      const gatewayRoot =
        options.legacyGateway === "fixed-system"
          ? path.join(tmp, "fixed-system-openshell")
          : options.legacyGateway === "system"
            ? path.join(tmp, "system-openshell")
            : path.join(configHome, "openshell");
      const gatewayDir = path.join(gatewayRoot, "gateways", "nemoclaw");
      fs.mkdirSync(gatewayDir, { recursive: true });
      if (!["retired", "metadata-directory"].includes(String(options.legacyGateway))) {
        retainedFiles.set(
          path.join(
            gatewayDir,
            options.legacyGateway === "metadata-link" ? "metadata-target.json" : "metadata.json",
          ),
          options.legacyGateway === "corrupt"
            ? "invalid metadata"
            : JSON.stringify({ name: "nemoclaw", gateway_endpoint: "https://127.0.0.1:8080" }),
        );
      }
      retainedFiles.set(path.join(gatewayDir, "client.key"), "synthetic retained mTLS sentinel");
      for (const [file, contents] of retainedFiles) fs.writeFileSync(file, contents);
      if (options.legacyGateway === "metadata-link")
        fs.symlinkSync("metadata-target.json", path.join(gatewayDir, "metadata.json"));
      if (options.legacyGateway === "metadata-directory")
        fs.mkdirSync(path.join(gatewayDir, "metadata.json"));
    }

    writeExecutable(
      path.join(fakeBin, "uname"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "-m" ]; then echo "${options.arch ?? "x86_64"}"; else echo "${options.os ?? "Linux"}"; fi`,
    );

    // Fake openshell that reports the given version
    writeExecutable(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "openshell ${version}"; exit ${options.versionExit ?? 0}; fi
if [ "$*" = "gateway list -o json" ]; then
  printf '%s\\n' ${shellQuote(JSON.stringify(options.legacyGateway ? [{ name: "nemoclaw", endpoint: "https://127.0.0.1:8080", active: true }] : []))}
  exit 0
fi
if [ "$*" = "sandbox list -g nemoclaw -o json" ]; then
  printf '%s\\n' ${shellQuote(options.legacyInventory !== undefined ? JSON.stringify(options.legacyInventory) : options.legacyGateway === "empty" || options.legacyGateway === "stderr" ? "[]" : options.legacyGateway === "partial" ? '{"sandboxes":[],"next_page_token":"remaining"}' : options.legacyGateway === "invalid" ? "invalid JSON" : '[{"id":"11111111-1111-4111-8111-111111111111","name":"retained-box","phase":"Stopped","labels":{},"resource_version":1,"created_at":"2026-10-13T00:00:00Z","current_policy_version":1}]')}
  ${options.legacyGateway === "stderr" ? "echo 'inventory unavailable' >&2" : ":"}
  exit ${options.legacyGateway === "unreachable" ? 1 : 0}
fi
${openshellMarkers ? `# ${openshellMarkers}` : ""}
exit 99`,
    );
    if (options.missingCli) fs.unlinkSync(path.join(fakeBin, "openshell"));
    else
      retainedFiles.set(
        path.join(fakeBin, "openshell"),
        fs.readFileSync(path.join(fakeBin, "openshell"), "utf8"),
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
                    markers: options.sandboxMarkers ?? OPENSHELL_MCP_FEATURE_MARKER,
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
printf 'download\\n' >> ${shellQuote(downloads)}
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
    // Protected execution projects the installer without adjacent candidate helpers.
    const isolatedInstaller = path.join(tmp, "install-openshell.sh");
    // Map the fixed system path into the fixture; never read or mutate host registrations.
    fs.writeFileSync(
      isolatedInstaller,
      fs
        .readFileSync(path.join(SCRIPTS, "install-openshell.sh"), "utf8")
        .replaceAll("/etc/openshell", path.join(tmp, "fixed-system-openshell")),
    );
    if (options.entrypoint === "feature-check") {
      // Exercise the feature gate independently of the selected install version.
      const source = fs.readFileSync(isolatedInstaller, "utf8");
      const selectionStart = source.indexOf('\nACTIVE_OPENSHELL_BIN=""\n');
      if (selectionStart === -1) throw new Error("Missing installer selection boundary");
      fs.writeFileSync(
        isolatedInstaller,
        `${source.slice(0, selectionStart)}\nrequire_openshell_messaging_features "$(command -v openshell)"\n`,
      );
    }
    const result = spawnSync("bash", [isolatedInstaller], {
      env: {
        ...process.env,
        NEMOCLAW_OPENSHELL_CHANNEL: "stable",
        ...explicitDriverEnv,
        ...extraEnv,
        HOME: tmp,
        TMPDIR: tmp,
        XDG_CONFIG_HOME: configHome,
        OPENSHELL_SYSTEM_GATEWAY_DIR:
          options.systemGatewayDirectory ?? path.join(tmp, "system-openshell"),
        PATH: `${fakeBin}:${driverBin}${options.missingNode ? "" : ":/usr/bin:/bin"}`,
      },
      encoding: "utf8",
    });
    return {
      ...result,
      downloads: fs.existsSync(downloads) ? fs.readFileSync(downloads, "utf8") : "",
      retainedFilesUnchanged: [...retainedFiles].every(
        ([file, contents]) => fs.readFileSync(file, "utf8") === contents,
      ),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
