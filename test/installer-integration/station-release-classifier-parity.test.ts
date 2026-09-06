// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectPlatformIdentity,
  type StationProfile,
} from "../../src/lib/readiness/platform-qualification";
import { TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const PLATFORM = 'DGX_PLATFORM="DGX Server for GALAXY-GB300"';

function marker(...lines: string[]): string {
  return [
    'DGX_NAME="DGX GB300WS"',
    'DGX_PRETTY_NAME="NVIDIA DGX GB300 Workstation"',
    ...lines,
    PLATFORM,
    "",
  ].join("\n");
}

function noOta(version: string, buildDate: string, platform = PLATFORM): string {
  return marker(`DGX_SWBUILD_DATE="${buildDate}"`, `DGX_SWBUILD_VERSION="${version}"`).replace(
    PLATFORM,
    platform,
  );
}

function ota(otaPrettyName = ""): string {
  return marker(
    otaPrettyName,
    'DGX_OTA_VERSION="7.5.0"',
    'DGX_OTA_DATE="Mon Jul 13 21:29:13 UTC 2026"',
  );
}

function classifyWithShell(release: string): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-release-"));
  const releasePath = path.join(fixture, "dgx-release");
  fs.writeFileSync(releasePath, release);
  try {
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
          HOME: fixture,
          PATH: TEST_SYSTEM_PATH,
          STATION_PREPARE,
          DGX_RELEASE: releasePath,
        },
        timeout: 15_000,
      },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout;
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function classifyWithReadiness(release: string): StationProfile | null | undefined {
  const values = new Map([
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
    readFile: (filePath) => values.get(path.basename(filePath)) ?? "",
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

describe("DGX Station release classifier parity", () => {
  it.each([
    ["OTA-upgraded DGX OS", "supported-dgx-os", ota()],
    ["stock no-OTA DGX OS", "supported-dgx-os", noOta("7.6.0", "2026-07-30-10-25-15")],
    [
      "Colossus BaseOS with changed display text",
      "supported-colossus-baseos",
      noOta("7.5.0-GB300ws-GB200ws", "2026-04-02-08-20-16"),
    ],
    [
      "AI Developer Tools with changed display text",
      "supported-ai-developer-tools",
      noOta("7.5.0", "2026-06-16-11-48-10"),
    ],
    ["future no-OTA release", "unsupported-dgx-os", noOta("7.7.0", "2026-07-30")],
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
  ] as const)("classifies %s as %s in both consumers", (_scenario, expected, release) => {
    expect(classifyWithReadiness(release)).toBe(expected);
    expect(classifyWithShell(release)).toBe(expected);
  });
});
