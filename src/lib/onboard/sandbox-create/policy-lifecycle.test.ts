// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createSandboxCreatePolicyDisclosure,
  finalizeCreatedSandboxWithTemporaryPolicyCleanup,
} from "./orchestration";
import {
  materializeRebuildPolicyHandoff,
  RebuildPolicyCleanupError,
} from "./rebuild-policy-handoff";

describe("sandbox create policy disclosure", () => {
  it("keeps ordinary create policy disclosure at materialization", () => {
    const disclose = vi.fn();
    const policy = { policyPath: "/tmp/generated-policy.yaml", appliedPresets: ["telegram"] };
    const disclosure = createSandboxCreatePolicyDisclosure({
      rebuildPolicySourcePath: undefined,
      disclose,
    });

    disclosure.discloseGeneratedPolicy(policy);
    disclosure.discloseSelectedPolicy(policy);

    expect(disclose).toHaveBeenCalledOnce();
    expect(disclose).toHaveBeenCalledWith(policy);
  });

  it("discloses only the final policy selected for a rebuild", () => {
    const disclose = vi.fn();
    const generatedPolicy = {
      policyPath: "/tmp/generated-policy.yaml",
      appliedPresets: ["telegram"],
    };
    const selectedPolicy = {
      policyPath: "/tmp/rebuild-handoff.yaml",
      appliedPresets: [],
    };
    const disclosure = createSandboxCreatePolicyDisclosure({
      rebuildPolicySourcePath: "/tmp/live-policy.yaml",
      disclose,
    });

    disclosure.discloseGeneratedPolicy(generatedPolicy);
    disclosure.discloseSelectedPolicy(selectedPolicy);

    expect(disclose).toHaveBeenCalledOnce();
    expect(disclose).toHaveBeenCalledWith(selectedPolicy);
    expect(disclose).not.toHaveBeenCalledWith(generatedPolicy);
  });

  it("cleans the final rebuild policy when disclosure fails", () => {
    const cleanup = vi.fn(() => true);
    const policy = {
      policyPath: "/tmp/rebuild-handoff.yaml",
      appliedPresets: [],
      cleanup,
    };
    const disclosure = createSandboxCreatePolicyDisclosure({
      rebuildPolicySourcePath: "/tmp/live-policy.yaml",
      disclose: () => {
        throw new Error("disclosure failed");
      },
    });

    expect(() => disclosure.discloseSelectedPolicy(policy)).toThrow("disclosure failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("temporary sandbox create policy cleanup", () => {
  it("reports an error when temporary handoff policy cleanup fails after finalization", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-cleanup-test-"));
    const livePolicyPath = path.join(root, "live.yaml");
    const replacementPolicyPath = path.join(root, "replacement.yaml");
    fs.writeFileSync(livePolicyPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
    fs.writeFileSync(
      replacementPolicyPath,
      "version: 1\nfilesystem_policy:\n  read_only: [/run/replacement]\n",
      { mode: 0o600 },
    );
    const handoff = materializeRebuildPolicyHandoff({
      livePolicyPath,
      replacementPolicy: { policyPath: replacementPolicyPath, appliedPresets: [] },
    });
    try {
      fs.appendFileSync(handoff.policyPath, "# changed after cleanup authority capture\n");

      const error = await finalizeCreatedSandboxWithTemporaryPolicyCleanup({
        finalize: async () => "created",
        cleanup: handoff.cleanup ?? (() => true),
        policyPath: handoff.policyPath,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        message: expect.stringContaining("Sandbox finalization completed."),
      });
      expect((error as Error).message).toContain(handoff.policyPath);
      expect((error as Error).message).toContain(
        "After confirming finalization state, remove the retained file before retrying onboarding",
      );
      expect(fs.existsSync(handoff.policyPath)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(handoff.policyPath), { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the finalization result after temporary policy cleanup succeeds", async () => {
    await expect(
      finalizeCreatedSandboxWithTemporaryPolicyCleanup({
        finalize: async () => "created",
        cleanup: () => true,
        policyPath: "/verified/temporary-policy.yaml",
      }),
    ).resolves.toBe("created");
  });

  it("preserves finalization and temporary policy cleanup failures together", async () => {
    const finalizationError = new Error("registration failed");

    const error = await finalizeCreatedSandboxWithTemporaryPolicyCleanup({
      finalize: async () => {
        throw finalizationError;
      },
      cleanup: () => false,
      policyPath: "/verified/temporary-policy.yaml",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      finalizationError,
      expect.objectContaining({ message: expect.stringContaining("temporary-policy.yaml") }),
    ]);
  });

  it("preserves a thrown temporary policy cleanup cause after finalization", async () => {
    const cleanupError = new Error("cleanup transport failed");

    const error = await finalizeCreatedSandboxWithTemporaryPolicyCleanup({
      finalize: async () => "created",
      cleanup: () => {
        throw cleanupError;
      },
      policyPath: "/verified/temporary-policy.yaml",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ cause: cleanupError });
  });

  it("reports the generated replacement path when handoff cleanup succeeds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-cleanup-path-test-"));
    const livePolicyPath = path.join(root, "live.yaml");
    const replacementPolicyPath = path.join(root, "replacement.yaml");
    fs.writeFileSync(livePolicyPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
    fs.writeFileSync(
      replacementPolicyPath,
      "version: 1\nfilesystem_policy:\n  read_only: [/run/replacement]\n",
      { mode: 0o600 },
    );
    const replacementCleanupCause = new Error("replacement cleanup transport failed");
    const handoff = materializeRebuildPolicyHandoff({
      livePolicyPath,
      replacementPolicy: {
        policyPath: replacementPolicyPath,
        appliedPresets: [],
        cleanup: () => {
          throw replacementCleanupCause;
        },
      },
    });
    try {
      const error = await finalizeCreatedSandboxWithTemporaryPolicyCleanup({
        finalize: async () => "created",
        cleanup: handoff.cleanup ?? (() => true),
        policyPath: handoff.policyPath,
      }).catch((caught: unknown) => caught);

      expect((error as Error).message).toContain(replacementPolicyPath);
      expect((error as Error).message).not.toContain(handoff.policyPath);
      expect((error as Error).cause).toBeInstanceOf(RebuildPolicyCleanupError);
      expect(((error as Error).cause as RebuildPolicyCleanupError).errors).toEqual([
        expect.objectContaining({ cause: replacementCleanupCause }),
      ]);
      expect(fs.existsSync(handoff.policyPath)).toBe(false);
      expect(fs.existsSync(replacementPolicyPath)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(handoff.policyPath), { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
