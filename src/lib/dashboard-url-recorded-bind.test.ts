// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const createdHomes: string[] = [];

/**
 * Point the real registry at a private state root. A forward launch records
 * the bind through `updateSandbox`; `dashboard-url` reads it back through
 * `getSandbox`. Nothing between them is mocked.
 */
async function isolatedRegistryHome(): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-dashboard-bind-"));
  createdHomes.push(home);
  vi.stubEnv("HOME", home);
  vi.resetModules();
}

describe("dashboard-url reads the bind a forward launch recorded in the registry (#10861)", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const home of createdHomes.splice(0)) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("discloses a persisted wide bind and withholds the SSH forward hint", async () => {
    await isolatedRegistryHome();
    const registry = await import("./state/registry");
    registry.registerSandbox({
      name: "alpha",
      agent: "openclaw",
      dashboardPort: 18792,
      gatewayName: "nemoclaw-8080",
      gatewayPort: 8080,
    });
    expect(registry.updateSandbox("alpha", { dashboardBindAddress: "0.0.0.0" })).toBe(true);
    const { runDashboardUrlCommand } = await import("./dashboard-url-command");
    const out: string[] = [];

    runDashboardUrlCommand(
      "alpha",
      { quiet: false },
      {
        fetchToken: () => "secret-token",
        getSandbox: registry.getSandbox,
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
        log: (message) => out.push(message),
        error: () => undefined,
      },
    );

    expect(out).toEqual([
      "  Dashboard URL:",
      "  http://127.0.0.1:18792/#token=secret-token",
      "  Bound on all interfaces (0.0.0.0:18792); other hosts may reach it at this host's address, subject to the host firewall.",
    ]);
  });
});
