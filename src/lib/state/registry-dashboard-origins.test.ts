// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { listHostGatewayRegistryEntries } from "./gateway-registry";

const originalHome = process.env.HOME;
const temporaryHomes: string[] = [];

function writeRegistry(home: string, sandboxes: Record<string, unknown>): void {
  const configDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "sandboxes.json"),
    JSON.stringify({ defaultSandbox: null, sandboxes }),
    { mode: 0o600 },
  );
}

async function loadRegistry(sandboxes: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-origins-"));
  temporaryHomes.push(home);
  writeRegistry(home, sandboxes);
  process.env.HOME = home;
  vi.resetModules();
  return import("./registry");
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("registry dashboard origins (#13177)", () => {
  it("round-trips recorded dashboard origins", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({
      name: "proxied",
      dashboardPort: 18_789,
      dashboardOrigins: ["https://launchpad.example.test:8443"],
    });

    vi.resetModules();
    const reloaded = await import("./registry");
    expect(reloaded.getSandbox("proxied")?.dashboardOrigins).toEqual([
      "https://launchpad.example.test:8443",
    ]);
  });

  it("does not record an empty origin list", async () => {
    const registry = await loadRegistry();
    registry.registerSandbox({ name: "plain", dashboardPort: 18_789, dashboardOrigins: [] });

    expect(registry.getSandbox("plain")).not.toHaveProperty("dashboardOrigins");
  });

  it("rejects malformed recorded origins in the gateway index", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-index-origins-"));
    temporaryHomes.push(home);
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
            dashboardOrigins: ["http://launchpad.example.test:8443"],
          },
        },
      }),
    );

    expect(() => listHostGatewayRegistryEntries(home)).toThrow(/invalid dashboardOrigins/);
  });
});
