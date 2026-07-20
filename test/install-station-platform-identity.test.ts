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

function runStationPrepare(body: string, extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-identity-"));
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source "$STATION_PREPARE" >/dev/null\n${body}`],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        HOME: home,
        PATH: TEST_SYSTEM_PATH,
        STATION_PREPARE,
        ...extraEnv,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  return { result, output: `${result.stdout}${result.stderr}` };
}

function writePciIdentityFixture(
  vendor = "0x10de",
  device = "0x31c2",
  pciClass = "0x030200",
  busId = "0000:01:00.0",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-pci-"));
  const pciDevice = path.join(root, busId);
  fs.mkdirSync(pciDevice);
  fs.writeFileSync(path.join(pciDevice, "vendor"), `${vendor}\n`);
  fs.writeFileSync(path.join(pciDevice, "device"), `${device}\n`);
  fs.writeFileSync(path.join(pciDevice, "class"), `${pciClass}\n`);
  return root;
}

function writePciIdentityFixtureMissing(field: "vendor" | "device" | "class") {
  const root = writePciIdentityFixture();
  fs.rmSync(path.join(root, "0000:01:00.0", field));
  return root;
}

describe("DGX Station platform identity", () => {
  it.each([
    ["Dell Pro Max with Station GB300", true],
    ["NVIDIA DGX Station GB300", true],
    ["P3830", false],
    ["NVIDIA P3830 Rev A", false],
    ["Acme XP3830 Workstation", false],
    ["Acme Workstation GB300", false],
    ["NVIDIA DGX Station GB300X", false],
    ["NVIDIA DGX Station A100", false],
    ["Dell Pro Max with Station GB200", false],
    ["Dell Pro Max with GB300", false],
  ])("accepts only Station GB300 DMI: %s", (product, accepted) => {
    const { result } = runStationPrepare(`is_station_gb300_product "$PRODUCT"`, {
      PRODUCT: product,
    });

    expect(result.status === 0).toBe(accepted);
  });

  it("requires the exact NVIDIA GB300 PCI GPU identity (#7103)", () => {
    const pciRoot = writePciIdentityFixture();
    const { result, output } = runStationPrepare(`station_has_exact_gb300_pci_gpu "$PCI_ROOT"`, {
      PCI_ROOT: pciRoot,
    });

    expect(result.status, output).toBe(0);
  });

  it.each([
    ["0x31c2", "0x31c2"],
    ["0x31c3", "0x31c3"],
  ])("accepts GB300 PCI device id %s (#7235)", (_scenario, device) => {
    const pciRoot = writePciIdentityFixture("0x10de", device);
    const { result, output } = runStationPrepare(`station_has_exact_gb300_pci_gpu "$PCI_ROOT"`, {
      PCI_ROOT: pciRoot,
    });

    expect(result.status, output).toBe(0);
  });

  it("selects the GB300 by PCI identity when an auxiliary GPU has the same name", () => {
    const pciRoot = writePciIdentityFixture();
    const { result, output } = runStationPrepare(
      `
station_pci_devices_path() { printf '%s' "$PCI_ROOT"; }
nvidia-smi() {
  printf '%s\n' \
    '00000000:02:00.0, NVIDIA GB300, 595.71.05, 1, 0' \
    '00000000:01:00.0, NVIDIA GB300, 595.71.05, 0, 0'
}
STATION_HOST_PROFILE=stock-dgx-os
verify_gpu
`,
      { PCI_ROOT: pciRoot },
    );

    expect(result.status, output).toBe(0);
    expect(output).toContain(
      "gpu_bdf=0000:02:00.0 gpu=NVIDIA GB300 role=auxiliary validation=skipped",
    );
    expect(output).toContain(
      "gpu_bdf=0000:01:00.0 gpu=NVIDIA GB300 role=inference driver=595.71.05 ecc_corrected=0 ecc_uncorrected=0",
    );
  });

  it("qualifies the loaded driver from the PCI-identified GB300 instead of GPU index zero", () => {
    const pciRoot = writePciIdentityFixture();
    const { result, output } = runStationPrepare(
      `
station_pci_devices_path() { printf '%s' "$PCI_ROOT"; }
nvidia-smi() {
  printf '%s\n' \
    '00000000:02:00.0, 620.1' \
    '00000000:01:00.0, 610.43.02'
}
driver_loaded_exact
`,
      { PCI_ROOT: pciRoot },
    );

    expect(result.status, output).toBe(0);
  });

  it.each([
    ["wrong vendor", writePciIdentityFixture("0x1234")],
    ["wrong device", writePciIdentityFixture("0x10de", "0x31c1")],
    ["non-GPU PCI class", writePciIdentityFixture("0x10de", "0x31c2", "0x020000")],
    ["missing vendor", writePciIdentityFixtureMissing("vendor")],
    ["missing device", writePciIdentityFixtureMissing("device")],
    ["missing class", writePciIdentityFixtureMissing("class")],
    ["empty PCI tree", fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-pci-empty-"))],
  ])("rejects %s as a GB300 PCI identity (#7103)", (_scenario, pciRoot) => {
    const { result } = runStationPrepare(`station_has_exact_gb300_pci_gpu "$PCI_ROOT"`, {
      PCI_ROOT: pciRoot,
    });

    expect(result.status).not.toBe(0);
  });

  it("rejects a generic Ubuntu host without the GB300 PCI identity before mutation (#7103)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-platform-"));
    const osReleasePath = path.join(fixtureRoot, "os-release");
    const productNamePath = path.join(fixtureRoot, "product_name");
    const dgxReleasePath = path.join(fixtureRoot, "absent-dgx-release");
    const pciRoot = writePciIdentityFixture("0x1234");
    fs.writeFileSync(
      osReleasePath,
      'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n',
    );
    fs.writeFileSync(productNamePath, "DGX Station GB300\n");

    const { result, output } = runStationPrepare(
      `
station_os_release_path() { printf '%s' "$OS_RELEASE_PATH"; }
station_product_name_path() { printf '%s' "$PRODUCT_NAME_PATH"; }
station_pci_devices_path() { printf '%s' "$PCI_ROOT"; }
dgx_station_release_path() { printf '%s' "$DGX_RELEASE_PATH"; }
uname() {
  case "$*" in
    -m) printf 'aarch64' ;;
    -r) printf 'test-kernel' ;;
    *) return 1 ;;
  esac
}
require_command() { :; }
acquire_sudo() { :; }
install_packages() { printf 'UNEXPECTED_MUTATION\n'; }
run_apply
`,
      {
        OS_RELEASE_PATH: osReleasePath,
        PRODUCT_NAME_PATH: productNamePath,
        PCI_ROOT: pciRoot,
        DGX_RELEASE_PATH: dgxReleasePath,
      },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Expected an NVIDIA GB300 PCI GPU (10de:31c2/31c3)");
    expect(output).not.toContain("UNEXPECTED_MUTATION");
  });

  it("rejects forced metadata intent without the exact GB300 PCI identity before mutation (#7138)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-platform-"));
    const osReleasePath = path.join(fixtureRoot, "os-release");
    const productNamePath = path.join(fixtureRoot, "product_name");
    const dgxReleasePath = path.join(fixtureRoot, "dgx-release");
    const pciRoot = writePciIdentityFixture("0x1234");
    fs.writeFileSync(
      osReleasePath,
      'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n',
    );
    fs.writeFileSync(productNamePath, "DGX Station GB300\n");
    fs.writeFileSync(dgxReleasePath, 'DGX_PRETTY_NAME="Unrecognized Station"\n');

    const { result, output } = runStationPrepare(
      `
station_os_release_path() { printf '%s' "$OS_RELEASE_PATH"; }
station_product_name_path() { printf '%s' "$PRODUCT_NAME_PATH"; }
station_pci_devices_path() { printf '%s' "$PCI_ROOT"; }
dgx_station_release_path() { printf '%s' "$DGX_RELEASE_PATH"; }
dgx_station_release_state() { printf 'unsupported-dgx-os'; }
uname() {
  case "$*" in
    -m) printf 'aarch64' ;;
    -r) printf 'test-kernel' ;;
    *) return 1 ;;
  esac
}
require_command() { :; }
acquire_sudo() { :; }
install_packages() { printf 'UNEXPECTED_MUTATION\n'; }
FORCE_STATION_INSTALL=1
run_apply
`,
      {
        OS_RELEASE_PATH: osReleasePath,
        PRODUCT_NAME_PATH: productNamePath,
        PCI_ROOT: pciRoot,
        DGX_RELEASE_PATH: dgxReleasePath,
      },
    );

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Expected an NVIDIA GB300 PCI GPU (10de:31c2/31c3)");
    expect(output).not.toContain("UNEXPECTED_MUTATION");
  });
});
