// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as sandboxState from "../state/sandbox";
import {
  applyNonInteractiveNotReadyDecision,
  decideNonInteractiveNotReadyAction,
  installerRestoreOnRecreateFromEnv,
  NotReadySandboxError,
  resolveNotReadyOutcome,
  selectPreUpgradeBackupForCreate,
  UnsafeCustomImagePluginBackupError,
} from "./not-ready-recreate";

const BACKUP_PATH = "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-07-01T06-50-40-925Z";

describe("decideNonInteractiveNotReadyAction", () => {
  it("returns exit when installer restore intent is unset", () => {
    expect(
      decideNonInteractiveNotReadyAction({
        sandboxName: "my-assistant",
        installerRestoreOnRecreate: false,
        latestBackupPath: BACKUP_PATH,
      }),
    ).toEqual({ kind: "exit" });
  });

  it("returns recreate with the pre-upgrade backup path when installer intent and a backup are present", () => {
    expect(
      decideNonInteractiveNotReadyAction({
        sandboxName: "my-assistant",
        installerRestoreOnRecreate: true,
        latestBackupPath: BACKUP_PATH,
      }),
    ).toMatchObject({
      kind: "recreate",
      restoreBackupPath: BACKUP_PATH,
      note: expect.stringMatching(/my-assistant.*recreating and restoring pre-upgrade backup/),
    });
  });

  it("returns recreate without a backup when installer intent is set but no backup exists", () => {
    expect(
      decideNonInteractiveNotReadyAction({
        sandboxName: "preserve-oc",
        installerRestoreOnRecreate: true,
        latestBackupPath: null,
      }),
    ).toMatchObject({
      kind: "recreate",
      restoreBackupPath: null,
      note: expect.stringMatching(/preserve-oc.*no pre-upgrade backup found/),
    });
  });
});

describe("selectPreUpgradeBackupForCreate", () => {
  const note = vi.fn();
  let getLatestBackupSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    note.mockReset();
    getLatestBackupSpy = vi.spyOn(sandboxState, "getLatestBackup");
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  afterEach(() => {
    getLatestBackupSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  it("returns null when the sandbox still exists live in the gateway", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    expect(
      selectPreUpgradeBackupForCreate({
        liveExists: true,
        hasExistingRegistryEntry: true,
        sandboxName: "my-assistant",
        note,
      }),
    ).toBeNull();
    expect(getLatestBackupSpy).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringMatching(/gateway reports sandbox live/));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns null when there is no pre-existing registry entry", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    expect(
      selectPreUpgradeBackupForCreate({
        liveExists: false,
        hasExistingRegistryEntry: false,
        sandboxName: "my-assistant",
        note,
      }),
    ).toBeNull();
    expect(getLatestBackupSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(expect.stringMatching(/No registry entry/));
  });

  it("returns null and does not look up backups when installer restore intent is unset", () => {
    expect(
      selectPreUpgradeBackupForCreate({
        liveExists: false,
        hasExistingRegistryEntry: true,
        sandboxName: "my-assistant",
        note,
      }),
    ).toBeNull();
    expect(getLatestBackupSpy).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/installer restore flag not set/));
  });

  it("returns the latest backup path and notes it when installer restore intent finds a backup", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      backupPath: BACKUP_PATH,
    } as unknown as ReturnType<typeof sandboxState.getLatestBackup>);
    expect(
      selectPreUpgradeBackupForCreate({
        liveExists: false,
        hasExistingRegistryEntry: true,
        sandboxName: "my-assistant",
        note,
      }),
    ).toBe(BACKUP_PATH);
    expect(note).toHaveBeenCalledWith(
      expect.stringMatching(/Found pre-upgrade backup for 'my-assistant'/),
    );
  });

  it("blocks a legacy custom OpenClaw backup before installer recreation (#6108)", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      agentType: "openclaw",
      dir: "/sandbox/.openclaw",
      backupPath: BACKUP_PATH,
      openclawImagePluginInstalls: [],
    } as unknown as ReturnType<typeof sandboxState.getLatestBackup>);

    expect(() =>
      selectPreUpgradeBackupForCreate({
        liveExists: false,
        hasExistingRegistryEntry: true,
        existingSandboxEntry: {
          name: "my-assistant",
          agent: "openclaw",
          fromDockerfile: "/tmp/Dockerfile.custom",
        },
        sandboxName: "my-assistant",
        note,
      }),
    ).toThrow(UnsafeCustomImagePluginBackupError);

    expect(note).not.toHaveBeenCalled();
  });

  it("accepts an authoritative custom OpenClaw backup for installer recreation (#6108)", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      agentType: "openclaw",
      dir: "/sandbox/.openclaw",
      backupPath: BACKUP_PATH,
      reconcileOpenClawImagePluginProvenance: true,
      openclawImagePluginInstalls: [],
    } as unknown as ReturnType<typeof sandboxState.getLatestBackup>);

    expect(
      selectPreUpgradeBackupForCreate({
        liveExists: false,
        hasExistingRegistryEntry: true,
        existingSandboxEntry: {
          name: "my-assistant",
          agent: "openclaw",
          fromDockerfile: "/tmp/Dockerfile.custom",
        },
        sandboxName: "my-assistant",
        note,
      }),
    ).toBe(BACKUP_PATH);
  });

  it("blocks custom OpenClaw installer recreation when no valid backup is readable (#6108)", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue(null);

    expect(() =>
      selectPreUpgradeBackupForCreate({
        liveExists: false,
        hasExistingRegistryEntry: true,
        existingSandboxEntry: {
          name: "my-assistant",
          agent: "openclaw",
          fromDockerfile: "/tmp/Dockerfile.custom",
        },
        sandboxName: "my-assistant",
        note,
      }),
    ).toThrow(UnsafeCustomImagePluginBackupError);

    expect(note).not.toHaveBeenCalled();
  });

  it("returns null and notes fresh-state recreate when installer restore intent finds no backup", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue(null);
    expect(
      selectPreUpgradeBackupForCreate({
        liveExists: false,
        hasExistingRegistryEntry: true,
        sandboxName: "preserve-oc",
        note,
      }),
    ).toBeNull();
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/No pre-upgrade backup found/));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/installer requested restore but no pre-upgrade backup found/i),
    );
  });
});

describe("applyNonInteractiveNotReadyDecision", () => {
  const note = vi.fn();
  let getLatestBackupSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    note.mockReset();
    getLatestBackupSpy = vi.spyOn(sandboxState, "getLatestBackup");
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  afterEach(() => {
    getLatestBackupSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  it("throws NotReadySandboxError with the recreate-flag hint when installer restore intent is unset", () => {
    let thrown: unknown;
    try {
      applyNonInteractiveNotReadyDecision("my-assistant", note);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotReadySandboxError);
    const hints = (thrown as NotReadySandboxError).hints.join("\n");
    expect(hints).toMatch(/Sandbox 'my-assistant' already exists but is not ready/);
    expect(hints).toMatch(/Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1/);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(getLatestBackupSpy).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("returns the pre-upgrade backup path and notes the restore when installer intent finds a backup", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      backupPath: BACKUP_PATH,
    } as unknown as ReturnType<typeof sandboxState.getLatestBackup>);
    expect(applyNonInteractiveNotReadyDecision("my-assistant", note)).toBe(BACKUP_PATH);
    expect(note).toHaveBeenCalledWith(
      expect.stringMatching(/recreating and restoring pre-upgrade backup/),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("returns null and notes the fresh-state recreate when installer intent finds no backup", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue(null);
    expect(applyNonInteractiveNotReadyDecision("preserve-oc", note)).toBeNull();
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/no pre-upgrade backup found/));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/installer requested restore but no pre-upgrade backup found/i),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("resolveNotReadyOutcome", () => {
  const note = vi.fn();
  let getLatestBackupSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    note.mockReset();
    getLatestBackupSpy = vi.spyOn(sandboxState, "getLatestBackup");
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  afterEach(() => {
    getLatestBackupSpy.mockRestore();
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  it("returns a blocked outcome with hints instead of throwing when installer restore intent is unset", () => {
    const outcome = resolveNotReadyOutcome("my-assistant", note);
    expect(outcome.kind).toBe("blocked");
    const hints = (outcome as { kind: "blocked"; hints: readonly string[] }).hints.join("\n");
    expect(hints).toMatch(/Sandbox 'my-assistant' already exists but is not ready/);
    expect(hints).toMatch(/Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1/);
  });

  it("returns a proceed outcome with the restore path when installer intent finds a backup", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      backupPath: BACKUP_PATH,
    } as unknown as ReturnType<typeof sandboxState.getLatestBackup>);
    expect(resolveNotReadyOutcome("my-assistant", note)).toEqual({
      kind: "proceed",
      restoreBackupPath: BACKUP_PATH,
    });
  });

  it("blocks live not-ready custom OpenClaw recreation with a legacy backup (#6108)", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      agentType: "openclaw",
      dir: "/sandbox/.openclaw",
      backupPath: BACKUP_PATH,
      openclawImagePluginInstalls: [],
    } as unknown as ReturnType<typeof sandboxState.getLatestBackup>);

    const outcome = resolveNotReadyOutcome("my-assistant", note, {
      name: "my-assistant",
      agent: "openclaw",
      fromDockerfile: "/tmp/Dockerfile.custom",
    });

    expect(outcome.kind).toBe("blocked");
    expect(outcome).toMatchObject({
      hints: expect.arrayContaining([expect.stringContaining("lacks verified plugin provenance")]),
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("blocks an orphan sandbox when the requested target is custom OpenClaw (#6108)", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      agentType: "openclaw",
      dir: "/sandbox/.openclaw",
      backupPath: BACKUP_PATH,
      openclawImagePluginInstalls: [],
    } as unknown as ReturnType<typeof sandboxState.getLatestBackup>);

    const outcome = resolveNotReadyOutcome("orphan", note, null, true);

    expect(outcome.kind).toBe("blocked");
    expect(outcome).toMatchObject({
      hints: expect.arrayContaining([
        expect.stringContaining("new sandbox name"),
        expect.stringContaining("NEMOCLAW_RECREATE_WITHOUT_BACKUP=1"),
      ]),
    });
    expect(note).not.toHaveBeenCalled();
  });
});

describe("installerRestoreOnRecreateFromEnv", () => {
  it("returns true when the installer restore sentinel is set to '1'", () => {
    expect(
      installerRestoreOnRecreateFromEnv({
        NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: "1",
      }),
    ).toBe(true);
  });

  it("returns false for an empty environment", () => {
    expect(installerRestoreOnRecreateFromEnv({})).toBe(false);
  });

  it("returns false when the sentinel is set to any value other than '1'", () => {
    for (const value of ["", "0", "true", "yes"]) {
      expect(
        installerRestoreOnRecreateFromEnv({
          NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: value,
        }),
      ).toBe(false);
    }
  });
});
