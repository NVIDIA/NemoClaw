// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectPlatformIdentity,
  type StationProfile,
} from "../../src/lib/readiness/platform-qualification";
import { TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const INSTALLER = path.join(REPO_ROOT, "scripts", "install.sh");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const DISPLAY_NAME = 'DGX_PRETTY_NAME="NVIDIA DGX GB300 Workstation"';
const PLATFORM = 'DGX_PLATFORM="DGX Server for GALAXY-GB300"';
const fixtureDirectories: string[] = [];

interface PciFixtureValues {
  vendor?: string;
  device?: string;
  pciClass?: string;
}

function marker(...lines: string[]): string {
  return [`DGX_NAME="DGX GB300WS"`, DISPLAY_NAME, ...lines, PLATFORM, ""].join("\n");
}

function noOta(version: string, buildDate: string, platform = PLATFORM): string {
  return marker(`DGX_SWBUILD_DATE="${buildDate}"`, `DGX_SWBUILD_VERSION="${version}"`).replace(
    PLATFORM,
    platform,
  );
}

function ota(otaPrettyName = 'DGX_OTA_PRETTY_NAME="DGX OS"'): string {
  return marker(
    otaPrettyName,
    'DGX_OTA_VERSION="7.5.0"',
    'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
  );
}

function classifyWithStationHelper(release: string): string {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-parity-"));
  fixtureDirectories.push(fixtureDirectory);
  const releasePath = path.join(fixtureDirectory, "dgx-release");
  fs.writeFileSync(releasePath, release);
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source "$STATION_PREPARE" >/dev/null
if profile="$(dgx_station_release_profile "$DGX_RELEASE")"; then
  printf '%s' "$profile"
else
  printf '%s' unsupported-dgx-os
fi`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        HOME: fixtureDirectory,
        PATH: TEST_SYSTEM_PATH,
        STATION_PREPARE,
        DGX_RELEASE: releasePath,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout;
}

function classifyWithReadiness(release: string): StationProfile | null | undefined {
  const fixtureFiles = new Map([
    ["product_name", "NVIDIA DGX Station GB300\n"],
    ["os-release", 'ID="ubuntu"\nVERSION_ID="24.04"\n'],
    ["vendor", "0x10de\n"],
    ["device", "0x31c2\n"],
    ["class", "0x030000\n"],
  ]);
  return collectPlatformIdentity({
    productNamePath: "/fixture/product_name",
    osReleasePath: "/fixture/os-release",
    stationReleasePath: "/fixture/dgx-release",
    pciDevicesPath: "/fixture/pci",
    readFile: (filePath) => fixtureFiles.get(path.basename(filePath)) ?? "",
    readdir: () => ["0000:01:00.0"],
    openFile: () => 17,
    statFileDescriptor: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: Buffer.byteLength(release),
      uid: 0,
      gid: 0,
      mode: 0o100644,
    }),
    readFileDescriptor: () => release,
    closeFileDescriptor: () => undefined,
  }).stationProfile;
}

function classifyFirmwareWithStationHelper(
  productName: string,
  productFamily: string,
  boardName: string,
  deviceTreeModel = "",
): string {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-firmware-"));
  fixtureDirectories.push(fixtureDirectory);
  for (const [name, value] of [
    ["product_name", productName],
    ["product_family", productFamily],
    ["board_name", boardName],
    ["model", deviceTreeModel],
  ]) {
    fs.writeFileSync(
      path.join(fixtureDirectory, name),
      name === "model" || value.includes("\n") ? value : `${value}\n`,
    );
  }
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source "$STATION_PREPARE" >/dev/null
station_product_name_path() { printf '%s' "$FIXTURE/product_name"; }
station_product_family_path() { printf '%s' "$FIXTURE/product_family"; }
station_board_name_path() { printf '%s' "$FIXTURE/board_name"; }
station_device_tree_model_path() { printf '%s' "$FIXTURE/model"; }
station_firmware_identity_state`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        HOME: fixtureDirectory,
        PATH: TEST_SYSTEM_PATH,
        STATION_PREPARE,
        FIXTURE: fixtureDirectory,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout;
}

function classifyFirmwareWithReadiness(
  productName: string,
  productFamily: string,
  boardName: string,
  deviceTreeModel = "",
  pciEntryCount = 1,
  pciClass = "0x030000",
  pciValues: PciFixtureValues = {},
) {
  const values = new Map([
    ["product_name", productName],
    ["product_family", productFamily],
    ["board_name", boardName],
    ["model", deviceTreeModel],
    ["vendor", pciValues.vendor ?? "0x10de"],
    ["device", pciValues.device ?? "0x31c2"],
    ["class", pciValues.pciClass ?? pciClass],
  ]);
  return collectPlatformIdentity({
    productNamePath: "/fixture/product_name",
    productFamilyPath: "/fixture/product_family",
    boardNamePath: "/fixture/board_name",
    deviceTreeModelPath: "/fixture/model",
    stationReleasePath: "/fixture/absent-release",
    pciDevicesPath: "/fixture/pci",
    readFile: (filePath) => values.get(path.basename(filePath)) ?? "",
    readdir: () =>
      Array.from(
        { length: pciEntryCount },
        (_, index) => `0000:${String(index).padStart(2, "0")}:00.0`,
      ),
    openFile: () => {
      throw Object.assign(new Error("marker is absent"), { code: "ENOENT" });
    },
    statFileDescriptor: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 1,
      uid: 0,
      gid: 0,
      mode: 0o100644,
    }),
    closeFileDescriptor: () => undefined,
  });
}

function runStationCheckPlatform(
  release: string,
  {
    force = false,
    productName = "NVIDIA DGX Station GB300",
    productFamily = "Generic family",
    markerMetadata = "0|0|644|256",
    stationPci = true,
  }: {
    force?: boolean;
    productName?: string;
    productFamily?: string;
    markerMetadata?: string;
    stationPci?: boolean;
  } = {},
) {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-consumer-"));
  fixtureDirectories.push(fixtureDirectory);
  for (const [name, value] of [
    ["os-release", 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04"\n'],
    ["product_name", `${productName}\n`],
    ["product_family", `${productFamily}\n`],
    ["board_name", "Generic board\n"],
    ["model", "Generic device tree\0"],
    ["dgx-release", release],
  ]) {
    fs.writeFileSync(path.join(fixtureDirectory, name), value);
  }
  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source "$STATION_PREPARE" >/dev/null
stat() { printf '%s\n' "$MARKER_METADATA"; }
uname() { printf 'aarch64\n'; }
station_os_release_path() { printf '%s' "$FIXTURE/os-release"; }
station_product_name_path() { printf '%s' "$FIXTURE/product_name"; }
station_product_family_path() { printf '%s' "$FIXTURE/product_family"; }
station_board_name_path() { printf '%s' "$FIXTURE/board_name"; }
station_device_tree_model_path() { printf '%s' "$FIXTURE/model"; }
dgx_station_release_path() { printf '%s' "$FIXTURE/dgx-release"; }
station_has_exact_gb300_pci_gpu() { return "$STATION_PCI_STATUS"; }
FORCE_STATION_INSTALL="$FORCE"
check_platform
printf 'PROFILE=%s\n' "$STATION_HOST_PROFILE"`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        HOME: fixtureDirectory,
        PATH: TEST_SYSTEM_PATH,
        STATION_PREPARE,
        FIXTURE: fixtureDirectory,
        FORCE: force ? "1" : "0",
        MARKER_METADATA: markerMetadata,
        STATION_PCI_STATUS: stationPci ? "0" : "1",
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
}

function detectWithInstallerWrapper(
  productName: string,
  productFamily: string,
  stationPci = true,
  pciEntryCount = 1,
  pciClass = "0x030000",
  pciValues: PciFixtureValues = {},
): string {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-handoff-"));
  fixtureDirectories.push(fixtureDirectory);
  for (const [name, value] of [
    ["product_name", productName],
    ["product_family", productFamily],
    ["board_name", "Generic board"],
    ["model", "Generic device tree"],
  ]) {
    fs.writeFileSync(path.join(fixtureDirectory, name), `${value}\n`);
  }
  for (const index of Array.from({ length: pciEntryCount }, (_, entryIndex) => entryIndex)) {
    const pciDevice = path.join(
      fixtureDirectory,
      "pci",
      `0000:${String(index).padStart(2, "0")}:00.0`,
    );
    fs.mkdirSync(pciDevice, { recursive: true });
    fs.writeFileSync(path.join(pciDevice, "vendor"), `${pciValues.vendor ?? "0x10de"}\n`);
    fs.writeFileSync(
      path.join(pciDevice, "device"),
      `${pciValues.device ?? (stationPci ? "0x31c2" : "0xffff")}\n`,
    );
    fs.writeFileSync(path.join(pciDevice, "class"), `${pciValues.pciClass ?? pciClass}\n`);
  }
  fs.writeFileSync(
    path.join(fixtureDirectory, "prepare-dgx-station-host.sh"),
    `#!/usr/bin/env bash
source "$STATION_PREPARE"
station_product_name_path() { printf '%s' "$FIXTURE/product_name"; }
station_product_family_path() { printf '%s' "$FIXTURE/product_family"; }
station_board_name_path() { printf '%s' "$FIXTURE/board_name"; }
station_device_tree_model_path() { printf '%s' "$FIXTURE/model"; }
station_pci_devices_path() { printf '%s' "$FIXTURE/pci"; }
dgx_station_release_path() { printf '%s' "$FIXTURE/absent-release"; }
main "$@"
`,
  );
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source "$INSTALLER" >/dev/null
SCRIPT_DIR="$FIXTURE"
printf 'hardware=%s\n' "$(classify_dgx_station_hardware)"
printf 'platform=%s\n' "$(detect_express_platform)"`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        HOME: fixtureDirectory,
        PATH: TEST_SYSTEM_PATH,
        FIXTURE: fixtureDirectory,
        INSTALLER,
        STATION_PREPARE,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout;
}

afterEach(() => {
  fixtureDirectories
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

describe("DGX Station release classifier parity", () => {
  it.each([
    ["OTA DGX OS", "supported-dgx-os", ota()],
    ["OTA-upgraded DGX OS", "supported-dgx-os", ota("")],
    ["no-OTA DGX OS", "supported-dgx-os", noOta("7.6.0", "2026-07-30-10-25-15")],
    [
      "reported Colossus BaseOS",
      "supported-colossus-baseos",
      noOta("7.5.0-GB300ws-GB200ws", "2026-04-02-08-20-16").replace(
        DISPLAY_NAME,
        'DGX_PRETTY_NAME="NVIDIA DGX GB300WS"',
      ),
    ],
    [
      "changed-label Colossus BaseOS",
      "supported-colossus-baseos",
      noOta("7.5.0-GB300ws-GB200ws", "2026-04-02-08-20-16"),
    ],
    [
      "server-label Colossus BaseOS",
      "supported-colossus-baseos",
      noOta("7.5.0-GB300ws-GB200ws", "2026-04-02-08-20-16").replace(
        DISPLAY_NAME,
        'DGX_PRETTY_NAME="NVIDIA DGX Server"',
      ),
    ],
    ["AI Developer Tools", "supported-ai-developer-tools", noOta("7.5.0", "2026-06-16-11-48-10")],
    ["future no-OTA family", "unsupported-dgx-os", noOta("7.7.0", "2026-07-30")],
    [
      "factory build-date drift",
      "unsupported-dgx-os",
      noOta("7.5.0-GB300ws-GB200ws", "2026-04-03-00-00-00"),
    ],
    [
      "different DGX platform",
      "unsupported-dgx-os",
      noOta("7.6.0", "2026-07-30", 'DGX_PLATFORM="DGX Server for GALAXY-GB200"'),
    ],
    ["unexpected OTA lineage", "unsupported-dgx-os", ota('DGX_OTA_PRETTY_NAME="BaseOS"')],
  ] as const)("classifies %s as %s in both consumers (#10928)", (_scenario, expected, release) => {
    expect(classifyWithReadiness(release)).toBe(expected);
    expect(classifyWithStationHelper(release)).toBe(expected);
  });

  it("uses the Station family field when the product name is generic (#10928)", () => {
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      "NVIDIA DGX Station GB300",
      "Generic board",
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "NVIDIA DGX Station GB300",
      "Generic board",
    );

    expect(shell).toBe("station-gb300");
    expect(readiness).toMatchObject({
      nvidiaPlatform: "station",
      stationFirmwareProduct: "NVIDIA DGX Station GB300",
    });
  });

  it("passes a family-only Station identity through host preparation (#10928)", () => {
    const result = runStationCheckPlatform(noOta("7.6.0", "2026-07-14-13-59-06"), {
      productName: "Generic ARM workstation",
      productFamily: "NVIDIA DGX Station GB300",
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("firmware_product=NVIDIA DGX Station GB300");
    expect(result.stdout).toContain("PROFILE=stock-dgx-os");
  });

  it("requires exact GB300 PCI evidence for a supported Station profile (#10928)", () => {
    const result = runStationCheckPlatform(noOta("7.6.0", "2026-07-14-13-59-06"), {
      stationPci: false,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toContain("Expected an NVIDIA GB300 PCI GPU");
  });

  it("passes family-only identity through the installer-to-helper boundary (#10928)", () => {
    expect(detectWithInstallerWrapper("Generic ARM workstation", "NVIDIA DGX Station GB300")).toBe(
      "hardware=station-gb300\nplatform=DGX Station\n",
    );
  });

  it("passes firmware conflicts through the installer-to-helper boundary (#10928)", () => {
    expect(detectWithInstallerWrapper("NVIDIA DGX Spark", "NVIDIA DGX Station GB300")).toBe(
      "hardware=conflicting\nplatform=Conflicting NVIDIA firmware identity\n",
    );
  });

  it("rejects embedded firmware control characters in both consumers (#10928)", () => {
    const shell = classifyFirmwareWithStationHelper(
      "NVIDIA DGX Station\tGB300",
      "Generic family",
      "Generic board",
    );
    const readiness = classifyFirmwareWithReadiness(
      "NVIDIA DGX Station\tGB300",
      "Generic family",
      "Generic board",
    );

    expect(shell).toBe("not-station");
    expect(readiness.nvidiaPlatform).toBeUndefined();
  });

  it("rejects an embedded NUL in DMI firmware before shell conversion (#10928)", () => {
    const productFamily = "NVIDIA DGX\0 Station GB300";
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      productFamily,
      "Generic board",
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      productFamily,
      "Generic board",
    );

    expect(shell).toBe("not-station");
    expect(readiness.nvidiaPlatform).toBeUndefined();
  });

  it("rejects repeated DMI line terminators in both consumers (#10928)", () => {
    const productFamily = "NVIDIA DGX Station GB300\n\n";
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      productFamily,
      "Generic board",
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      productFamily,
      "Generic board",
    );

    expect(shell).toBe("not-station");
    expect(readiness.nvidiaPlatform).toBeUndefined();
  });

  it("rejects a device-tree line terminator in both consumers (#10928)", () => {
    const model = "NVIDIA DGX Station GB300\n";
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      model,
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      model,
    );

    expect(shell).toBe("not-station");
    expect(readiness.nvidiaPlatform).toBeUndefined();
  });

  it("blocks Station Express when exact GB300 PCI identity is absent (#10928)", () => {
    expect(
      detectWithInstallerWrapper("Generic ARM workstation", "NVIDIA DGX Station GB300", false),
    ).toBe("hardware=station-gb300-pci-missing\nplatform=Unverified DGX Station hardware\n");
  });

  it("rejects an oversized PCI scan before accepting a matching device (#10928)", () => {
    const shell = detectWithInstallerWrapper(
      "Generic ARM workstation",
      "NVIDIA DGX Station GB300",
      true,
      257,
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "NVIDIA DGX Station GB300",
      "Generic board",
      "",
      257,
    );

    expect(shell).toBe(
      "hardware=station-gb300-pci-missing\nplatform=Unverified DGX Station hardware\n",
    );
    expect(readiness.stationGb300PciGpu).toBeUndefined();
  });

  it.each(["0x03not-a-class", "0x030000extra"])(
    "rejects malformed PCI class %s in both hardware consumers (#10928)",
    (pciClass) => {
      const shell = detectWithInstallerWrapper(
        "Generic ARM workstation",
        "NVIDIA DGX Station GB300",
        true,
        1,
        pciClass,
      );
      const readiness = classifyFirmwareWithReadiness(
        "Generic ARM workstation",
        "NVIDIA DGX Station GB300",
        "Generic board",
        "",
        1,
        pciClass,
      );

      expect(shell).toBe(
        "hardware=station-gb300-pci-missing\nplatform=Unverified DGX Station hardware\n",
      );
      expect(readiness.stationGb300PciGpu).toBe(false);
    },
  );

  it.each([
    ["vendor", { vendor: "0x10de\0" }],
    ["device", { device: "0x31c2\0" }],
    ["class", { pciClass: "0x030000\0" }],
  ] as const)(
    "rejects a NUL-bearing PCI %s value before shell conversion (#10928)",
    (_field, pciValues) => {
      const shell = detectWithInstallerWrapper(
        "Generic ARM workstation",
        "NVIDIA DGX Station GB300",
        true,
        1,
        "0x030000",
        pciValues,
      );
      const readiness = classifyFirmwareWithReadiness(
        "Generic ARM workstation",
        "NVIDIA DGX Station GB300",
        "Generic board",
        "",
        1,
        "0x030000",
        pciValues,
      );

      expect(shell).toBe(
        "hardware=station-gb300-pci-missing\nplatform=Unverified DGX Station hardware\n",
      );
      expect(readiness.stationGb300PciGpu).toBeUndefined();
    },
  );

  it.each([
    ["an unsafe marker", noOta("7.7.0", "2026-07-30"), "1000|0|644|256"],
    [
      "a wrong-platform marker",
      noOta("7.7.0", "2026-07-30", 'DGX_PLATFORM="DGX Server for GALAXY-GB200"'),
      "0|0|644|256",
    ],
    [
      "a partial OTA marker",
      marker(
        'DGX_OTA_PRETTY_NAME="DGX OS"',
        'DGX_SWBUILD_DATE="2026-07-30"',
        'DGX_SWBUILD_VERSION="7.7.0"',
      ),
      "0|0|644|256",
    ],
    [
      "a duplicate-field marker",
      `${noOta("7.7.0", "2026-07-30")}DGX_PLATFORM="DGX Server for GALAXY-GB300"\n`,
      "0|0|644|256",
    ],
  ])("blocks forced host preparation for %s", (_scenario, release, markerMetadata) => {
    const result = runStationCheckPlatform(release, { force: true, markerMetadata });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).not.toBe(0);
    expect(output).toContain(
      "--force-station-install requires a trusted, complete DGX Station release marker",
    );
    expect(output).not.toContain("PROFILE=");
  });

  it("classifies a Spark family when the product name is generic (#10928)", () => {
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      "NVIDIA DGX Spark",
      "Generic board",
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "NVIDIA DGX Spark",
      "Generic board",
    );

    expect(shell).toBe("spark");
    expect(readiness.nvidiaPlatform).toBe("spark");
  });

  it("classifies another Station generation from the board field (#10928)", () => {
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      "Generic family",
      "NVIDIA DGX Station GB200",
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "Generic family",
      "NVIDIA DGX Station GB200",
    );

    expect(shell).toBe("station-other");
    expect(readiness.nvidiaPlatform).toBe("station");
    expect(readiness.stationFirmwareProduct).toBeUndefined();
  });

  it("rejects conflicting platform identities in both consumers (#10928)", () => {
    const shell = classifyFirmwareWithStationHelper(
      "NVIDIA DGX Spark",
      "NVIDIA DGX Station GB300",
      "Generic board",
    );
    const readiness = classifyFirmwareWithReadiness(
      "NVIDIA DGX Spark",
      "NVIDIA DGX Station GB300",
      "Generic board",
    );

    expect(shell).toBe("conflicting");
    expect(readiness).toMatchObject({ platformIdentityConflict: true });
    expect(readiness.nvidiaPlatform).toBeUndefined();
  });

  it("uses the device-tree model when DMI fields are generic (#10928)", () => {
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      "NVIDIA DGX Station GB300",
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      "NVIDIA DGX Station GB300",
    );

    expect(shell).toBe("station-gb300");
    expect(readiness).toMatchObject({
      nvidiaPlatform: "station",
      stationFirmwareProduct: "NVIDIA DGX Station GB300",
      deviceTreeModel: "NVIDIA DGX Station GB300",
    });
  });

  it("accepts one trailing device-tree NUL terminator in both consumers (#10928)", () => {
    const model = "NVIDIA DGX Station GB300\0";
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      model,
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      model,
    );

    expect(shell).toBe("station-gb300");
    expect(readiness).toMatchObject({
      nvidiaPlatform: "station",
      deviceTreeModel: "NVIDIA DGX Station GB300",
    });
  });

  it("rejects an embedded device-tree NUL in both consumers (#10928)", () => {
    const model = "NVIDIA DGX\0 Station GB300";
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      model,
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      model,
    );

    expect(shell).toBe("not-station");
    expect(readiness.nvidiaPlatform).toBeUndefined();
    expect(readiness.deviceTreeModel).toBeUndefined();
  });

  it("rejects a device-tree model that conflicts with Station DMI (#10928)", () => {
    const shell = classifyFirmwareWithStationHelper(
      "NVIDIA DGX Station GB300",
      "NVIDIA DGX Station GB300",
      "NVIDIA DGX Station GB300",
      "NVIDIA DGX Spark",
    );
    const readiness = classifyFirmwareWithReadiness(
      "NVIDIA DGX Station GB300",
      "NVIDIA DGX Station GB300",
      "NVIDIA DGX Station GB300",
      "NVIDIA DGX Spark",
    );

    expect(shell).toBe("conflicting");
    expect(readiness).toMatchObject({ platformIdentityConflict: true });
  });

  it("ignores an oversized device-tree model in both consumers (#10928)", () => {
    const model = "NVIDIA DGX Station GB300".padEnd(257, "x");
    const shell = classifyFirmwareWithStationHelper(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      model,
    );
    const readiness = classifyFirmwareWithReadiness(
      "Generic ARM workstation",
      "Generic family",
      "Generic board",
      model,
    );

    expect(shell).toBe("not-station");
    expect(readiness.nvidiaPlatform).toBeUndefined();
    expect(readiness.deviceTreeModel).toBeUndefined();
  });
});
