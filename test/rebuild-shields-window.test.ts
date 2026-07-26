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
import {
  openBackupShieldsWindow,
  relockBackupShieldsWindow,
} from "../src/lib/actions/sandbox/backup-shields-window";

describe("rebuild shields window", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("temporarily unlocks locked shields with a bounded auto-restore timer", () => {
    shieldsMock.isShieldsDown.mockReturnValue(false);

    const window = openRebuildShieldsWindow("locked-sandbox", "nemoclaw");

    expect(window).not.toBeNull();
    expect(window!.wasLocked).toBe(true);
    expect(shieldsMock.shieldsDown).toHaveBeenCalledWith("locked-sandbox", {
      reason: "auto-unlock for rebuild",
      timeout: "30m",
      throwOnError: true,
      deferAutoRestoreWhileOwnerAlive: true,
      allowLegacyHermesProtocol: true,
    });
  });

  it("keeps ordinary backup windows bounded without the rebuild legacy bypass (#6455)", () => {
    shieldsMock.isShieldsDown.mockReturnValue(false);
    const options = {
      operation: "backup-all",
      reason: "auto-unlock for backup-all",
      retryCommand: "nemoclaw backup-all",
      shieldsUpCommand: "nemoclaw locked-sandbox shields up",
    };

    const window = openBackupShieldsWindow("locked-sandbox", options);

    expect(window).not.toBeNull();
    expect(shieldsMock.shieldsDown).toHaveBeenCalledWith("locked-sandbox", {
      reason: "auto-unlock for backup-all",
      timeout: "30m",
      throwOnError: true,
    });

    expect(relockBackupShieldsWindow("locked-sandbox", window!, true, options)).toBe(true);
    expect(shieldsMock.shieldsUp).toHaveBeenCalledWith("locked-sandbox", {
      throwOnError: true,
    });
  });
  it("does not open a backup window when corrupt Shields state blocks unlock (#6455)", () => {
    shieldsMock.isShieldsDown.mockReturnValue(false);
    shieldsMock.shieldsDown.mockImplementation(() => {
      throw new Error("Shields state is corrupt for locked-sandbox");
    });
    const options = {
      operation: "backup-all",
      reason: "auto-unlock for backup-all",
      retryCommand: "nemoclaw backup-all",
      shieldsUpCommand: "nemoclaw locked-sandbox shields up",
    };

    expect(openBackupShieldsWindow("locked-sandbox", options)).toBeNull();
    expect(shieldsMock.shieldsUp).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Shields state is corrupt for locked-sandbox"),
    );
  });

  it("relocks a previously locked sandbox and records the closed window", () => {
    const window = { relocked: false, wasLocked: true };

    const relocked = relockRebuildShieldsWindow("locked-sandbox", window, true, "nemoclaw");

    expect(relocked).toBe(true);
    expect(window.relocked).toBe(true);
    expect(shieldsMock.shieldsUp).toHaveBeenCalledWith("locked-sandbox", {
      throwOnError: true,
      allowLegacyHermesProtocol: true,
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
    const recovery = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(recovery).toContain("nemoclaw locked-sandbox shields up");
    expect(recovery).toContain("nemoclaw locked-sandbox rebuild");
    expect(recovery.indexOf("shields up")).toBeLessThan(recovery.indexOf("rebuild"));
  });

  it("preserves the caller CLI name in missing-sandbox recovery guidance", () => {
    const window = { relocked: false, wasLocked: true };

    const relocked = relockRebuildShieldsWindow("deleted-sandbox", window, false, "nemo-dev");

    expect(relocked).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("nemo-dev deleted-sandbox shields up"),
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
