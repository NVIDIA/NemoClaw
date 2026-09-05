// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveDiscoveryCandidates,
  parseStationDiscoveryHost,
} from "../../scripts/lib/dgx-station-peer.mts";
import { STATION_DISCOVERY_PROBE } from "../../scripts/prepare-dual-dgx-station.mts";
import { TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

function executeDiscoveryProbe(stationPci: boolean) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-producer-"));
  const dmiRoot = path.join(fixtureRoot, "dmi");
  const modelPath = path.join(fixtureRoot, "model");
  const pciRoot = path.join(fixtureRoot, "pci");
  const pciDevice = path.join(pciRoot, "0000:01:00.0");
  fs.mkdirSync(dmiRoot, { recursive: true });
  fs.mkdirSync(pciDevice, { recursive: true });
  fs.writeFileSync(path.join(dmiRoot, "product_name"), "Generic ARM workstation\n");
  fs.writeFileSync(path.join(dmiRoot, "product_family"), "NVIDIA DGX Station GB300\n");
  fs.writeFileSync(path.join(dmiRoot, "board_name"), "Generic board\n");
  fs.writeFileSync(modelPath, "Generic device tree\0");
  fs.writeFileSync(path.join(pciDevice, "vendor"), "0x10de\n");
  fs.writeFileSync(path.join(pciDevice, "device"), stationPci ? "0x31c2\n" : "0xffff\n");
  fs.writeFileSync(path.join(pciDevice, "class"), "0x030000\n");
  const identityCall = `**station_identity_payload(dmi_root=${JSON.stringify(dmiRoot)}, device_tree_model_path=${JSON.stringify(modelPath)}, pci_devices_path=${JSON.stringify(pciRoot)}),`;
  const script = STATION_DISCOVERY_PROBE.replace(
    "**station_identity_payload(),",
    identityCall,
  ).replace(
    "\nprint(json.dumps({\n",
    `
def gpu_inventory():
    return [{"index": 0, "name": "NVIDIA GB300", "uuid": "GPU-LOCAL-0001"}]

def rail_inventory():
    return [
        {"netdev": "enp1s0f0np0", "macAddress": "02:00:00:00:00:01", "pciAddress": "0000:01:00.0", "pciName": "NVIDIA ConnectX-8 Ethernet Controller", "state": "4: ACTIVE", "linkLayer": "Ethernet", "speedMbps": 400000, "mtu": 9000, "ipv4Addresses": [{"address": "10.10.0.1", "prefixLength": 30}]},
        {"netdev": "enp2s0f0np0", "macAddress": "02:00:00:00:00:05", "pciAddress": "0000:02:00.0", "pciName": "NVIDIA ConnectX-8 Ethernet Controller", "state": "4: ACTIVE", "linkLayer": "Ethernet", "speedMbps": 400000, "mtu": 9000, "ipv4Addresses": [{"address": "10.10.0.5", "prefixLength": 30}]},
    ]

platform.machine = lambda: "aarch64"

print(json.dumps({
`,
  );
  try {
    const executed = spawnSync("python3", ["-"], {
      encoding: "utf8",
      env: { ...process.env, PATH: TEST_SYSTEM_PATH },
      input: script,
      timeout: 20_000,
    });
    expect(executed.status, executed.stderr).toBe(0);
    return parseStationDiscoveryHost(JSON.parse(executed.stdout));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("dual-Station discovery probe identity", () => {
  it("emits family-only Station and exact PCI evidence for selection (#10928)", () => {
    const observed = executeDiscoveryProbe(true);

    expect(observed).toMatchObject({
      schemaVersion: 2,
      productName: "Generic ARM workstation",
      productFamily: "NVIDIA DGX Station GB300",
      boardName: "Generic board",
      deviceTreeModel: "Generic device tree",
      stationGb300PciGpu: true,
    });
    expect(deriveDiscoveryCandidates(observed)).toEqual(["10.10.0.2", "10.10.0.6"]);
  });

  it("blocks selection when the probe cannot prove exact GB300 PCI identity (#10928)", () => {
    expect(() => deriveDiscoveryCandidates(executeDiscoveryProbe(false))).toThrow(
      /not a verified arm64 DGX Station GB300/,
    );
  });
});
