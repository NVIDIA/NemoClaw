// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
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
]);
const ASSETS = [...ASSET_DIGESTS.keys()];
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
  | "brev-mismatch"
  | "complete"
  | "duplicate-brev-pin"
  | "failure"
  | "incomplete-trusted-allowlist"
  | "installer-max-version-drift"
  | "installer-pin-selector-drift"
  | "mismatched-table-versions"
  | "missing-brev-pin"
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
  | "symlink-scripts-parent";
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
  "brev-mismatch": corruptFirstBrevPin,
  "duplicate-brev-pin": (source) => {
    const pinLine = `      printf '%s\\n' "${ASSET_DIGESTS.get(ASSETS[0])}"`;
    return source.replace(pinLine, `${pinLine}\n${pinLine}`);
  },
  "missing-brev-pin": (source) =>
    source.replace(ASSET_DIGESTS.get(ASSETS[1]) ?? "missing", "missing"),
  "mismatched-table-versions": (source) => source.replaceAll("v0.0.72:", "v0.0.73:"),
  "official-but-unexpected-brev-asset": (source) =>
    source
      .replace(ASSETS[1] ?? "missing", OFFICIAL_UNEXPECTED_BREV_ASSET)
      .replace(ASSET_DIGESTS.get(ASSETS[1] ?? "") ?? "missing", OFFICIAL_UNEXPECTED_BREV_DIGEST),
  "pr-checker-bypass": corruptFirstBrevPin,
  "pr-parser-bypass": corruptFirstBrevPin,
  "brev-stable-version-drift": (source) =>
    source.replace(
      'stable | auto) OPENSHELL_VERSION="v0.0.72" ;;',
      'stable | auto) OPENSHELL_VERSION="v0.0.82" ;;',
    ),
  "runtime-consumers-newer-than-tables": (source) =>
    source.replace(
      'stable | auto) OPENSHELL_VERSION="v0.0.72" ;;',
      'stable | auto) OPENSHELL_VERSION="v0.0.82" ;;',
    ),
};
const INSTALLER_MUTATIONS: Partial<Record<FixtureMode, (source: string) => string>> = {
  "installer-max-version-drift": (source) =>
    source.replace('MAX_VERSION="0.0.72"', 'MAX_VERSION="0.0.82"'),
  "installer-pin-selector-drift": (source) =>
    source.replace('PIN_VERSION="$MAX_VERSION"', 'PIN_VERSION="0.0.72"'),
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
    source.replace('MAX_VERSION="0.0.72"', 'MAX_VERSION="0.0.82"'),
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
    fs.writeFileSync(blueprint, source.replace('"0.0.72"', '"0.0.82"'));
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
      const digest = ASSET_DIGESTS.get(asset) ?? "missing";
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

function createFixture(
  openshellVersion = "0.0.72",
  formatting: PinFormatting = "canonical",
): string {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-hash-"));
  const scriptsDir = path.join(fixtureRoot, "scripts");
  const checksDir = path.join(scriptsDir, "checks");
  const binDir = path.join(fixtureRoot, "bin");
  tempDirs.push(fixtureRoot);
  fs.mkdirSync(checksDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "nemoclaw-blueprint"), { recursive: true });
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
    `MAX_VERSION="${openshellVersion}"\nPIN_VERSION="$MAX_VERSION"\n${renderPinFunction(
      "openshell_pinned_sha256",
      ASSETS,
      openshellVersion,
      formatting,
    )}`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "brev-launchable-ci-cpu.sh"),
    `case "$NEMOCLAW_REF" in\n  stable | auto) OPENSHELL_VERSION="v${openshellVersion}" ;;\nesac\n${renderPinFunction(
      "openshell_cli_pinned_sha256",
      ASSETS.slice(0, 2),
      openshellVersion,
      formatting,
    )}`,
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
          partial) printf '%s\\n' '${CHECKSUM_MANIFESTS.get("openshell-checksums-sha256.txt")?.split("\n")[0]}' >"$output" ;;
          *) printf '%s' '${CHECKSUM_MANIFESTS.get("openshell-checksums-sha256.txt")}' >"$output" ;;
        esac
        ;;
      openshell-gateway-checksums-sha256.txt)
        case "\${NEMOCLAW_TEST_CURL_MODE}" in
          partial-manifest-missing)
            printf '%s\n' 'curl: (22) The requested URL returned error: 404' >&2
            exit 22
            ;;
          *) printf '%s' '${CHECKSUM_MANIFESTS.get("openshell-gateway-checksums-sha256.txt")}' >"$output" ;;
        esac
        ;;
      openshell-sandbox-checksums-sha256.txt)
        printf '%s' '${CHECKSUM_MANIFESTS.get("openshell-sandbox-checksums-sha256.txt")}' >"$output"
        ;;
    esac
    ;;
  *) exit 22 ;;
esac
`,
  );
  fs.chmodSync(path.join(binDir, "curl"), 0o755);
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
  fs.writeFileSync(
    targetChecker,
    trustedChecker
      ? "#!/usr/bin/env bash\necho PR_CHECKER_EXECUTED\nexit 0\n"
      : fs.readFileSync(targetChecker, "utf8"),
  );
  const checker = trustedChecker ? trustedCheckerPath : targetChecker;
  if (mode === "allowlisted-alternate-version") {
    const alternateEntries = [...CHECKSUM_MANIFESTS.entries()]
      .map(
        ([manifest, contents]) =>
          `  "9.9.9|${manifest}|${createHash("sha256").update(contents).digest("hex")}"`,
      )
      .join("\n");
    const checkerSource = fs.readFileSync(checker, "utf8");
    fs.writeFileSync(
      checker,
      checkerSource.replace(
        "readonly -a OPENSHELL_RELEASE_MANIFEST_ALLOWLIST=(\n",
        `readonly -a OPENSHELL_RELEASE_MANIFEST_ALLOWLIST=(\n${alternateEntries}\n`,
      ),
    );
  }
  if (mode === "incomplete-trusted-allowlist") {
    const checkerSource = fs.readFileSync(checker, "utf8");
    fs.writeFileSync(
      checker,
      checkerSource.replace(
        /^\s*"0\.0\.72\|openshell-sandbox-checksums-sha256\.txt\|[a-f0-9]{64}"\s*$/m,
        "",
      ),
    );
  }
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

  it("derives the release version from matching static installer pin tables", () => {
    const result = runFixture("complete", undefined, true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("selects a second complete trusted release from the allowlist", () => {
    const result = runFixture("allowlisted-alternate-version", "9.9.9", true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Checking OpenShell v9.9.9 release assets");
    expect(result.stdout).toContain("All installer hashes are current");
  });

  it("fails closed when the derived release is not allowlisted", () => {
    const result = runFixture("complete", "9.9.9", true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "OpenShell v9.9.9 is not in the trusted release-manifest allowlist",
    );
    expect(result.stdout).not.toContain("Checking OpenShell v9.9.9 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
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

  it("rejects newer runtime consumers when both trusted pin tables stay on an older release", () => {
    const result = runFixture("runtime-consumers-newer-than-tables", undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(
      "installer pin-table release 0.0.72 must match blueprint max_openshell_version 0.0.82",
    );
    expect(result.stdout).not.toContain("Checking OpenShell v0.0.72 release assets");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
    [
      "installer-max-version-drift",
      "installer pin-table release 0.0.72 must match installer MAX_VERSION 0.0.82",
    ],
    [
      "brev-stable-version-drift",
      "installer pin-table release 0.0.72 must match Brev stable OpenShell default 0.0.82",
    ],
    ["installer-pin-selector-drift", 'installer PIN_VERSION must be exactly "$MAX_VERSION"'],
  ] as const)("rejects %s", (mode, diagnostic) => {
    const result = runFixture(mode, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unable to extract the OpenShell installer pin tables");
    expect(result.stdout).toContain(diagnostic);
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it.each([
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
    expect(result.stdout).toContain("14 OpenShell release-asset check(s) failed");
    expect(result.stdout).not.toContain("All installer hashes are current");
  });

  it("fails closed when an OpenShell checksum manifest is incomplete", () => {
    const result = runFixture("partial");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("digest does not match the pinned v0.0.72 release asset");
    expect(result.stdout).toContain("expected all 10 pinned asset references");
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
