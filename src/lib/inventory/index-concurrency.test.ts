// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { getSandboxInventory, getStatusReport } from "./index";

function deferredPolicyReads() {
  const releases = new Map<string, (policies: string[]) => void>();
  const getPolicyPresets = vi.fn(
    (sandboxName: string) =>
      new Promise<string[]>((resolve) => {
        releases.set(sandboxName, resolve);
      }),
  );
  return { getPolicyPresets, releases };
}

describe("inventory policy read concurrency", () => {
  it("reads independent inventory policies concurrently while preserving sandbox order", async () => {
    const { getPolicyPresets, releases } = deferredPolicyReads();
    const pending = getSandboxInventory({
      recoverRegistryEntries: async () => ({
        sandboxes: [{ name: "alpha" }, { name: "beta" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      getPolicyPresets,
      loadLastSession: () => null,
    });

    await vi.waitFor(() => expect(getPolicyPresets).toHaveBeenCalledTimes(2));
    releases.get("beta")?.(["beta-policy"]);
    releases.get("alpha")?.(["alpha-policy"]);

    await expect(pending).resolves.toMatchObject({
      sandboxes: [
        { name: "alpha", policies: ["alpha-policy"] },
        { name: "beta", policies: ["beta-policy"] },
      ],
    });
  });

  it("reads independent status policies concurrently while preserving sandbox order", async () => {
    const { getPolicyPresets, releases } = deferredPolicyReads();
    const pending = getStatusReport({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha" }, { name: "beta" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      getPolicyPresets,
      showServiceStatus: vi.fn(),
    });

    await vi.waitFor(() => expect(getPolicyPresets).toHaveBeenCalledTimes(2));
    releases.get("beta")?.(["beta-policy"]);
    releases.get("alpha")?.(["alpha-policy"]);

    await expect(pending).resolves.toMatchObject({
      sandboxes: [
        { name: "alpha", policies: ["alpha-policy"] },
        { name: "beta", policies: ["beta-policy"] },
      ],
    });
  });
});
