// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shieldsMock = vi.hoisted(() => ({
  isShieldsDown: vi.fn(),
  shieldsDown: vi.fn(),
  shieldsUp: vi.fn(),
}));
const timerMock = vi.hoisted(() => ({ isShieldsTimerDeadlineExpired: vi.fn() }));

vi.mock("../../../src/lib/shields", () => shieldsMock);
vi.mock("../../../src/lib/state/mcp-lifecycle-lock/shields-timer-authority", () => timerMock);

import {
  openBackupShieldsWindow,
  relockBackupShieldsWindow,
} from "../../../src/lib/actions/sandbox/backup-shields-window";
import {
  openRebuildShieldsWindow,
  relockRebuildShieldsWindow,
} from "../../../src/lib/actions/sandbox/rebuild-shields";

describe("rebuild Shields window", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    timerMock.isShieldsTimerDeadlineExpired.mockReturnValue(false);
    shieldsMock.shieldsDown.mockReturnValue({
      sandboxName: "locked-sandbox",
      processToken: "a".repeat(32),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("applies bounded Shields down for a rebuild backup (#3113)", () => {
    shieldsMock.isShieldsDown.mockReturnValue(false);

    const window = openRebuildShieldsWindow("locked-sandbox", "nemoclaw");

    expect(window).not.toBeNull();
    expect(window!.wasLocked).toBe(true);
    expect(shieldsMock.shieldsDown).toHaveBeenCalledWith("locked-sandbox", {
      reason: "auto-unlock for rebuild",
      timeout: "30m",
      throwOnError: true,
      issuePolicySnapshotRecovery: true,
      deferAutoRestoreWhileOwnerAlive: true,
      allowLegacyHermesProtocol: true,
    });
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Shields are UP");
    expect(output).toContain("temporarily unlocking for rebuild backup");
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
      issuePolicySnapshotRecovery: true,
    });

    expect(relockBackupShieldsWindow("locked-sandbox", window!, true, options)).toBe(true);
    expect(shieldsMock.shieldsUp).toHaveBeenCalledWith(
      "locked-sandbox",
      expect.objectContaining({
        policySnapshotRecovery: {
          sandboxName: "locked-sandbox",
          processToken: "a".repeat(32),
        },
        throwOnError: true,
      }),
    );
  });

  it("restores a preserved restrictive policy before backup-all relocks (#9452)", () => {
    shieldsMock.isShieldsDown.mockReturnValue(false);
    const options = {
      operation: "backup-all",
      reason: "auto-unlock for backup-all",
      retryCommand: "nemoclaw backup-all",
      shieldsUpCommand: "nemoclaw locked-sandbox shields up",
    };

    const window = openBackupShieldsWindow("locked-sandbox", options);
    const recovery = window!.policySnapshotRecovery;

    expect(relockBackupShieldsWindow("locked-sandbox", window!, true, options)).toBe(true);
    expect(shieldsMock.shieldsUp).toHaveBeenCalledWith(
      "locked-sandbox",
      expect.objectContaining({ policySnapshotRecovery: recovery }),
    );
    expect(window!.policySnapshotRecovery).toBeUndefined();
  });

  it("does not suggest an impossible shields-up retry when preserved policy recovery fails (#9452)", () => {
    shieldsMock.isShieldsDown.mockReturnValue(false);
    shieldsMock.shieldsUp.mockImplementation(() => {
      throw new Error(
        "Backup Shields policy recovery failed: restrictive snapshot path was replaced",
      );
    });
    const options = {
      operation: "backup-all",
      reason: "auto-unlock for backup-all",
      retryCommand: "nemoclaw backup-all",
      shieldsUpCommand: "nemoclaw locked-sandbox shields up",
    };
    const window = openBackupShieldsWindow("locked-sandbox", options);

    expect(relockBackupShieldsWindow("locked-sandbox", window!, true, options)).toBe(false);
    expect(shieldsMock.shieldsUp).toHaveBeenCalledOnce();
    expect(window!.policySnapshotRecovery).toBeUndefined();
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).toContain("Do not retry Shields up from the mutable live policy");
    expect(output).not.toContain("then run `nemoclaw locked-sandbox shields up`");
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

  it("does not apply Shields down when the sandbox is already mutable", () => {
    shieldsMock.isShieldsDown.mockReturnValue(true);

    const window = openRebuildShieldsWindow("mutable-sandbox", "nemoclaw");

    expect(window).not.toBeNull();
    expect(window!.wasLocked).toBe(false);
    expect(shieldsMock.shieldsDown).not.toHaveBeenCalled();
    expect(relockRebuildShieldsWindow("mutable-sandbox", window!, true, "nemoclaw")).toBe(true);
    expect(shieldsMock.shieldsUp).not.toHaveBeenCalled();
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();

    timerMock.isShieldsTimerDeadlineExpired.mockReturnValue(true);
    expect(
      relockBackupShieldsWindow("mutable-sandbox", window!, true, {
        operation: "backup-all",
        reason: "backup",
        retryCommand: "nemoclaw backup-all",
        shieldsUpCommand: "nemoclaw mutable-sandbox shields up",
      }),
    ).toBe(true);
    expect(shieldsMock.shieldsUp).not.toHaveBeenCalled();
  });

  it("settles an elapsed Shields timer before rebuild returns (#8697)", () => {
    timerMock.isShieldsTimerDeadlineExpired.mockReturnValue(true);
    const window = { relocked: false, wasLocked: false };

    expect(relockRebuildShieldsWindow("mutable-sandbox", window, true, "nemoclaw")).toBe(true);
    expect(shieldsMock.shieldsUp).toHaveBeenCalledOnce();
    expect(window.relocked).toBe(true);
  });
});
