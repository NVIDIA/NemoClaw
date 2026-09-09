// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyNvidiaFirmwareProducts,
  hasDgxStationGb300PciGpu,
  readBoundedNvidiaFirmwareValue,
} from "../../src/lib/inference/dgx-station-identity";

const helper = path.resolve(import.meta.dirname, "../../scripts/prepare-dgx-station-host.sh");
const cases = [
  {
    name: "family identity",
    product: "Generic workstation",
    family: "Dell Pro Max with Station GB300",
    state: "station-gb300",
  },
  { name: "product identity", product: "Station GB300", state: "station-gb300" },
  { name: "board identity", board: "Station GB300", state: "station-gb300" },
  { name: "oversized firmware", family: "Station GB300".padEnd(257, " "), state: "not-station" },
  { name: "ASCII underscore", family: "Station_GB300", state: "station-gb300" },
  { name: "ASCII hyphen", family: "Station-GB300", state: "station-gb300" },
  { name: "non-ASCII separator", family: "Station\u00a0GB300", state: "not-station" },
  { name: "non-ASCII case folding", family: "\u017ftation GB300", state: "not-station" },
  {
    name: "conflicting firmware",
    product: "DGX Spark",
    family: "Station GB300",
    state: "conflicting",
  },
  { name: "embedded NUL", family: "Station\0 GB300", state: "not-station" },
  { name: "embedded newline", family: "Station\nGB300", state: "not-station" },
  { name: "device-tree terminator", tree: "Station GB300\0", state: "station-gb300" },
  { name: "repeated device-tree terminator", tree: "Station GB300\0\0", state: "not-station" },
  {
    name: "missing exact PCI identity",
    family: "Station GB300",
    device: "0x9999",
    state: "station-gb300-pci-missing",
    pci: false,
  },
  {
    name: "oversized PCI scan",
    family: "Station GB300",
    count: 257,
    state: "station-gb300-pci-missing",
    pci: undefined,
  },
] as const;

describe("Station hardware classifier parity", () => {
  it.each(cases)("handles $name through both production classifiers", (scenario) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-hardware-"));
    try {
      const fields = ["product_name", "product_family", "board_name", "model"];
      const values = [
        "product" in scenario ? scenario.product : "",
        "family" in scenario ? scenario.family : "",
        "board" in scenario ? scenario.board : "",
        "tree" in scenario ? scenario.tree : "",
      ];
      fields.forEach((field, index) => fs.writeFileSync(path.join(fixture, field), values[index]));
      const pciRoot = path.join(fixture, "pci");
      fs.mkdirSync(pciRoot);
      const device = path.join(pciRoot, "0000:00:00.0");
      fs.mkdirSync(device);
      fs.writeFileSync(path.join(device, "vendor"), "0x10de\n");
      fs.writeFileSync(
        path.join(device, "device"),
        ("device" in scenario ? scenario.device : "0x31c2") + "\n",
      );
      fs.writeFileSync(path.join(device, "class"), "0x030200\n");
      Array.from({ length: ("count" in scenario ? scenario.count : 1) - 1 }, (_, index) =>
        fs.mkdirSync(path.join(pciRoot, `extra-${index}`)),
      );
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `
source "$STATION_HELPER"
station_product_name_path() { printf '%s/product_name' "$FIXTURE"; }
station_product_family_path() { printf '%s/product_family' "$FIXTURE"; }
station_board_name_path() { printf '%s/board_name' "$FIXTURE"; }
station_device_tree_model_path() { printf '%s/model' "$FIXTURE"; }
station_pci_devices_path() { printf '%s/pci' "$FIXTURE"; }
main --classify-station-hardware
`,
        ],
        {
          encoding: "utf8",
          env: { HOME: fixture, PATH: process.env.PATH, STATION_HELPER: helper, FIXTURE: fixture },
          timeout: 15_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(scenario.state);
      const readFile = (file: string) => fs.readFileSync(file, "utf8");
      const identity = classifyNvidiaFirmwareProducts(
        fields.map((field) =>
          readBoundedNvidiaFirmwareValue(readFile, path.join(fixture, field), field === "model"),
        ),
      );
      expect(
        identity.platformIdentityConflict
          ? "conflicting"
          : (identity.firmwareClass ?? "not-station"),
      ).toBe(scenario.state === "station-gb300-pci-missing" ? "station-gb300" : scenario.state);
      expect(hasDgxStationGb300PciGpu(readFile, (dir) => fs.readdirSync(dir), pciRoot)).toBe(
        "pci" in scenario ? scenario.pci : true,
      );
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
