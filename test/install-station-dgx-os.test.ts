// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");

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
  return { result, output: `${result.stdout}${result.stderr}` };
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
    ["unreviewed version", writeDgxReleaseFixture("7.6.0")],
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
    expect(result.stdout).toMatch(/^(generic-ubuntu|supported-dgx-os|unsupported-dgx-os)$/);
    expect(result.stderr).toBe("");
  });
});

describe("DGX Station stock DGX OS runtime validation", () => {
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

  it("accepts a healthy non-610 factory driver only for stock DGX OS", () => {
    const stock = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=stock-dgx-os
nvidia-smi() { printf 'NVIDIA GB300, 595.71.05, 0, 0\n'; }
verify_gpu
`,
    );
    expect(stock.result.status, stock.output).toBe(0);
    expect(stock.output).toContain("driver=595.71.05");

    const generic = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=generic-ubuntu
nvidia-smi() { printf 'NVIDIA GB300, 595.71.05, 0, 0\n'; }
verify_gpu
`,
    );
    expect(generic.result.status, generic.output).not.toBe(0);
    expect(generic.output).toContain("Expected driver 610.43.02, found 595.71.05");
  });

  it("validates stock DGX OS device visibility without rewriting host runtime state", () => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
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
verify_dgx_os_runtime_sudo
`,
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain("COMMANDS_OK");
    expect(output).toContain("IMAGE_CACHE_READY");
    expect(output).toContain("CDI_TEST_OK");
    expect(output).toContain("GPUS_TEST_OK");
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
    ["wrong GPU", "NVIDIA GB200, 595.71.05, 0, 0", /Expected NVIDIA GB300/],
    ["non-zero volatile ECC", "NVIDIA GB300, 595.71.05, 1, 0", /ECC must be 0\/0/],
    [
      "a failing second GPU row",
      "NVIDIA GB300, 595.71.05, 0, 0\nNVIDIA GB300, 595.71.05, 0, 1",
      /ECC must be 0\/0/,
    ],
  ])("fails stock validation for %s", (_scenario, row, message) => {
    const { result, output } = runSourced(
      STATION_PREPARE,
      `
STATION_HOST_PROFILE=stock-dgx-os
nvidia-smi() { printf '%s\n' "$GPU_ROW"; }
verify_gpu
`,
      { GPU_ROW: row },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(message);
  });
});
