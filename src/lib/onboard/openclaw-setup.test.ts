// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createOpenclawSetup, reconcileOpenClawWebSearchForReuse } from "./openclaw-setup";

describe("OpenClaw sandbox setup", () => {
  it("delegates config sync before web-search reconciliation", async () => {
    const syncNemoClawConfigInSandbox = vi.fn();
    const reconcileWebSearch = vi.fn(async () => undefined);
    const revalidatePolicyRequirements = vi.fn();
    const setup = createOpenclawSetup({
      step: vi.fn(),
      agentProductName: () => "OpenClaw",
      syncNemoClawConfigInSandbox,
      reconcileWebSearch,
    });

    await setup("spark-box", "model", "provider", null, revalidatePolicyRequirements);

    expect(syncNemoClawConfigInSandbox).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      "provider",
      "model",
      revalidatePolicyRequirements,
    );
    expect(reconcileWebSearch).toHaveBeenCalledExactlyOnceWith(
      "spark-box",
      null,
      revalidatePolicyRequirements,
    );
    expect(syncNemoClawConfigInSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileWebSearch.mock.invocationCallOrder[0]!,
    );
  });

  it("withholds setup success when policy authority changes during config sync (#9833)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reconcileWebSearch = vi.fn(async () => undefined);
    try {
      const setup = createOpenclawSetup({
        step: vi.fn(),
        agentProductName: () => "OpenClaw",
        syncNemoClawConfigInSandbox: () => {
          throw new Error("policy authority changed");
        },
        reconcileWebSearch,
      });

      await expect(setup("spark-box", "model", "provider", null)).rejects.toThrow(
        "policy authority changed",
      );

      expect(reconcileWebSearch).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join("\n")).not.toContain("gateway launched");
    } finally {
      log.mockRestore();
    }
  });
});

describe("fresh OpenClaw reuse web search reconciliation", () => {
  it("disables stale live web search when fresh re-onboard selects disabled (#10404)", async () => {
    const disable = vi.fn(async () => undefined);

    await reconcileOpenClawWebSearchForReuse("alpha", null, undefined, {
      readEnabled: () => true,
      disable,
    });

    expect(disable).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("leaves an already-disabled live config unchanged (#10404)", async () => {
    const disable = vi.fn(async () => undefined);

    await reconcileOpenClawWebSearchForReuse("alpha", null, undefined, {
      readEnabled: () => false,
      disable,
    });

    expect(disable).not.toHaveBeenCalled();
  });

  it("leaves a config without a stale enabled flag unchanged (#10404)", async () => {
    const disable = vi.fn(async () => undefined);

    await reconcileOpenClawWebSearchForReuse("alpha", null, undefined, {
      readEnabled: () => undefined,
      disable,
    });

    expect(disable).not.toHaveBeenCalled();
  });

  it("does not disable the live config when web search remains selected (#10404)", async () => {
    const readEnabled = vi.fn(() => true);
    const disable = vi.fn(async () => undefined);

    await reconcileOpenClawWebSearchForReuse(
      "alpha",
      { fetchEnabled: true },
      undefined,
      { readEnabled, disable },
    );

    expect(readEnabled).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });

  it("does not mutate when policy authority changes after the live-config read (#10404)", async () => {
    const readEnabled = vi.fn(() => true);
    const disable = vi.fn(async () => undefined);
    const revalidatePolicyRequirements = vi.fn(() => {
      throw new Error("policy authority changed");
    });

    await expect(
      reconcileOpenClawWebSearchForReuse("alpha", null, revalidatePolicyRequirements, {
        readEnabled,
        disable,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(readEnabled).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(revalidatePolicyRequirements).toHaveBeenCalledExactlyOnceWith(
      "disable OpenClaw web search in sandbox 'alpha'",
    );
    expect(disable).not.toHaveBeenCalled();
  });
});
