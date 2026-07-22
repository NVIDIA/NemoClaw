// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MINIMUM_SAFE_NODE_TAR_VERSION,
  type NodeTarImageScan,
} from "../../../scripts/checks/node-tar-image-scan.mts";
import { assertExitZero, resultText } from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export const NODE_TAR_INVENTORY_PATH = "/usr/local/share/nemoclaw/node-tar-inventory.json";

function parseInventory(result: ShellProbeResult, label: string): NodeTarImageScan {
  assertExitZero(result, label);
  let inventory: NodeTarImageScan;
  try {
    inventory = JSON.parse(result.stdout) as NodeTarImageScan;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${String(error)}\n${resultText(result)}`);
  }
  expect(inventory).toMatchObject({
    minimumVersion: MINIMUM_SAFE_NODE_TAR_VERSION,
    schema: 1,
  });
  expect(inventory.packageCount).toBe(inventory.packages.length);
  expect(inventory.packageCount).toBeGreaterThan(0);
  return inventory;
}

export function assertLegacyNodeTarInventory(result: ShellProbeResult, label: string): void {
  const inventory = parseInventory(result, label);
  expect(inventory.image).toBe("build:openclaw-base-legacy-fixture");
  expect(inventory.packages.filter((entry) => entry.status !== "fixed")).toEqual([
    expect.objectContaining({
      physicalPath: "/usr/local/lib/node_modules/openclaw/node_modules/tar",
      status: "affected",
      version: "7.5.11",
    }),
  ]);
}

export function assertCurrentNodeTarInventory(result: ShellProbeResult, label: string): void {
  const inventory = parseInventory(result, label);
  expect(inventory.packages.every((entry) => entry.status === "fixed")).toBe(true);
}
