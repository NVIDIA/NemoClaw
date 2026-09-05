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
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const DISPLAY_NAME = 'DGX_PRETTY_NAME="NVIDIA DGX GB300 Workstation"';
const PLATFORM = 'DGX_PLATFORM="DGX Server for GALAXY-GB300"';
const fixtureDirectories: string[] = [];

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
): string {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-firmware-"));
  fixtureDirectories.push(fixtureDirectory);
  for (const [name, value] of [
    ["product_name", productName],
    ["product_family", productFamily],
    ["board_name", boardName],
  ]) {
    fs.writeFileSync(path.join(fixtureDirectory, name), `${value}\n`);
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
station_device_tree_model_path() { printf '%s' "$FIXTURE/absent-model"; }
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
) {
  const values = new Map([
    ["product_name", productName],
    ["product_family", productFamily],
    ["board_name", boardName],
    ["vendor", "0x10de"],
    ["device", "0x31c2"],
    ["class", "0x030000"],
  ]);
  return collectPlatformIdentity({
    productNamePath: "/fixture/product_name",
    productFamilyPath: "/fixture/product_family",
    boardNamePath: "/fixture/board_name",
    stationReleasePath: "/fixture/absent-release",
    pciDevicesPath: "/fixture/pci",
    readFile: (filePath) => values.get(path.basename(filePath)) ?? "",
    readdir: () => ["0000:01:00.0"],
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
});
