// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getSandboxInventory, renderSandboxInventoryText } from "./index";

async function renderedListFor(sandbox: Record<string, unknown>): Promise<string> {
  const inventory = await getSandboxInventory({
    recoverRegistryEntries: async () => ({
      sandboxes: [{ name: "alpha", model: null, provider: null, dashboardPort: 18792, ...sandbox }],
      defaultSandbox: null,
      recoveredFromSession: false,
      recoveredFromGateway: 0,
    }),
    getLiveInference: () => null,
    loadLastSession: () => null,
  });
  const lines: string[] = [];
  renderSandboxInventoryText(inventory, (message = "") => lines.push(message), null);
  return lines.join("\n");
}

describe("the dashboard line in list follows the recorded bind (#10861)", () => {
  it("says when the dashboard forward is bound on all interfaces", async () => {
    const body = await renderedListFor({ dashboardBindAddress: "0.0.0.0" });

    expect(body).toContain("dashboard: http://127.0.0.1:18792/  (bound on all interfaces)");
  });

  it("prints the plain loopback URL for a recorded loopback bind", async () => {
    const body = await renderedListFor({ dashboardBindAddress: "127.0.0.1" });

    expect(body).toContain("dashboard: http://127.0.0.1:18792/");
    expect(body).not.toContain("bound on all interfaces");
    expect(body).not.toContain("bind not recorded");
  });

  it("says the bind is not recorded for a row that has none", async () => {
    const body = await renderedListFor({});

    expect(body).toContain("dashboard: http://127.0.0.1:18792/  (bind not recorded)");
    expect(body).not.toContain("bound on all interfaces");
  });
});
