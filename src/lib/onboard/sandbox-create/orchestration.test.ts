// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import { completeHermesPortableSandboxRegistration } from "./orchestration";

describe("Hermes portable registration adapter", () => {
  it("returns the durable normalized registry entry after registration (#9211)", async () => {
    const events: string[] = [];
    const raw = { name: "alpha", dashboardPort: 0 } as SandboxEntry;
    const durable = { name: "alpha", dashboardPort: null } as SandboxEntry;
    const completeRegistration = vi.fn(async () => {
      events.push("complete");
      return raw;
    });
    const readRegistry = vi.fn(() => {
      events.push("read");
      return durable;
    });

    await expect(
      completeHermesPortableSandboxRegistration({
        sandboxName: "alpha",
        completeRegistration,
        readRegistry,
      }),
    ).resolves.toBe(durable);
    expect(completeRegistration).toHaveBeenCalledOnce();
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(events).toEqual(["complete", "read"]);
  });

  it("rejects a missing durable registry entry after registration (#9211)", async () => {
    const completeRegistration = vi.fn(async () => undefined);
    const readRegistry = vi.fn(() => null);

    await expect(
      completeHermesPortableSandboxRegistration({
        sandboxName: "alpha",
        completeRegistration,
        readRegistry,
      }),
    ).rejects.toThrow("Hermes portable sandbox registration returned no authority");
    expect(completeRegistration).toHaveBeenCalledOnce();
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
  });
});
