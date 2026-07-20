// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const STATION_REVISION = "a".repeat(40);
const STATION_GENERATION = "0123456789abcdef0123456789abcdef";

function runSourced(script: string, body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-dgx-os-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$SCRIPT_UNDER_TEST" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        SCRIPT_UNDER_TEST: script,
        ...extraEnv,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { home, result, output: `${result.stdout}${result.stderr}` };
}

function writeDgxReleaseFixture(
  version = "7.5.0",
  extraLine = "",
  otaPrettyName: string | null = "DGX OS",
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-release-"));
  const target = path.join(dir, "dgx-release");
  fs.writeFileSync(
    target,
    [
      'DGX_NAME="DGX Server"',
      'DGX_PRETTY_NAME="NVIDIA DGX Server"',
      ...(otaPrettyName === null ? [] : [`DGX_OTA_PRETTY_NAME="${otaPrettyName}"`]),
      `DGX_OTA_VERSION="${version}"`,
      'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
      'DGX_PLATFORM="DGX Server for GALAXY-GB300"',
      'DGX_SERIAL_NUMBER="Unknown"',
      extraLine,
    ].join("\n"),
  );
  return target;
}

function writeDgxReleaseHistory(historyLines: string[]) {
  const release = writeDgxReleaseFixture();
  fs.writeFileSync(
    release,
    [
      'DGX_NAME="DGX Server"',
      'DGX_PRETTY_NAME="NVIDIA DGX Server"',
      'DGX_SWBUILD_DATE="2026-01-01-00-00-00"',
      'DGX_SWBUILD_VERSION="7.2.0"',
      'DGX_COMMIT_ID="abcdef0"',
      'DGX_OTA_PRETTY_NAME="DGX OS"',
      'DGX_PLATFORM="DGX Server for GALAXY-GB300"',
      'DGX_SERIAL_NUMBER="Unknown"',
      "",
      ...historyLines,
      "",
    ].join("\n"),
  );
  return release;
}

function writeNoOtaFactoryRelease(
  profile: "colossus-baseos" | "ai-developer-tools",
  overrides: Partial<{ pretty: string; version: string; buildDate: string; platform: string }> = {},
) {
  const defaults =
    profile === "colossus-baseos"
      ? {
          pretty: "NVIDIA DGX Server",
          version: "7.5.0-GB300ws-GB200ws",
          buildDate: "2026-04-02-08-20-16",
        }
      : {
          pretty: "NVIDIA DGX GB300WS",
          version: "7.5.0",
          buildDate: "2026-06-16-11-48-10",
        };
  const fields = {
    ...defaults,
    platform: "DGX Server for GALAXY-GB300",
    ...overrides,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-factory-release-"));
  const target = path.join(dir, "dgx-release");
  fs.writeFileSync(
    target,
    [
      'DGX_NAME="DGX Server"',
      `DGX_PRETTY_NAME="${fields.pretty}"`,
      `DGX_SWBUILD_DATE="${fields.buildDate}"`,
      `DGX_SWBUILD_VERSION="${fields.version}"`,
      `DGX_PLATFORM="${fields.platform}"`,
      'DGX_SERIAL_NUMBER="host-specific-value"',
      "",
    ].join("\n"),
  );
  return target;
}

function writeOtaUpgradedRelease(
  overrides: Partial<{ pretty: string; otaVersion: string; swbuildVersion: string }> = {},
) {
  const fields = {
    pretty: "NVIDIA DGX GB300WS",
    otaVersion: "7.5.0",
    swbuildVersion: "7.4.1-GB300ws",
    ...overrides,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-ota-upgraded-"));
  const target = path.join(dir, "dgx-release");
  fs.writeFileSync(
    target,
    [
      'DGX_NAME="DGX GB300WS"',
      `DGX_PRETTY_NAME="${fields.pretty}"`,
      'DGX_SWBUILD_DATE="2026-02-20-05-22-42"',
      `DGX_SWBUILD_VERSION="${fields.swbuildVersion}"`,
      'DGX_COMMIT_ID="51c59a9"',
      'DGX_PLATFORM="DGX Server for GALAXY-GB300"',
      'DGX_SERIAL_NUMBER="Unknown"',
      "",
      `DGX_OTA_VERSION="${fields.otaVersion}"`,
      'DGX_OTA_DATE="Sun Apr 12 16:25:30 PDT 2026"',
      "",
    ].join("\n"),
  );
  return target;
}

describe("DGX Station stock DGX OS classification", () => {
  it.each([
    "7.2.0",
    "7.4.0",
    "7.5.0",
  ])("accepts the reviewed stock DGX OS %s marker as data", (version) => {
    const release = writeDgxReleaseFixture(version);
    const { result, output } = runSourced(
      STATION_PREPARE,
      `dgx_station_release_contents_are_supported "$DGX_RELEASE"`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
  });

  it.each([
    ["supported-colossus-baseos", writeNoOtaFactoryRelease("colossus-baseos")],
    ["supported-ai-developer-tools", writeNoOtaFactoryRelease("ai-developer-tools")],
  ])("accepts the exact no-OTA factory profile as %s", (expected, release) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
stat() { printf '0|0|644|256\n'; }
dgx_station_release_state "$DGX_RELEASE"
`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.each([
    [
      "BaseOS build version drift",
      writeNoOtaFactoryRelease("colossus-baseos", { version: "7.5.0" }),
    ],
    [
      "BaseOS build date drift",
      writeNoOtaFactoryRelease("colossus-baseos", { buildDate: "2026-04-03-00-00-00" }),
    ],
    [
      "AI Developer Tools product drift",
      writeNoOtaFactoryRelease("ai-developer-tools", { pretty: "NVIDIA DGX Server" }),
    ],
    [
      "AI Developer Tools build date drift",
      writeNoOtaFactoryRelease("ai-developer-tools", { buildDate: "2026-06-17-00-00-00" }),
    ],
    [
      "factory platform drift",
      writeNoOtaFactoryRelease("ai-developer-tools", {
        platform: "DGX Server for GALAXY-GB200",
      }),
    ],
  ])("rejects no-OTA factory identity with %s", (_scenario, release) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
stat() { printf '0|0|644|256\n'; }
dgx_station_release_state "$DGX_RELEASE"
`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout).toBe("unsupported-dgx-os");
  });

  it.each([
    ["unreviewed version", writeDgxReleaseFixture("7.6.0")],
    [
      "unproven Station platform identity",
      writeDgxReleaseFixture("7.5.0", 'DGX_PLATFORM="Not Specified"'),
    ],
    ["missing DGX_OTA_PRETTY_NAME", writeDgxReleaseFixture("7.5.0", "", null)],
    ["BaseOS identity", writeDgxReleaseFixture("7.5.0", "", "NVIDIA BaseOS")],
    ["unknown field", writeDgxReleaseFixture("7.5.0", 'PAYLOAD="$(touch /tmp/nope)"')],
    [
      "duplicate non-history field",
      writeDgxReleaseFixture("7.5.0", 'DGX_PLATFORM="DGX Server for GALAXY-GB300"'),
    ],
  ])("rejects a DGX OS marker with %s", (_scenario, release) => {
    const { result } = runSourced(
      STATION_PREPARE,
      `dgx_station_release_contents_are_supported "$DGX_RELEASE"`,
      { DGX_RELEASE: release },
    );

    expect(result.status).not.toBe(0);
  });

  it("accepts the documented DGX release history schema and uses its latest OTA", () => {
    const release = writeDgxReleaseHistory([
      'DGX_OTA_VERSION="7.4.0"',
      'DGX_OTA_DATE="Thu Apr 16 04:55:25 PM PDT 2026"',
      'DGX_OTA_VERSION="7.5.0"',
      'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
    ]);
    const { result, output } = runSourced(
      STATION_PREPARE,
      `dgx_station_release_contents_are_supported "$DGX_RELEASE"`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
  });

  it.each([
    ["orphan date", writeDgxReleaseHistory(['DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"'])],
    [
      "consecutive versions",
      writeDgxReleaseHistory([
        'DGX_OTA_VERSION="7.4.0"',
        'DGX_OTA_VERSION="7.5.0"',
        'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
      ]),
    ],
    [
      "duplicate version",
      writeDgxReleaseHistory([
        'DGX_OTA_VERSION="7.4.0"',
        'DGX_OTA_DATE="Thu Apr 16 04:55:25 PM PDT 2026"',
        'DGX_OTA_VERSION="7.4.0"',
        'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
      ]),
    ],
    [
      "dangling final version",
      writeDgxReleaseHistory([
        'DGX_OTA_VERSION="7.4.0"',
        'DGX_OTA_DATE="Thu Apr 16 04:55:25 PM PDT 2026"',
        'DGX_OTA_VERSION="7.5.0"',
      ]),
    ],
    [
      "blank line between version and date",
      writeDgxReleaseHistory([
        'DGX_OTA_VERSION="7.5.0"',
        "",
        'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
      ]),
    ],
  ])("rejects malformed OTA history with %s (#7103)", (_scenario, release) => {
    const { result } = runSourced(
      STATION_PREPARE,
      `dgx_station_release_schema_is_valid "$DGX_RELEASE"`,
      { DGX_RELEASE: release },
    );

    expect(result.status).not.toBe(0);
  });

  it.each([
    ["non-root owner", "1000|0|644|256"],
    ["group-writable mode", "0|0|664|256"],
    ["oversized marker", "0|0|644|4097"],
  ])("rejects a %s DGX OS marker", (_scenario, metadata) => {
    const release = writeDgxReleaseFixture();
    const { result } = runSourced(
      STATION_PREPARE,
      `
stat() { printf '%s\n' "$FILE_METADATA"; }
dgx_station_release_file_is_safe "$DGX_RELEASE"
`,
      { DGX_RELEASE: release, FILE_METADATA: metadata },
    );

    expect(result.status).not.toBe(0);
  });

  it("accepts only a bounded root-owned non-writable regular marker", () => {
    const release = writeDgxReleaseFixture();
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
stat() { printf '0|0|644|256\n'; }
dgx_station_release_file_is_safe "$DGX_RELEASE"
`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
  });

  it("rejects a symlinked DGX OS marker even when its target is valid", () => {
    const release = writeDgxReleaseFixture();
    const link = path.join(path.dirname(release), "dgx-release-link");
    fs.symlinkSync(release, link);
    const { result } = runSourced(
      STATION_PREPARE,
      `dgx_station_release_file_is_safe "$DGX_RELEASE"`,
      { DGX_RELEASE: link },
    );

    expect(result.status).not.toBe(0);
  });

  it("treats allowed marker values as data without executing shell payloads", () => {
    const release = writeDgxReleaseFixture();
    const sentinel = path.join(path.dirname(release), "payload-executed");
    const contents = fs
      .readFileSync(release, "utf-8")
      .replace('DGX_SERIAL_NUMBER="Unknown"', `DGX_SERIAL_NUMBER="$(touch ${sentinel})"`);
    fs.writeFileSync(release, contents);
    const { result, output } = runSourced(
      STATION_PREPARE,
      `dgx_station_release_contents_are_supported "$DGX_RELEASE"`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it.each([
    ["supported-dgx-os", writeDgxReleaseFixture("7.5.0")],
    ["unsupported-dgx-os", writeDgxReleaseFixture("7.6.0")],
  ])("classifies a present marker as %s", (expected, release) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
stat() { printf '0|0|644|256\n'; }
dgx_station_release_state "$DGX_RELEASE"
`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it("classifies an OTA-upgraded GB300 workstation without the fresh-install marker as supported-dgx-os (#7103)", () => {
    const release = writeOtaUpgradedRelease();
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
stat() { printf '0|0|644|256\n'; }
dgx_station_release_state "$DGX_RELEASE"
`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout).toBe("supported-dgx-os");
  });

  it.each([
    [
      "a non-workstation DGX Server identity",
      writeOtaUpgradedRelease({ pretty: "NVIDIA DGX Server" }),
    ],
    ["an unreviewed latest OTA version", writeOtaUpgradedRelease({ otaVersion: "7.6.0" })],
  ])("keeps a marker-less OTA host fail-closed with %s (#7103)", (_scenario, release) => {
    const { result } = runSourced(
      STATION_PREPARE,
      `dgx_station_release_contents_are_supported "$DGX_RELEASE"`,
      { DGX_RELEASE: release },
    );

    expect(result.status).not.toBe(0);
  });

  it("keeps the classifier self-contained when the helper is transported alone", () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-helper-only-"));
    const copiedHelper = path.join(isolated, "prepare-dgx-station-host.sh");
    fs.copyFileSync(STATION_PREPARE, copiedHelper);
    const release = writeDgxReleaseFixture();
    const { result, output } = runSourced(
      copiedHelper,
      `
stat() { printf '0|0|644|256\n'; }
dgx_station_release_state "$DGX_RELEASE"
`,
      { DGX_RELEASE: release },
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout).toBe("supported-dgx-os");
  });

  it("preserves the standalone classifier CLI contract without sibling files", () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-helper-cli-"));
    const copiedHelper = path.join(isolated, "prepare-dgx-station-host.sh");
    fs.copyFileSync(STATION_PREPARE, copiedHelper);
    const env = { HOME: isolated, PATH: TEST_SYSTEM_PATH };
    const result = spawnSync("bash", [copiedHelper, "--classify-dgx-release"], {
      cwd: isolated,
      encoding: "utf-8",
      env,
    });
    const original = spawnSync("bash", [STATION_PREPARE, "--classify-dgx-release"], {
      cwd: isolated,
      encoding: "utf-8",
      env,
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(original.status, `${original.stdout}${original.stderr}`).toBe(0);
    expect(result.stdout).toBe(original.stdout);
    expect(result.stdout).toMatch(
      /^(generic-ubuntu|supported-dgx-os|supported-colossus-baseos|supported-ai-developer-tools|unsupported-dgx-os)$/,
    );
    expect(result.stderr).toBe("");
  });

  it("uses explicit intent to bypass only unsupported release metadata", () => {
    const forced = runSourced(
      STATION_PREPARE,
      `
printf 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"\n' >"$HOME/os-release"
printf 'NVIDIA DGX Station GB300\n' >"$HOME/product-name"
uname() { printf 'aarch64\n'; }
station_os_release_path() { printf '%s' "$HOME/os-release"; }
station_product_name_path() { printf '%s' "$HOME/product-name"; }
dgx_station_release_path() { printf '%s' "$HOME/dgx-release"; }
dgx_station_release_state() { printf 'unsupported-dgx-os'; }
station_has_exact_gb300_pci_gpu() { return 0; }
FORCE_STATION_INSTALL=1
check_platform
printf 'PROFILE=%s\n' "$STATION_HOST_PROFILE"
`,
    );

    expect(forced.result.status, forced.output).toBe(0);
    expect(forced.output).toContain("release metadata allowlist bypassed");
    expect(forced.output).toContain("PROFILE=forced-factory-runtime");

    const unforced = runSourced(
      STATION_PREPARE,
      `
printf 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"\n' >"$HOME/os-release"
printf 'NVIDIA DGX Station GB300\n' >"$HOME/product-name"
uname() { printf 'aarch64\n'; }
station_os_release_path() { printf '%s' "$HOME/os-release"; }
station_product_name_path() { printf '%s' "$HOME/product-name"; }
dgx_station_release_path() { printf '%s' "$HOME/dgx-release"; }
dgx_station_release_state() { printf 'unsupported-dgx-os'; }
check_platform
`,
    );

    expect(unforced.result.status, unforced.output).not.toBe(0);
    expect(unforced.output).toContain("outside the validated boundary");
  });

  it.each([
    "generic-ubuntu",
    "supported-dgx-os",
    "supported-colossus-baseos",
    "supported-ai-developer-tools",
  ])("rejects explicit metadata intent for recognized %s before preparation (#7138)", (releaseState) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
printf 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"\n' >"$HOME/os-release"
printf 'NVIDIA DGX Station GB300\n' >"$HOME/product-name"
uname() { printf 'aarch64\n'; }
station_os_release_path() { printf '%s' "$HOME/os-release"; }
station_product_name_path() { printf '%s' "$HOME/product-name"; }
dgx_station_release_path() { printf '%s' "$HOME/dgx-release"; }
dgx_station_release_state() { printf '%s' "$RELEASE_STATE"; }
FORCE_STATION_INSTALL=1
check_platform
printf 'PREPARATION_REACHED\n'
`,
      { RELEASE_STATE: releaseState },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain(
      `This host is already supported (${releaseState}); omit --force-station-install`,
    );
    expect(output).not.toContain("PREPARATION_REACHED");
  });

  it("keeps generic Ubuntu preparation unchanged without explicit metadata intent (#7138)", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
printf 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"\n' >"$HOME/os-release"
printf 'NVIDIA DGX Station GB300\n' >"$HOME/product-name"
uname() { printf 'aarch64\n'; }
station_os_release_path() { printf '%s' "$HOME/os-release"; }
station_product_name_path() { printf '%s' "$HOME/product-name"; }
dgx_station_release_path() { printf '%s' "$HOME/dgx-release"; }
dgx_station_release_state() { printf 'generic-ubuntu'; }
station_has_exact_gb300_pci_gpu() { return 0; }
check_platform
printf 'PROFILE=%s\n' "$STATION_HOST_PROFILE"
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("PROFILE=generic-ubuntu");
  });

  it("parses the metadata override only alongside a preparation mode", () => {
    const accepted = runSourced(
      STATION_PREPARE,
      `
parse_args --apply --force-station-install
printf 'MODE=%s FORCE=%s\n' "$MODE" "$FORCE_STATION_INSTALL"
`,
    );
    const classifier = runSourced(
      STATION_PREPARE,
      "parse_args --classify-dgx-release --force-station-install",
    );

    expect(accepted.result.status, accepted.output).toBe(0);
    expect(accepted.output).toContain("MODE=--apply FORCE=1");
    expect(classifier.result.status, classifier.output).not.toBe(0);
  });

  it("does not let explicit metadata intent bypass architecture validation", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
uname() { printf 'x86_64\n'; }
FORCE_STATION_INSTALL=1
check_platform
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Expected ARM64, found x86_64");
  });
});

describe("DGX Station forced metadata installer handoff", () => {
  it("forwards explicit intent only to Station host preparation", () => {
    const { home, result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
SCRIPT_DIR="$HOME"
cat >"$SCRIPT_DIR/prepare-dgx-station-host.sh" <<'HELPER'
printf '%s\n' "$*" >"$HOME/helper-args"
HELPER
FORCE_STATION_INSTALL=1
run_station_host_preparation
`,
    );

    expect(result.status, output).toBe(0);
    expect(fs.readFileSync(path.join(home, "helper-args"), "utf8")).toBe(
      "--apply --force-station-install\n",
    );
  });

  it("preserves explicit intent in the relogin command", () => {
    const { result, output } = runSourced(
      INSTALLER_PAYLOAD,
      `
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='deepseek-v4-flash'
FORCE_STATION_INSTALL=1
station_installer_revision() { printf '${STATION_REVISION}'; }
station_express_resume_generation() { printf '${STATION_GENERATION}'; }
run_station_host_preparation() { return 11; }
ensure_station_express_host
`,
    );

    expect(result.status, output).toBe(11);
    expect(output).toContain("bash -s -- --force-station-install");
  });
});

describe("DGX Station stock DGX OS runtime validation", () => {
  it("preserves packages and the runtime for a forced metadata profile", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_command() {
  [[ "$1" == "sudo" ]] || { printf 'UNEXPECTED_REQUIREMENT %s\n' "$1"; return 1; }
}
acquire_sudo() { :; }
common_preflight() { STATION_HOST_PROFILE=forced-factory-runtime; }
reboot_required() { return 1; }
verify_dgx_os_runtime_sudo() { printf 'FACTORY_RUNTIME_VALIDATED\n'; }
ensure_docker_group() { printf 'DOCKER_GROUP_PRESENT\n'; }
install_packages() { printf 'PACKAGE_MUTATION\n'; return 1; }
finish_runtime() { printf 'RUNTIME_MUTATION\n'; return 1; }
run_apply
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("FACTORY_RUNTIME_VALIDATED");
    expect(output).toContain("APPLY_RESULT=COMPLETE");
    expect(output).not.toContain("PACKAGE_MUTATION");
    expect(output).not.toContain("RUNTIME_MUTATION");
    expect(output).not.toContain("UNEXPECTED_REQUIREMENT");
  });

  it("requires the exact qualified BaseOS package inventory", () => {
    const exact = runSourced(
      STATION_PREPARE,
      `
installed_version() {
  local spec
  for spec in "\${BASEOS_PACKAGE_SPECS[@]}"; do
    if [[ "\${spec%%=*}" == "$1" ]]; then printf '%s' "\${spec#*=}"; return; fi
  done
}
all_baseos_packages_exact
`,
    );
    expect(exact.result.status, exact.output).toBe(0);

    const drifted = runSourced(
      STATION_PREPARE,
      `
installed_version() {
  if [[ "$1" == "docker-ce" ]]; then printf '5:30.0.0-1~ubuntu.24.04~noble'; return; fi
  local spec
  for spec in "\${BASEOS_PACKAGE_SPECS[@]}"; do
    if [[ "\${spec%%=*}" == "$1" ]]; then printf '%s' "\${spec#*=}"; return; fi
  done
}
all_baseos_packages_exact
`,
    );
    expect(drifted.result.status, drifted.output).not.toBe(0);
  });

  it("allows BaseOS failures only with exact packages and the expected cause fingerprint", () => {
    const qualified = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=colossus-baseos
all_baseos_packages_exact() { return 0; }
baseos_fluent_bit_failure_is_qualified() { return 0; }
is_qualified_factory_failed_unit fluent-bit.service
`,
    );
    expect(qualified.result.status, qualified.output).toBe(0);

    const drifted = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=colossus-baseos
all_baseos_packages_exact() { return 1; }
baseos_fluent_bit_failure_is_qualified() { return 0; }
is_qualified_factory_failed_unit fluent-bit.service
`,
    );
    expect(drifted.result.status, drifted.output).not.toBe(0);

    const changedCause = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=colossus-baseos
all_baseos_packages_exact() { return 0; }
baseos_fluent_bit_failure_is_qualified() { return 1; }
is_qualified_factory_failed_unit fluent-bit.service
`,
    );
    expect(changedCause.result.status, changedCause.output).not.toBe(0);
  });

  it("rejects a BaseOS failed unit when any systemd or unit-file fingerprint drifts", () => {
    const exact = runSourced(
      STATION_PREPARE,
      `
systemd_property_matches() { return 0; }
file_sha256_matches() { return 0; }
baseos_failed_unit_matches cloud-init.service /usr/lib/systemd/system/cloud-init.service HASH enabled 1
`,
    );
    expect(exact.result.status, exact.output).toBe(0);

    const drifted = runSourced(
      STATION_PREPARE,
      `
systemd_property_matches() { [[ "$2" != Result ]]; }
file_sha256_matches() { return 0; }
baseos_failed_unit_matches cloud-init.service /usr/lib/systemd/system/cloud-init.service HASH enabled 1
`,
    );
    expect(drifted.result.status, drifted.output).not.toBe(0);
  });

  it("qualifies the BaseOS Fluent Bit template independently of host identity", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fluent-bit-"));
    const config = path.join(configDir, "fluent-bit.conf");
    fs.writeFileSync(
      config,
      [
        "[FILTER]",
        "    Name modify",
        "    Match *",
        "    Add Hostname station-a",
        "    Add MAC A4:A6:8D:00:00:01",
        "    Add IP 10.88.4.21",
        "",
      ].join("\n"),
    );
    const normalized = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        String.raw`sed -E -e 's/^([[:space:]]*Add Hostname) [A-Za-z0-9][A-Za-z0-9._-]*$/\1 <HOSTNAME>/' -e 's/^([[:space:]]*Add MAC) ([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/\1 <MAC>/' -e 's/^([[:space:]]*Add IP) ([0-9]{1,3}\.){3}[0-9]{1,3}$/\1 <IP>/' "$CONFIG" | sha256sum | awk '{print $1}'`,
      ],
      { encoding: "utf-8", env: { ...process.env, CONFIG: config } },
    ).stdout.trim();

    const exact = runSourced(
      STATION_PREPARE,
      `
root_owned_file_is_not_writable_by_group_or_other() { return 0; }
baseos_fluent_bit_config_matches "$FLUENT_BIT_CONFIG" "$EXPECTED_SHA"
`,
      {
        EXPECTED_SHA: normalized,
        FLUENT_BIT_CONFIG: config,
        PATH: process.env.PATH ?? TEST_SYSTEM_PATH,
      },
    );
    expect(exact.result.status, exact.output).toBe(0);

    fs.writeFileSync(config, fs.readFileSync(config, "utf-8").replace("station-a", "station-b"));
    const differentHost = runSourced(
      STATION_PREPARE,
      `
root_owned_file_is_not_writable_by_group_or_other() { return 0; }
baseos_fluent_bit_config_matches "$FLUENT_BIT_CONFIG" "$EXPECTED_SHA"
`,
      {
        EXPECTED_SHA: normalized,
        FLUENT_BIT_CONFIG: config,
        PATH: process.env.PATH ?? TEST_SYSTEM_PATH,
      },
    );
    expect(differentHost.result.status, differentHost.output).toBe(0);

    fs.writeFileSync(config, fs.readFileSync(config, "utf-8").replace("Match *", "Match changed"));
    const changedTemplate = runSourced(
      STATION_PREPARE,
      `
root_owned_file_is_not_writable_by_group_or_other() { return 0; }
baseos_fluent_bit_config_matches "$FLUENT_BIT_CONFIG" "$EXPECTED_SHA"
`,
      {
        EXPECTED_SHA: normalized,
        FLUENT_BIT_CONFIG: config,
        PATH: process.env.PATH ?? TEST_SYSTEM_PATH,
      },
    );
    expect(changedTemplate.result.status, changedTemplate.output).not.toBe(0);
  });

  it("keeps stock DGX OS out of the generic package mutation path", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_command() {
  [[ "$1" == "sudo" ]] || { printf 'UNEXPECTED_REQUIREMENT %s\n' "$1"; return 1; }
}
acquire_sudo() { :; }
common_preflight() { STATION_HOST_PROFILE=stock-dgx-os; }
verify_dgx_os_runtime_sudo() { printf 'DGX_OS_VALIDATED\n'; }
ensure_docker_group() { printf 'DOCKER_GROUP_PRESENT\n'; }
install_packages() { printf 'GENERIC_PACKAGE_MUTATION\n'; return 1; }
finish_runtime() { printf 'GENERIC_RUNTIME_MUTATION\n'; return 1; }
run_apply
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("DGX_OS_VALIDATED");
    expect(output).toContain("APPLY_RESULT=COMPLETE");
    expect(output).not.toContain("GENERIC_PACKAGE_MUTATION");
    expect(output).not.toContain("GENERIC_RUNTIME_MUTATION");
    expect(output).not.toContain("UNEXPECTED_REQUIREMENT");
  });

  it("reconciles only the qualified BaseOS container runtime", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_command() {
  [[ "$1" == "sudo" ]] || { printf 'UNEXPECTED_REQUIREMENT %s\n' "$1"; return 1; }
}
acquire_sudo() { :; }
common_preflight() { STATION_HOST_PROFILE=colossus-baseos; }
finish_runtime() { printf 'BASEOS_RUNTIME_RECONCILED\n'; }
verify_dgx_os_runtime_sudo() { printf 'BASEOS_RUNTIME_VALIDATED\n'; }
install_packages() { printf 'PACKAGE_MUTATION\n'; return 1; }
run_apply
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("BASEOS_RUNTIME_RECONCILED");
    expect(output).toContain("BASEOS_RUNTIME_VALIDATED");
    expect(output).toContain("APPLY_RESULT=COMPLETE");
    expect(output).not.toContain("PACKAGE_MUTATION");
    expect(output).not.toContain("UNEXPECTED_REQUIREMENT");
  });

  it("keeps healthy AI Developer Tools CDI validation-only", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_command() {
  [[ "$1" == "sudo" ]] || { printf 'UNEXPECTED_REQUIREMENT %s\n' "$1"; return 1; }
}
acquire_sudo() { :; }
common_preflight() { STATION_HOST_PROFILE=ai-developer-tools; }
check_dgx_os_runtime_commands() { printf 'FACTORY_GATES_OK\n'; }
systemctl() {
  case "$*" in
    'is-active --quiet containerd.service'|'is-active --quiet docker.service') return 0 ;;
    *) printf 'UNEXPECTED_SYSTEMCTL %s\n' "$*"; return 1 ;;
  esac
}
station_sudo_local_default_docker() {
  case "$*" in
    'info'|'buildx version'|'ps -aq') return 0 ;;
    *) printf 'UNEXPECTED_DOCKER %s\n' "$*"; return 1 ;;
  esac
}
sudo() {
  case "$*" in
    'nvidia-ctk cdi list') printf 'nvidia.com/gpu=all\n' ;;
    *) printf 'UNEXPECTED_SUDO %s\n' "$*"; return 1 ;;
  esac
}
refresh_cdi() { printf 'UNEXPECTED_CDI_REFRESH\n'; return 1; }
ensure_dgx_os_acceptance_image() { printf 'IMAGE_CACHE_READY\n'; }
run_dgx_os_cdi_test_sudo() { printf 'DIGEST_PINNED_CDI_PROBE_OK\n'; }
run_dgx_os_gpus_test_sudo() { printf 'DIGEST_PINNED_GPUS_PROBE_OK\n'; }
ensure_docker_group() { printf 'DOCKER_GROUP_PRESENT\n'; }
install_packages() { printf 'UNEXPECTED_PACKAGE_MUTATION\n'; return 1; }
finish_runtime() { printf 'UNEXPECTED_RUNTIME_MUTATION\n'; return 1; }
run_apply
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("FACTORY_GATES_OK");
    expect(output).toContain("cdi=nvidia.com/gpu=all source=factory_runtime");
    expect(output).toContain("DIGEST_PINNED_CDI_PROBE_OK");
    expect(output).toContain("DIGEST_PINNED_GPUS_PROBE_OK");
    expect(output.indexOf("FACTORY_GATES_OK")).toBeLessThan(
      output.indexOf("cdi=nvidia.com/gpu=all source=factory_runtime"),
    );
    expect(output).toContain("APPLY_RESULT=COMPLETE");
    expect(output).not.toContain("UNEXPECTED_");
  });

  it("repairs missing AI Developer Tools CDI through the packaged lifecycle before validation", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
cdi_ready=0
require_command() {
  [[ "$1" == "sudo" ]] || { printf 'UNEXPECTED_REQUIREMENT %s\n' "$1"; return 1; }
}
acquire_sudo() { :; }
common_preflight() { STATION_HOST_PROFILE=ai-developer-tools; }
check_dgx_os_runtime_commands() { printf 'FACTORY_GATES_OK\n'; }
systemctl() {
  case "$*" in
    'is-active --quiet containerd.service'|'is-active --quiet docker.service') return 0 ;;
    *) printf 'UNEXPECTED_SYSTEMCTL %s\n' "$*"; return 1 ;;
  esac
}
station_sudo_local_default_docker() {
  case "$*" in
    'info'|'buildx version'|'ps -aq') return 0 ;;
    *) printf 'UNEXPECTED_DOCKER %s\n' "$*"; return 1 ;;
  esac
}
require_docker_mutation_quiescence() { printf 'WORKLOAD_GATE_OK %s\n' "$1"; }
sudo() {
  case "$*" in
    'nvidia-ctk cdi list')
      ((cdi_ready == 1)) && printf 'nvidia.com/gpu=all\n'
      ;;
    'systemctl enable nvidia-cdi-refresh.path nvidia-cdi-refresh.service'|'systemctl start nvidia-cdi-refresh.path')
      printf 'PACKAGED_LIFECYCLE %s\n' "$*"
      ;;
    'systemctl restart nvidia-cdi-refresh.service')
      printf 'PACKAGED_LIFECYCLE %s\n' "$*"
      cdi_ready=1
      ;;
    *) printf 'UNEXPECTED_SUDO %s\n' "$*"; return 1 ;;
  esac
}
nvidia-ctk() {
  [[ "$*" == "cdi list" && "$cdi_ready" == "1" ]] && printf 'nvidia.com/gpu=all\n'
}
ensure_dgx_os_acceptance_image() { printf 'IMAGE_CACHE_READY\n'; }
run_dgx_os_cdi_test_sudo() { printf 'DIGEST_PINNED_CDI_PROBE_OK\n'; }
run_dgx_os_gpus_test_sudo() { printf 'DIGEST_PINNED_GPUS_PROBE_OK\n'; }
ensure_docker_group() { printf 'DOCKER_GROUP_PRESENT\n'; }
install_packages() { printf 'UNEXPECTED_PACKAGE_MUTATION\n'; return 1; }
finish_runtime() { printf 'UNEXPECTED_RUNTIME_MUTATION\n'; return 1; }
configure_docker_runtime_if_needed() { printf 'UNEXPECTED_DOCKER_RUNTIME_MUTATION\n'; return 1; }
run_apply
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("FACTORY_GATES_OK");
    expect(output).toContain("WORKLOAD_GATE_OK");
    expect(output).toContain(
      "PACKAGED_LIFECYCLE systemctl enable nvidia-cdi-refresh.path nvidia-cdi-refresh.service",
    );
    expect(output).toContain("PACKAGED_LIFECYCLE systemctl start nvidia-cdi-refresh.path");
    expect(output).toContain("PACKAGED_LIFECYCLE systemctl restart nvidia-cdi-refresh.service");
    expect(output).toContain("cdi=nvidia.com/gpu=all source=packaged_refresh_service");
    expect(output).toContain("DIGEST_PINNED_CDI_PROBE_OK");
    expect(output).toContain("DIGEST_PINNED_GPUS_PROBE_OK");
    expect(output.indexOf("FACTORY_GATES_OK")).toBeLessThan(
      output.indexOf("PACKAGED_LIFECYCLE systemctl enable"),
    );
    expect(output.indexOf("cdi=nvidia.com/gpu=all source=packaged_refresh_service")).toBeLessThan(
      output.indexOf("DIGEST_PINNED_CDI_PROBE_OK"),
    );
    expect(output).toContain("APPLY_RESULT=COMPLETE");
    expect(output).not.toContain("UNEXPECTED_");
    expect(output).not.toContain("nvidia-ctk cdi generate");
    expect(output).not.toContain("systemctl restart docker.service");
    expect(output).not.toContain("systemctl restart containerd.service");
  });

  it.each([
    ["restart failure", "return 1", "Packaged CDI refresh failed"],
    ["missing device after restart", "return 0", "did not advertise nvidia.com/gpu=all"],
  ] as const)("fails closed on AI Developer Tools CDI %s", (_scenario, restartResult, error) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_command() { :; }
check_dgx_os_runtime_commands() { printf 'FACTORY_GATES_OK\n'; }
systemctl() {
  case "$*" in
    'is-active --quiet containerd.service'|'is-active --quiet docker.service') return 0 ;;
    *) printf 'UNEXPECTED_SYSTEMCTL %s\n' "$*"; return 1 ;;
  esac
}
station_sudo_local_default_docker() {
  case "$*" in
    'info'|'buildx version') return 0 ;;
    *) printf 'UNEXPECTED_DOCKER %s\n' "$*"; return 1 ;;
  esac
}
require_docker_mutation_quiescence() { printf 'WORKLOAD_GATE_OK %s\n' "$1"; }
sudo() {
  case "$*" in
    'nvidia-ctk cdi list') return 0 ;;
    'systemctl enable nvidia-cdi-refresh.path nvidia-cdi-refresh.service'|'systemctl start nvidia-cdi-refresh.path') return 0 ;;
    'systemctl restart nvidia-cdi-refresh.service') ${restartResult} ;;
    'systemctl status nvidia-cdi-refresh.service --no-pager'|'journalctl -u nvidia-cdi-refresh.service --no-pager -n 50')
      printf 'SERVICE_DIAGNOSTICS %s\n' "$*"
      ;;
    *) printf 'UNEXPECTED_SUDO %s\n' "$*"; return 1 ;;
  esac
}
nvidia-ctk() { return 0; }
ensure_dgx_os_acceptance_image() { printf 'UNEXPECTED_ACCEPTANCE_IMAGE\n'; return 1; }
run_dgx_os_cdi_test_sudo() { printf 'UNEXPECTED_CDI_PROBE\n'; return 1; }
run_dgx_os_gpus_test_sudo() { printf 'UNEXPECTED_GPUS_PROBE\n'; return 1; }
STATION_HOST_PROFILE=ai-developer-tools
verify_dgx_os_runtime_sudo
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("FACTORY_GATES_OK");
    expect(output).toContain("WORKLOAD_GATE_OK");
    expect(output).toContain("SERVICE_DIAGNOSTICS");
    expect(output).toContain(error);
    expect(output).not.toContain("UNEXPECTED_");
    expect(output).not.toContain("systemctl restart docker.service");
    expect(output).not.toContain("systemctl restart containerd.service");
  });

  it("keeps forced factory-runtime profiles out of packaged CDI repair", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=forced-factory-runtime
check_dgx_os_runtime_commands() { printf 'FACTORY_GATES_OK\n'; }
systemctl() {
  case "$*" in
    'is-active --quiet containerd.service'|'is-active --quiet docker.service') return 0 ;;
    *) printf 'UNEXPECTED_SYSTEMCTL %s\n' "$*"; return 1 ;;
  esac
}
station_sudo_local_default_docker() {
  case "$*" in
    'info'|'buildx version') return 0 ;;
    *) printf 'UNEXPECTED_DOCKER %s\n' "$*"; return 1 ;;
  esac
}
sudo() {
  [[ "$*" == "nvidia-ctk cdi list" ]] || { printf 'UNEXPECTED_SUDO %s\n' "$*"; return 1; }
}
refresh_cdi() { printf 'UNEXPECTED_CDI_REFRESH\n'; return 1; }
verify_dgx_os_runtime_sudo
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("FACTORY_GATES_OK");
    expect(output).toMatch(/does not advertise the nvidia\.com\/gpu=all CDI device/);
    expect(output).not.toContain("UNEXPECTED_");
    expect(output).not.toContain("nvidia-cdi-refresh");
  });

  it("returns a relogin result instead of requesting a reboot for factory Docker access", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
require_command() { :; }
acquire_sudo() { :; }
common_preflight() { STATION_HOST_PROFILE=ai-developer-tools; }
sudo() {
  [[ "$*" == "nvidia-ctk cdi list" ]] && printf 'nvidia.com/gpu=all\n'
}
verify_dgx_os_runtime_sudo() { printf 'FACTORY_RUNTIME_VALIDATED\n'; }
ensure_docker_group() { DOCKER_GROUP_ADDED=1; }
run_apply
`,
    );

    expect(result.status, output).toBe(11);
    expect(output).toContain("FACTORY_RUNTIME_VALIDATED");
    expect(output).toContain("APPLY_RESULT=LOGIN_REQUIRED");
    expect(output).not.toContain("REBOOT_REQUIRED");
  });

  it("accepts a healthy non-610 factory driver only for stock DGX OS", () => {
    const stock = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=stock-dgx-os
station_pci_device_is_gb300() { return 0; }
nvidia-smi() { printf '00000000:01:00.0, NVIDIA GB300, 595.71.05, 0, 0\n'; }
verify_gpu
`,
    );
    expect(stock.result.status, stock.output).toBe(0);
    expect(stock.output).toContain("driver=595.71.05");

    const generic = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=generic-ubuntu
station_pci_device_is_gb300() { return 0; }
nvidia-smi() { printf '00000000:01:00.0, NVIDIA GB300, 595.71.05, 0, 0\n'; }
verify_gpu
`,
    );
    expect(generic.result.status, generic.output).not.toBe(0);
    expect(generic.output).toContain("Expected driver 610.43.02, found 595.71.05");
  });

  it("validates the GB300 and permits an auxiliary RTX GPU with unavailable ECC", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=ai-developer-tools
station_pci_device_is_gb300() { [[ "$1" == "0000:01:00.0" ]]; }
nvidia-smi() {
  printf '00000000:02:00.0, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 610.43.03, [N/A], [N/A]\n'
  printf '00000000:01:00.0, NVIDIA GB300, 610.43.03, 0, 0\n'
}
verify_gpu
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("gpu_bdf=0000:02:00.0 gpu=NVIDIA RTX PRO 6000");
    expect(output).toContain("role=auxiliary validation=skipped");
    expect(output).toContain("gpu_bdf=0000:01:00.0 gpu=NVIDIA GB300 role=inference");
  });

  it("requires both factory container probes to expose the GB300 on a mixed-GPU host", () => {
    const mixed = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=ai-developer-tools
station_pci_device_is_gb300() { [[ "$1" == "0000:01:00.0" ]]; }
station_sudo_local_default_docker() {
  printf '00000000:02:00.0, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 610.43.03, [N/A], [N/A]\n'
  printf '00000000:01:00.0, NVIDIA GB300, 610.43.03, 0, 0\n'
}
run_dgx_os_cdi_test_sudo
run_dgx_os_gpus_test_sudo
`,
    );
    expect(mixed.result.status, mixed.output).toBe(0);
    expect(mixed.output).toContain("gpu_bdf=0000:01:00.0 gpu=NVIDIA GB300 role=inference");

    const rtxOnly = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=ai-developer-tools
station_pci_device_is_gb300() { [[ "$1" == "0000:01:00.0" ]]; }
station_sudo_local_default_docker() {
  printf '00000000:02:00.0, NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 610.43.03, [N/A], [N/A]\n'
}
run_dgx_os_cdi_test_sudo
`,
    );
    expect(rtxOnly.result.status, rtxOnly.output).not.toBe(0);
    expect(rtxOnly.output).toContain("Expected exactly one NVIDIA GB300 PCI device, found 0");
  });

  it("requires the qualified BaseOS driver to be loaded", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=colossus-baseos
station_pci_device_is_gb300() { return 0; }
nvidia-smi() { printf '00000000:01:00.0, NVIDIA GB300, 595.71.05, 0, 0\n'; }
verify_gpu
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Expected driver 595.58.03, found 595.71.05");
  });

  it("validates stock DGX OS device visibility without rewriting host runtime state", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=stock-dgx-os
check_dgx_os_runtime_commands() { printf 'COMMANDS_OK\n'; }
systemctl() {
  case "$*" in
    'is-active --quiet containerd.service'|'is-active --quiet docker.service') return 0 ;;
    *) printf 'UNEXPECTED_SYSTEMCTL %s\n' "$*"; return 1 ;;
  esac
}
station_sudo_local_default_docker() {
  case "$*" in
    'info'|'buildx version'|'ps -aq') return 0 ;;
    *) printf 'UNEXPECTED_DOCKER %s\n' "$*"; return 1 ;;
  esac
}
sudo() {
  case "$*" in
    'nvidia-ctk cdi list') printf 'nvidia.com/gpu=all\n' ;;
    *) printf 'UNEXPECTED_SUDO %s\n' "$*"; return 1 ;;
  esac
}
ensure_dgx_os_acceptance_image() { printf 'IMAGE_CACHE_READY\n'; }
run_dgx_os_cdi_test_sudo() { printf 'CDI_TEST_OK\n'; }
run_dgx_os_gpus_test_sudo() { printf 'GPUS_TEST_OK\n'; }
verify_docker_container_baseline() { printf 'CONTAINER_BASELINE_PRESERVED\n'; }
verify_dgx_os_runtime_sudo
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("COMMANDS_OK");
    expect(output).toContain("IMAGE_CACHE_READY");
    expect(output).toContain("CDI_TEST_OK");
    expect(output).toContain("GPUS_TEST_OK");
    expect(output).toContain("CONTAINER_BASELINE_PRESERVED");
    expect(output).toContain("DGX_OS_HOST_READY host_runtime_mutation=container_image_cache_only");
    expect(output).not.toContain("UNEXPECTED_SYSTEMCTL");
    expect(output).not.toContain("UNEXPECTED_DOCKER");
    expect(output).not.toContain("UNEXPECTED_SUDO");
  });

  it.each([
    [
      "CDI",
      "run_dgx_os_cdi_test_sudo() { return 1; }",
      /failed the CDI Docker GPU visibility test/,
    ],
    [
      "--gpus all",
      "run_dgx_os_gpus_test_sudo() { return 1; }",
      /failed the Docker --gpus all GPU visibility test/,
    ],
  ])("fails stock DGX OS closed when the %s contract fails", (_contract, override, message) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
check_dgx_os_runtime_commands() { :; }
systemctl() { return 0; }
station_sudo_local_default_docker() { return 0; }
sudo() {
  case "$*" in
    'nvidia-ctk cdi list') printf 'nvidia.com/gpu=all\n' ;;
    *) return 0 ;;
  esac
}
ensure_dgx_os_acceptance_image() { :; }
run_dgx_os_cdi_test_sudo() { return 0; }
run_dgx_os_gpus_test_sudo() { return 0; }
${override}
verify_dgx_os_runtime_sudo
`,
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(message);
  });

  it.each([
    ["DOCKER_HOST", { DOCKER_HOST: "tcp://remote.example:2376" }, /unset DOCKER_HOST/],
    ["DOCKER_CONTEXT", { DOCKER_CONTEXT: "remote-cluster" }, /unset DOCKER_CONTEXT/],
  ])("rejects ambient %s before stock runtime validation", (_name, env, message) => {
    const { result, output } = runSourced(STATION_PREPARE, `check_dgx_os_docker_selection`, env);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(message);
  });

  it.each([
    [
      "a missing GB300 PCI identity",
      "00000000:01:00.0, NVIDIA GB300, 595.71.05, 0, 0",
      "return 1",
      /Expected exactly one NVIDIA GB300 PCI device, found 0/,
    ],
    [
      "non-zero volatile ECC",
      "00000000:01:00.0, NVIDIA GB300, 595.71.05, 1, 0",
      "return 0",
      /ECC must be 0\/0/,
    ],
    [
      "a failing second GPU row",
      "00000000:01:00.0, NVIDIA GB300, 595.71.05, 0, 0\n00000000:02:00.0, NVIDIA GB300, 595.71.05, 0, 1",
      "return 0",
      /ECC must be 0\/0/,
    ],
  ])("fails stock validation for %s", (_scenario, row, pciResult, message) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=stock-dgx-os
station_pci_device_is_gb300() { ${pciResult}; }
nvidia-smi() { printf '%s\n' "$GPU_ROW"; }
verify_gpu
`,
      { GPU_ROW: row },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(message);
  });
});
