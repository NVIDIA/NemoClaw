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

function runSourced(body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-package-state-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$STATION_PREPARE" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: { HOME: home, PATH: TEST_SYSTEM_PATH, STATION_PREPARE, ...extraEnv },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

function runRealApplyPackagePreflight(body: string) {
  return runSourced(`
mkdir -p "$HOME/pci/0000:01:00.0"
printf '%s\n' 'ID=ubuntu' 'VERSION_ID="24.04"' 'PRETTY_NAME="Ubuntu 24.04 fixture"' >"$HOME/os-release"
printf 'NVIDIA DGX Station GB300\n' >"$HOME/product-name"
printf '0x10de\n' >"$HOME/pci/0000:01:00.0/vendor"
printf '0x31c2\n' >"$HOME/pci/0000:01:00.0/device"
printf '0x030200\n' >"$HOME/pci/0000:01:00.0/class"
station_os_release_path() { printf '%s\n' "$HOME/os-release"; }
station_product_name_path() { printf '%s\n' "$HOME/product-name"; }
station_pci_devices_path() { printf '%s\n' "$HOME/pci"; }
dgx_station_release_path() { printf '%s\n' "$HOME/no-dgx-release"; }
uname() {
  case "$1" in
    -m) printf 'aarch64\n' ;;
    -r) printf '6.8.0-fixture\n' ;;
    *) return 1 ;;
  esac
}
dpkg-query() { return 1; }
dpkg() { :; }
getent() { :; }
ps() { :; }
lslocks() { :; }
sha256sum() { :; }
ss() { :; }
systemctl() { :; }
mokutil() { printf 'SECURE_BOOT_CHECK_REACHED\n'; return 1; }
sudo() {
  if [[ "$*" == "-n true" ]]; then return 0; fi
  if [[ "$1" == "-n" && "$2" == "lslocks" ]]; then shift; "$@"; return; fi
  printf 'UNEXPECTED_SUDO %s\n' "$*"
  return 1
}
MODE='--apply'
${body}
run_apply
`);
}

describe("DGX Station package state", () => {
  it.each([
    { label: "missing", queryStatus: "1", record: "", expected: "missing" },
    {
      label: "native exact",
      queryStatus: "0",
      record: "ii |arm64|5:29.6.1-1~ubuntu.24.04~noble",
      expected: "exact",
    },
    {
      label: "architecture-independent exact",
      queryStatus: "0",
      record: "ii |all|5:29.6.1-1~ubuntu.24.04~noble",
      expected: "exact",
    },
    {
      label: "version mismatch",
      queryStatus: "0",
      record: "ii |arm64|5:30.0.0-1~ubuntu.24.04~noble",
      expected: "mismatch",
    },
    {
      label: "unpacked",
      queryStatus: "0",
      record: "iU |arm64|5:29.6.1-1~ubuntu.24.04~noble",
      expected: "unhealthy-status",
    },
    {
      label: "held",
      queryStatus: "0",
      record: "hi |arm64|5:29.6.1-1~ubuntu.24.04~noble",
      expected: "unhealthy-status",
    },
    {
      label: "foreign architecture",
      queryStatus: "0",
      record: "ii |amd64|5:29.6.1-1~ubuntu.24.04~noble",
      expected: "wrong-architecture",
    },
    { label: "empty record", queryStatus: "0", record: "", expected: "invalid-record" },
    {
      label: "multiple records",
      queryStatus: "0",
      record: "ii |arm64|5:29.6.1-1~ubuntu.24.04~noble\nii |all|5:29.6.1-1~ubuntu.24.04~noble",
      expected: "invalid-record",
    },
    { label: "query failure", queryStatus: "2", record: "", expected: "query-error" },
  ])("classifies $label package state as $expected", ({ queryStatus, record, expected }) => {
    const { result, output } = runSourced(
      `
installed_package_record() {
  if ((PACKAGE_QUERY_STATUS != 0)); then return "$PACKAGE_QUERY_STATUS"; fi
  printf '%s' "$PACKAGE_RECORD"
}
package_state 'docker-ce=5:29.6.1-1~ubuntu.24.04~noble'
`,
      { PACKAGE_QUERY_STATUS: queryStatus, PACKAGE_RECORD: record },
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it.each([
    { queryStatus: 1, expected: "missing" },
    { queryStatus: 2, expected: "query-error" },
  ])("maps dpkg-query status $queryStatus to $expected without triggering ERR", ({
    queryStatus,
    expected,
  }) => {
    const { result, output } = runSourced(
      `
dpkg-query() { return "$PACKAGE_QUERY_STATUS"; }
package_state 'docker-ce=5:29.6.1-1~ubuntu.24.04~noble'
`,
      { PACKAGE_QUERY_STATUS: String(queryStatus) },
    );

    expect(result.status, output).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
    expect(output).not.toContain("command failed");
  });

  it("allows only the reviewed factory DKMS transition", () => {
    const body = `
installed_package_record() {
  if [[ "$1" == "dkms" ]]; then printf 'ii |all|%s' "$DKMS_ACTUAL"; else return 1; fi
}
installed_version() { if [[ "$1" == "dkms" ]]; then printf '%s' "$DKMS_ACTUAL"; fi; }
package_state 'dkms=1:3.4.0-1ubuntu1'
assert_no_package_mismatches
`;
    const approved = runSourced(body, { DKMS_ACTUAL: "3.0.11-1ubuntu13" });
    expect(approved.result.status, approved.output).toBe(0);
    expect(approved.output).toContain("approved-transition");
    expect(approved.output).toContain("status=approved_transition");

    const arbitrary = runSourced(body, { DKMS_ACTUAL: "3.2.0-1" });
    expect(arbitrary.result.status, arbitrary.output).not.toBe(0);
    expect(arbitrary.output).toMatch(/dkms status=mismatch/);
  });

  it("refuses to change an existing mismatched prerequisite", () => {
    const { result, output } = runSourced(`
installed_package_record() {
  if [[ "$1" == "docker-ce" ]]; then printf 'ii |arm64|5:30.0.0-1~ubuntu.24.04~noble'; else return 1; fi
}
installed_version() { if [[ "$1" == "docker-ce" ]]; then printf '5:30.0.0-1~ubuntu.24.04~noble'; fi; }
assert_no_package_mismatches
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/docker-ce status=mismatch/);
    expect(output).toMatch(/package state is unhealthy or differs from the validated pins/);
  });

  it.each([
    "unattended-upgr",
    "packagekitd",
    "apt.systemd.dai",
  ])("detects the Linux package-manager process name %s", (processName) => {
    const { result, output } = runSourced(
      `
STATION_HOST_PROFILE=generic-ubuntu
ps() { printf '4242 %s\n' "$PACKAGE_PROCESS"; }
lslocks() { :; }
check_package_managers_idle test
`,
      { PACKAGE_PROCESS: processName },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain(`4242 ${processName}`);
    expect(output).toMatch(/package-manager process is active/);
  });

  it.each([
    "/var/lib/dpkg/lock-frontend",
    "/var/lib/dpkg/lock",
    "/var/cache/apt/archives/lock",
    "/var/lib/apt/lists/lock",
  ])("rejects active package lock %s even when no process name is visible", (lockPath) => {
    const { result, output } = runSourced(
      `
STATION_HOST_PROFILE=generic-ubuntu
MODE='--apply'
ps() { :; }
lslocks() { printf '4242 helper %s\n' "$PACKAGE_LOCK"; }
sudo() { if [[ "$1" == "-n" ]]; then shift; fi; "$@"; }
check_package_managers_idle test
`,
      { PACKAGE_LOCK: lockPath },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain(`4242 helper ${lockPath}`);
    expect(output).toMatch(/APT or dpkg lock is active/);
  });

  it("runs the real apply preflight and rejects unfinished dpkg work before later checks", () => {
    const { result, output } = runRealApplyPackagePreflight(`
dpkg() { [[ "$*" == "--audit" ]] && printf ' package is unpacked but not configured\n'; }
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/dpkg reports unfinished package work/);
    expect(output).not.toContain("SECURE_BOOT_CHECK_REACHED");
    expect(output).not.toContain("UNEXPECTED_SUDO");
  });

  it("fails closed when dpkg audit itself cannot run", () => {
    const { result, output } = runSourced(`
dpkg() { return 2; }
check_dpkg_database_health
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/Unable to audit the dpkg database/);
  });

  it("runs the real apply preflight and rejects an active package lock before mutation", () => {
    const { result, output } = runRealApplyPackagePreflight(`
lslocks() { printf '5151 apt-get /var/cache/apt/archives/lock\n'; }
`);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("5151 apt-get /var/cache/apt/archives/lock");
    expect(output).toMatch(/APT or dpkg lock is active/);
    expect(output).not.toContain("SECURE_BOOT_CHECK_REACHED");
    expect(output).not.toContain("UNEXPECTED_SUDO");
  });
});
