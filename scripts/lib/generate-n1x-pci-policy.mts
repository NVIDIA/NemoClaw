// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "bin/lib/n1x-pci-policy.json"), "utf8"),
) as {
  schemaVersion: number;
  documentedDeviceIds: string[];
  prototypeDeviceIds: string[];
};
const devices = [...policy.documentedDeviceIds, ...policy.prototypeDeviceIds];
if (
  policy.schemaVersion !== 1 ||
  devices.length === 0 ||
  devices.length > 256 ||
  new Set(devices).size !== devices.length ||
  devices.some((device) => !/^0x[0-9a-f]{4}$/u.test(device))
) {
  throw new Error("Invalid N1x PCI device policy");
}
const installerPath = path.join(root, "scripts/install.sh");
const installer = fs.readFileSync(installerPath, "utf8");
const begin = "# n1x-pci-policy:begin";
const end = "# n1x-pci-policy:end";
const beginOffset = installer.indexOf(begin);
const endOffset = installer.indexOf(end, beginOffset);
if (beginOffset < 0 || endOffset < 0) throw new Error("Missing N1x policy generation markers");
const generated = `${begin}
n1x_pci_device_is_known() {
  case "\${1:-}" in
    ${devices.join(" | ")}) return 0 ;;
  esac
  return 1
}
${end}`;
const updated =
  installer.slice(0, beginOffset) + generated + installer.slice(endOffset + end.length);
fs.writeFileSync(installerPath, updated);
