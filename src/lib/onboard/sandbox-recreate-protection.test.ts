// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { PreUpgradeBackupSelectInput } from "./not-ready-recreate";
import { createSandboxRecreateProtection } from "./sandbox-recreate-protection";
import type { SandboxRecreateSourceProof } from "./sandbox-recreate-transaction";

describe("createSandboxRecreateProtection", () => {
  it("forwards one custom-image protection context to every recreation path (#6108)", () => {
    const note = vi.fn();
    const sandboxEntry = {
      name: "my-assistant",
      agent: "openclaw" as const,
      fromDockerfile: "/tmp/Dockerfile.custom",
    };
    const selectPreUpgradeBackupForCreate = vi.fn(
      (_input: PreUpgradeBackupSelectInput) => "/tmp/backup" as string | null,
    );
    const resolveNotReadyOutcome = vi.fn(() => ({
      kind: "proceed" as const,
      restoreBackupPath: "/tmp/backup",
    }));
    const backupResult = {
      ok: true,
      backup: null,
      failureKind: "none" as const,
    };
    const backupSandboxBeforeRecreate = vi.fn(() => backupResult);
    const protection = createSandboxRecreateProtection(
      {
        sandboxName: "my-assistant",
        sandboxEntry,
        customOpenClawImage: true,
        note,
      },
      {
        selectPreUpgradeBackupForCreate,
        resolveNotReadyOutcome,
        backupSandboxBeforeRecreate,
      },
    );

    const sourceProof = {
      transactionId: "0f2f0d3a-recreate",
      sandboxName: "my-assistant",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sourceRegistryFingerprint: "fingerprint",
      sourceLiveIdentityFingerprint: null,
      targetGeneration: "3c9a1b7e-target",
    };
    const observation = { state: "missing" as const, liveIdentityFingerprint: null };
    const readRegistryEntry = vi.fn(() => sandboxEntry);

    expect(
      protection.selectPreUpgradeBackup({
        sourceProof: () => sourceProof,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        readRegistryEntry,
        observation: () => observation,
      }),
    ).toBe("/tmp/backup");
    expect(selectPreUpgradeBackupForCreate).toHaveBeenCalledWith({
      sourceProof: expect.any(Function),
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      registryEntry: sandboxEntry,
      readRegistryEntry,
      observation: expect.any(Function),
      existingSandboxEntry: sandboxEntry,
      requireOpenClawImagePluginProvenance: true,
      sandboxName: "my-assistant",
      note,
    });
    const forwarded = selectPreUpgradeBackupForCreate.mock.calls[0][0];
    expect(forwarded.sourceProof()).toBe(sourceProof);
    expect(forwarded.readRegistryEntry()).toBe(sandboxEntry);
    expect(forwarded.observation()).toBe(observation);

    expect(protection.resolveNotReadyOutcome()).toEqual({
      kind: "proceed",
      restoreBackupPath: "/tmp/backup",
    });
    expect(resolveNotReadyOutcome).toHaveBeenCalledWith("my-assistant", note, sandboxEntry, true);

    expect(protection.backup()).toBe(backupResult);
    expect(backupSandboxBeforeRecreate).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      sandboxEntry,
      requireOpenClawImagePluginProvenance: true,
    });
  });

  describe("selectJournalBoundPreUpgradeBackup", () => {
    const IDLE_RUNTIME = { sourceProof: null };
    const JOURNALED_PROOF: SandboxRecreateSourceProof = {
      transactionId: "0f2f0d3a-recreate",
      sandboxName: "my-assistant",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sourceRegistryFingerprint: "fingerprint",
      sourceLiveIdentityFingerprint: null,
      targetGeneration: "3c9a1b7e-target",
    };

    function protectionWith(
      selectPreUpgradeBackupForCreate: (input: PreUpgradeBackupSelectInput) => string | null,
    ) {
      return createSandboxRecreateProtection(
        {
          sandboxName: "my-assistant",
          sandboxEntry: { name: "my-assistant" },
          customOpenClawImage: false,
          note: vi.fn(),
        },
        {
          selectPreUpgradeBackupForCreate,
          resolveNotReadyOutcome: vi.fn(() => ({
            kind: "proceed" as const,
            restoreBackupPath: null,
          })),
          backupSandboxBeforeRecreate: vi.fn(() => ({
            ok: true,
            backup: null,
            failureKind: "none" as const,
          })),
        },
      );
    }

    function journalBinding(
      openJournal: (() => { sourceProof: SandboxRecreateSourceProof }) | null,
    ) {
      return {
        runtime: IDLE_RUNTIME as { sourceProof: SandboxRecreateSourceProof | null },
        openJournal,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        readRegistryEntry: () => ({ name: "my-assistant" }),
        observe: () => ({ state: "missing" as const, liveIdentityFingerprint: null }),
      };
    }

    it("leaves no transaction open when selection never asks for a source proof (#7736)", () => {
      const openJournal = vi.fn(() => ({ sourceProof: JOURNALED_PROOF }));
      const protection = protectionWith(() => null);

      const result = protection.selectJournalBoundPreUpgradeBackup(journalBinding(openJournal));

      expect(openJournal).not.toHaveBeenCalled();
      expect(result).toEqual({ runtime: IDLE_RUNTIME, backupPath: null });
    });

    it("opens the journal and reports its runtime once a source proof is demanded (#7736)", () => {
      const journaled = { sourceProof: JOURNALED_PROOF };
      const openJournal = vi.fn(() => journaled);
      const protection = protectionWith((input) => {
        expect(input.sourceProof()).toBe(JOURNALED_PROOF);
        expect(input.readRegistryEntry()).toEqual({ name: "my-assistant" });
        return "/tmp/backup";
      });

      const result = protection.selectJournalBoundPreUpgradeBackup(journalBinding(openJournal));

      expect(openJournal).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ runtime: journaled, backupPath: "/tmp/backup" });
    });

    it("abandons the journal it opened when selection rejects the source (#7736)", () => {
      const abandon = vi.fn();
      const openJournal = vi.fn(() => ({ sourceProof: JOURNALED_PROOF, abandon }));
      const protection = protectionWith((input) => {
        input.sourceProof();
        throw new Error("the source registry row is absent");
      });

      expect(() =>
        protection.selectJournalBoundPreUpgradeBackup(journalBinding(openJournal)),
      ).toThrow(/source registry row is absent/);
      expect(abandon).toHaveBeenCalledTimes(1);
    });
  });
});
