// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  agentRuntime,
  openClawLifecycle,
  rebuildBackupPhase,
  rebuildDestroyPhase,
  rebuildRecreateJournal,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("interactive rebuild bail after backup (#12919)", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("releases the source window and onboard lock before exiting for a late failure", async () => {
    const harness = createRebuildFlowHarness();
    const release = vi
      .spyOn(rebuildBackupPhase, "releaseRebuildSourceOpenClawWindow")
      .mockResolvedValue({ ok: true } as never);
    vi.spyOn(rebuildBackupPhase, "bindRebuildSnapshotGpuAuthority").mockImplementation(() => {
      throw new Error("injected GPU authority conflict");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await harness.rebuildSandbox("alpha", ["--yes"]);

    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "Captured sandbox GPU authority cannot be replayed safely: injected GPU authority conflict",
    );
    expect(release).toHaveBeenCalledOnce();
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(harness.releaseOnboardLockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    );
  });

  it("aborts the post-restore window and releases the onboard lock before exiting", async () => {
    const harness = createRebuildFlowHarness();
    const finish = vi
      .spyOn(openClawLifecycle, "finishUnregisteredOpenClawPostRestoreDoctor")
      .mockResolvedValue({
        ok: false,
        stage: "restart",
        detail: "injected final start failure",
      });
    const abort = vi.spyOn(openClawLifecycle, "abortUnregisteredOpenClawPostRestoreDoctor");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await harness.rebuildSandbox("alpha", ["--yes"]);

    expect(finish).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(harness.releaseOnboardLockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    );
  });

  it("aborts the post-restore window before exiting for a recreated agent mismatch", async () => {
    const harness = createRebuildFlowHarness();
    harness.onboardSpy.mockImplementation(async () => {
      vi.mocked(agentRuntime.getSessionAgent).mockReturnValue({ name: "hermes" } as never);
    });
    const abort = vi.spyOn(openClawLifecycle, "abortUnregisteredOpenClawPostRestoreDoctor");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await harness.rebuildSandbox("alpha", ["--yes"]);

    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "Recreated sandbox agent identity did not match the authoritative rebuild target.",
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(harness.releaseOnboardLockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    );
  });

  it("reconciles a rejected source release before a late CLI exit", async () => {
    const harness = createRebuildFlowHarness();
    const finish = vi
      .spyOn(openClawLifecycle, "finishOpenClawBackupQuiesce")
      .mockRejectedValue(new Error("injected release failure"));
    const abort = vi.spyOn(openClawLifecycle, "abortOpenClawPostRestoreDoctor").mockResolvedValue({
      ok: true,
    });
    vi.spyOn(rebuildBackupPhase, "bindRebuildSnapshotGpuAuthority").mockImplementation(() => {
      throw new Error("injected GPU authority conflict");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await harness.rebuildSandbox("alpha", ["--yes"]);

    const errors = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errors).toContain("injected release failure");
    expect(errors).toContain("The retained sandbox was stopped");
    expect(errors).toContain("Captured sandbox GPU authority cannot be replayed safely");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(finish).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(finish.mock.invocationCallOrder[0]).toBeLessThan(abort.mock.invocationCallOrder[0]);
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(harness.releaseOnboardLockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      exit.mock.invocationCallOrder[0],
    );
  });

  it("reports a source-window release error when no bail is pending", async () => {
    const harness = createRebuildFlowHarness();
    vi.spyOn(rebuildDestroyPhase, "runRebuildDestroyPhase").mockResolvedValue(null);
    vi.spyOn(rebuildBackupPhase, "releaseRebuildSourceOpenClawWindow").mockRejectedValue(
      new Error("injected release failure"),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await expect(harness.rebuildSandbox("alpha", ["--yes"])).rejects.toThrow(
      "injected release failure",
    );

    expect(exit).not.toHaveBeenCalled();
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });

  it("keeps recovery handoffs without reauthorizing a backup after source release fails", async () => {
    const harness = createRebuildFlowHarness();
    vi.spyOn(rebuildDestroyPhase, "runRebuildDestroyPhase").mockResolvedValue(null);
    vi.spyOn(openClawLifecycle, "finishOpenClawBackupQuiesce").mockResolvedValue({
      ok: false,
      stage: "restart",
      detail: "source remained in maintenance",
    });
    const abort = vi.spyOn(openClawLifecycle, "abortOpenClawPostRestoreDoctor").mockResolvedValue({
      ok: true,
    });

    await expect(harness.rebuildSandbox("alpha", ["--yes"])).rejects.toThrow(
      "OpenClaw source maintenance cleanup did not complete.",
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(harness.backupPath, ".nemoclaw-rebuild-recovery.json"))).toBe(
      false,
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(harness.backupPath, "rebuild-manifest.json"), "utf8"),
    ) as { rebuildPolicyHandoff: { file: string } };
    expect(manifest.rebuildPolicyHandoff?.file).toBeTruthy();
    expect(fs.existsSync(path.join(harness.backupPath, manifest.rebuildPolicyHandoff.file))).toBe(
      true,
    );
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });

  it("keeps the recovery handoff when MCP reattachment fails before deletion", async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Teams webhook port changed"));
    const harness = createRebuildFlowHarness({ preflightMessagingConflicts: check });
    harness.reattachMcpProvidersAfterRebuildAbortSpy.mockRejectedValue(
      new Error("MCP reattachment failed before deletion"),
    );
    let markerPresentAtRelease = true;
    const release = vi
      .spyOn(openClawLifecycle, "finishOpenClawBackupQuiesce")
      .mockImplementation(async () => {
        markerPresentAtRelease = fs.existsSync(
          path.join(harness.backupPath, ".nemoclaw-rebuild-recovery.json"),
        );
        return { ok: true };
      });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("MCP provider recovery also failed: MCP reattachment failed before deletion");

    expect(check).toHaveBeenCalledTimes(2);
    expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(markerPresentAtRelease).toBe(false);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(harness.backupPath, "rebuild-manifest.json"), "utf8"),
    ) as { rebuildPolicyHandoff: { file: string } };
    expect(manifest.rebuildPolicyHandoff?.file).toBeTruthy();
    expect(fs.existsSync(path.join(harness.backupPath, manifest.rebuildPolicyHandoff.file))).toBe(
      true,
    );
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });

  it("keeps the source stopped if the pre-delete recovery marker cannot be invalidated", async () => {
    const harness = createRebuildFlowHarness();
    vi.spyOn(rebuildDestroyPhase, "runRebuildDestroyPhase").mockImplementation(async (input) => {
      input.bail("injected pre-delete refusal");
      return null;
    });
    vi.spyOn(rebuildRecreateJournal, "clearRebuildRecoveryBackup").mockImplementation(() => {
      throw new Error("injected marker retirement failure");
    });
    const abort = vi.spyOn(openClawLifecycle, "abortOpenClawPostRestoreDoctor");
    const release = vi.spyOn(openClawLifecycle, "finishOpenClawBackupQuiesce");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("injected pre-delete refusal");

    expect(abort).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(harness.backupPath, ".nemoclaw-rebuild-recovery.json"))).toBe(
      true,
    );
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "the retained backup recovery marker could not be invalidated before source release",
    );
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });

  it("does not suggest a same-transaction retry after marker removal but failed sync", async () => {
    const harness = createRebuildFlowHarness();
    vi.spyOn(rebuildDestroyPhase, "runRebuildDestroyPhase").mockImplementation(async (input) => {
      input.bail("injected pre-delete refusal");
      return null;
    });
    vi.spyOn(rebuildRecreateJournal, "clearRebuildRecoveryBackup").mockImplementation((marker) => {
      fs.unlinkSync(path.join(marker.backupManifest.backupPath, ".nemoclaw-rebuild-recovery.json"));
      throw new rebuildRecreateJournal.RebuildRecoveryMarkerSyncError(
        new Error("injected directory sync failure"),
      );
    });
    const abort = vi.spyOn(openClawLifecycle, "abortOpenClawPostRestoreDoctor");
    const release = vi.spyOn(openClawLifecycle, "finishOpenClawBackupQuiesce");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("injected pre-delete refusal");

    expect(abort).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(harness.backupPath, ".nemoclaw-rebuild-recovery.json"))).toBe(
      false,
    );
    const warnings = harness.errorSpy.mock.calls.flat().join("\n");
    expect(warnings).toContain("source maintenance cleanup failed after the marker was removed");
    expect(warnings).not.toContain("could not be invalidated before source release");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(harness.backupPath, "rebuild-manifest.json"), "utf8"),
    ) as { rebuildPolicyHandoff: { file: string } };
    expect(fs.existsSync(path.join(harness.backupPath, manifest.rebuildPolicyHandoff.file))).toBe(
      true,
    );
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });

  it("reports an unverified source stop if marker invalidation and abort both fail", async () => {
    const harness = createRebuildFlowHarness();
    vi.spyOn(rebuildDestroyPhase, "runRebuildDestroyPhase").mockImplementation(async (input) => {
      input.bail("injected pre-delete refusal");
      return null;
    });
    vi.spyOn(rebuildRecreateJournal, "clearRebuildRecoveryBackup").mockImplementation(() => {
      throw new Error("injected marker retirement failure");
    });
    vi.spyOn(openClawLifecycle, "abortOpenClawPostRestoreDoctor").mockRejectedValue(
      new Error("source stop was not verified"),
    );
    const release = vi.spyOn(openClawLifecycle, "finishOpenClawBackupQuiesce");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("injected pre-delete refusal");

    expect(release).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "The retained source stop could not be verified (source stop was not verified).",
    );
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });
});
