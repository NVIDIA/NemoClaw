// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listHostGatewayRegistryEntries } from "./gateway-registry";

describe("host gateway registry index", () => {
  it.runIf(process.platform !== "win32")(
    "rejects a symlinked numeric gateway root instead of omitting its allocations",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-index-home-"));
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-index-target-"));
      try {
        const gateways = path.join(home, ".nemoclaw", "gateways");
        fs.mkdirSync(gateways, { recursive: true });
        fs.symlinkSync(target, path.join(gateways, "9123"), "dir");

        expect(() => listHostGatewayRegistryEntries(home)).toThrow(/not a real directory/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
      }
    },
  );

  it("rejects malformed sibling registries so allocation fails closed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-index-malformed-"));
    try {
      const root = path.join(home, ".nemoclaw", "gateways", "9123");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "sandboxes.json"), "[]");

      expect(() => listHostGatewayRegistryEntries(home)).toThrow(
        /does not contain a sandbox registry/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects malformed persisted dashboard ports instead of treating them as free", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-index-port-"));
    try {
      const root = path.join(home, ".nemoclaw", "gateways", "9123");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "instance-a",
          sandboxes: {
            "instance-a": {
              name: "instance-a",
              gatewayName: "nemoclaw-9123",
              gatewayPort: 9123,
              dashboardPort: "18789",
            },
          },
        }),
      );

      expect(() => listHostGatewayRegistryEntries(home)).toThrow(/invalid dashboardPort/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats a zero persisted dashboard port as no dashboard instead of blocking the registry (#7020)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-index-zero-port-"));
    try {
      const root = path.join(home, ".nemoclaw", "gateways", "9123");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "instance-a",
          sandboxes: {
            "instance-a": {
              name: "instance-a",
              gatewayName: "nemoclaw-9123",
              gatewayPort: 9123,
              dashboardPort: 0,
            },
          },
        }),
      );

      const entries = listHostGatewayRegistryEntries(home);

      expect(entries).toHaveLength(1);
      expect(entries[0].entry.name).toBe("instance-a");
      expect(entries[0].entry.dashboardPort).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects sandbox names that could escape a gateway-owned snapshot directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-index-name-"));
    try {
      const root = path.join(home, ".nemoclaw", "gateways", "9123");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "../outside",
          sandboxes: {
            "../outside": {
              name: "../outside",
              gatewayName: "nemoclaw-9123",
              gatewayPort: 9123,
            },
          },
        }),
      );

      expect(() => listHostGatewayRegistryEntries(home)).toThrow(/invalid sandbox row/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
