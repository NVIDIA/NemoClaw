// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as sandboxState from "../state/sandbox";
import {
  applyNonInteractiveNotReadyDecision,
  decideNonInteractiveNotReadyAction,
  selectPreUpgradeBackupForCreate,
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

  beforeEach(() => {
    note.mockReset();
    getLatestBackupSpy = vi.spyOn(sandboxState, "getLatestBackup");
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  afterEach(() => {
    getLatestBackupSpy.mockRestore();
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
  });

  it("returns the latest backup path and notes it when installer restore intent finds a backup", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      backupPath: BACKUP_PATH,
    } as ReturnType<typeof sandboxState.getLatestBackup>);
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
  });
});

describe("applyNonInteractiveNotReadyDecision", () => {
  const note = vi.fn();
  let getLatestBackupSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    note.mockReset();
    getLatestBackupSpy = vi.spyOn(sandboxState, "getLatestBackup");
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  afterEach(() => {
    getLatestBackupSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE;
  });

  it("exits with code 1 and prints the recreate-flag hint when installer restore intent is unset", () => {
    expect(() => applyNonInteractiveNotReadyDecision("my-assistant", note)).toThrow(
      /process\.exit called with 1/,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Sandbox 'my-assistant' already exists but is not ready/),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1/),
    );
    expect(getLatestBackupSpy).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("returns the pre-upgrade backup path and notes the restore when installer intent finds a backup", () => {
    process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE = "1";
    getLatestBackupSpy.mockReturnValue({
      backupPath: BACKUP_PATH,
    } as ReturnType<typeof sandboxState.getLatestBackup>);
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
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
