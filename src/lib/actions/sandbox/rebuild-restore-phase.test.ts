// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as restoreWindow from "./runtime/openclaw-lifecycle";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";
import * as snapshotRestore from "./snapshot/restore-authority";

const backupManifest = {
  agentType: "openclaw",
  backupPath: "/tmp/rebuild-backup",
} as never;

describe("rebuild filesystem restore", () => {
  beforeEach(() => {
    vi.spyOn(restoreWindow, "beginUnregisteredOpenClawBackupQuiesce").mockResolvedValue({
      ok: true,
      window: { sandboxName: "alpha", kind: "backup" },
    });
    vi.spyOn(
      restoreWindow,
      "promoteUnregisteredOpenClawBackupQuiesceToPostRestoreDoctor",
    ).mockResolvedValue({
      ok: true,
      window: { sandboxName: "alpha" },
    });
    vi.spyOn(restoreWindow, "beginUnregisteredOpenClawPostRestoreDoctor").mockResolvedValue({
      ok: true,
      window: { sandboxName: "alpha" },
    });
    vi.spyOn(restoreWindow, "abortUnregisteredOpenClawPostRestoreDoctor").mockResolvedValue({
      ok: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores complete native state through managed authority without replaying policy state", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockResolvedValue({
        success: true,
        restoredDirs: ["."],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    const result = await runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "openclaw",
      backupManifest,
      log: vi.fn(),
    });

    expect(restore).toHaveBeenCalledWith(
      "alpha",
      backupManifest,
      { targetAgentType: "openclaw" },
      { getSandbox: expect.any(Function) },
    );
    expect(result).toEqual({
      restoreSucceeded: true,
      openClawDoctorWindow: { sandboxName: "alpha" },
    });
    expect(restoreWindow.beginUnregisteredOpenClawBackupQuiesce).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      undefined,
    );
    expect(
      vi.mocked(restoreWindow.beginUnregisteredOpenClawBackupQuiesce).mock.invocationCallOrder[0],
    ).toBeLessThan(restore.mock.invocationCallOrder[0]!);
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(restoreWindow.promoteUnregisteredOpenClawBackupQuiesceToPostRestoreDoctor).mock
        .invocationCallOrder[0]!,
    );
  });

  it("opens a fresh doctor window when restored state replaces the backup marker", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(
      restoreWindow.promoteUnregisteredOpenClawBackupQuiesceToPostRestoreDoctor,
    ).mockResolvedValue({ ok: false, stage: "doctor", detail: "backup marker replaced" });
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockResolvedValue(
      {
        success: true,
        restoredDirs: ["."],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      },
    );

    await expect(
      runRebuildRestorePhase({
        sandboxName: "alpha",
        targetAgentType: "openclaw",
        backupManifest,
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({
      restoreSucceeded: true,
      openClawDoctorWindow: { sandboxName: "alpha" },
    });
    expect(
      restoreWindow.beginUnregisteredOpenClawPostRestoreDoctor,
    ).toHaveBeenCalledExactlyOnceWith("alpha", undefined);
  });

  it("uses the same whole-state restore for custom images", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockResolvedValue({
        success: true,
        restoredDirs: ["."],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    await runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "openclaw",
      backupManifest,
      log: vi.fn(),
    });

    expect(restore).toHaveBeenCalledWith(
      "alpha",
      backupManifest,
      { targetAgentType: "openclaw" },
      { getSandbox: expect.any(Function) },
    );
  });

  it("carries the frozen OpenShell target into SSH restore reads (#10514)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockResolvedValue({
        success: true,
        restoredDirs: ["."],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });
    const runtimeSelection = {
      gatewayName: "nemoclaw-8081",
      localTlsDir: "/authority/tls",
      workspace: "default",
    };

    await runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "openclaw",
      backupManifest,
      runtimeSelection,
      log: vi.fn(),
    });

    expect(restore).toHaveBeenCalledWith(
      "alpha",
      backupManifest,
      { targetAgentType: "openclaw", runtimeSelection },
      { getSandbox: expect.any(Function) },
    );
  });

  it("does not interpret or merge Hermes state after the whole-state transfer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockResolvedValue({
        success: true,
        restoredDirs: ["."],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    await expect(
      runRebuildRestorePhase({
        sandboxName: "hermes",
        targetAgentType: "hermes",
        backupManifest: { agentType: "hermes", backupPath: "/tmp/rebuild-backup" } as never,
        log: vi.fn(),
      }),
    ).resolves.toEqual({ restoreSucceeded: true });
    expect(restore).toHaveBeenCalledOnce();
  });

  it("surfaces a filesystem restore failure without inventing policy recovery", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.fn();
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockResolvedValue(
      {
        success: false,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: ["."],
        failedFiles: [],
        error: "native state archive failed validation",
      },
    );

    const result = await runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "openclaw",
      backupManifest,
      log,
    });

    expect(result).toEqual({ restoreSucceeded: false });
    expect(consoleError).toHaveBeenCalledWith(
      "  Restore blocked: native state archive failed validation",
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("error=native state archive failed validation"),
    );
  });
});
