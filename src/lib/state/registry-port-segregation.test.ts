// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const HOME = "/home/wiring";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function importRegistryFile(gatewayPort: string): Promise<string> {
  vi.resetModules();
  vi.stubEnv("HOME", HOME);
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", gatewayPort);
  const mod = await import("./registry");
  return mod.REGISTRY_FILE;
}

describe("registry path segregation by gateway port (#3053)", () => {
  it("keeps the default gateway port on the shared ~/.nemoclaw/sandboxes.json", async () => {
    const file = await importRegistryFile("");
    expect(file).toBe(path.join(HOME, ".nemoclaw", "sandboxes.json"));
  });

  it("segregates a non-default gateway port into its own registry", async () => {
    const file = await importRegistryFile("9123");
    expect(file).toBe(path.join(HOME, ".nemoclaw", "gateways", "9123", "sandboxes.json"));
  });

  it("gives two non-default ports non-colliding registries", async () => {
    const a = await importRegistryFile("9123");
    const b = await importRegistryFile("9124");
    expect(a).not.toBe(b);
    expect(b).toBe(path.join(HOME, ".nemoclaw", "gateways", "9124", "sandboxes.json"));
  });
});
