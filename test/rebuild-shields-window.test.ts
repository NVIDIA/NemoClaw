// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const shieldsMock = vi.hoisted(() => ({
  isShieldsDown: vi.fn(),
  shieldsDown: vi.fn(),
  shieldsUp: vi.fn(),
}));

vi.mock("../src/lib/shields", () => shieldsMock);

import {
  openRebuildShieldsWindow,
  relockRebuildShieldsWindow,
} from "../src/lib/actions/sandbox/rebuild-shields";

describe("rebuild shields window", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("temporarily unlocks locked shields without starting an auto-restore timer", () => {
    shieldsMock.isShieldsDown.mockReturnValue(false);

    const window = openRebuildShieldsWindow("locked-sandbox", "nemoclaw");

    expect(window).not.toBeNull();
    expect(window!.wasLocked).toBe(true);
    expect(shieldsMock.shieldsDown).toHaveBeenCalledWith("locked-sandbox", {
      reason: "auto-unlock for rebuild",
      skipTimer: true,
      throwOnError: true,
    });
  });

  it("relocks a previously locked sandbox and records the closed window", () => {
    const window = { relocked: false, wasLocked: true };

    const relocked = relockRebuildShieldsWindow("locked-sandbox", window, true, "nemoclaw");

    expect(relocked).toBe(true);
    expect(window.relocked).toBe(true);
    expect(shieldsMock.shieldsUp).toHaveBeenCalledWith("locked-sandbox", {
      throwOnError: true,
    });

    expect(relockRebuildShieldsWindow("locked-sandbox", window, true, "nemoclaw")).toBe(true);
    expect(shieldsMock.shieldsUp).toHaveBeenCalledTimes(1);
  });

  it("reports relock failure so rebuild can fail closed", () => {
    const window = { relocked: false, wasLocked: true };
    shieldsMock.shieldsUp.mockImplementation(() => {
      throw new Error("cannot lock config");
    });

    const relocked = relockRebuildShieldsWindow("locked-sandbox", window, true, "nemoclaw");

    expect(relocked).toBe(false);
    expect(window.relocked).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to re-apply shields lockdown"),
    );
  });

  it("does nothing when shields were already mutable", () => {
    shieldsMock.isShieldsDown.mockReturnValue(true);

    const window = openRebuildShieldsWindow("mutable-sandbox", "nemoclaw");

    expect(window).not.toBeNull();
    expect(window!.wasLocked).toBe(false);
    expect(shieldsMock.shieldsDown).not.toHaveBeenCalled();
    expect(relockRebuildShieldsWindow("mutable-sandbox", window!, true, "nemoclaw")).toBe(true);
    expect(shieldsMock.shieldsUp).not.toHaveBeenCalled();
  });
});
