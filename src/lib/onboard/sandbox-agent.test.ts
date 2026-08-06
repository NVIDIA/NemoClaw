// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createPromptValidatedSandboxName,
  enforceCuaOnboardReconciliation,
  requiresCuaReconciliationBeforeOnboard,
} from "./sandbox-agent";

describe("CUA onboarding reconciliation", () => {
  it("blocks reuse for an attached target or a durable uncertain-effect journal", () => {
    expect(
      requiresCuaReconciliationBeforeOnboard({
        name: "alpha",
        cuaTarget: { target: { identityDigest: "present" } } as never,
      }),
    ).toBe(true);
    expect(
      requiresCuaReconciliationBeforeOnboard({
        name: "alpha",
        cuaReconciliation: { phase: "required" } as never,
      }),
    ).toBe(true);
    expect(requiresCuaReconciliationBeforeOnboard({ name: "alpha" })).toBe(false);
  });

  it("persists the gate and exits before onboarding can reuse or rebuild the worker", () => {
    const requireReconciliation = vi.fn(() => true);
    const error = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${String(code)}`);
    });

    expect(() =>
      enforceCuaOnboardReconciliation(
        "alpha",
        {
          name: "alpha",
          cuaReconciliation: { phase: "required" } as never,
        },
        "nemoclaw",
        { requireReconciliation, error, exit },
      ),
    ).toThrow("exit 1");
    expect(requireReconciliation).toHaveBeenCalledWith("alpha", "readiness-change");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cannot be reused or rebuilt"));
  });
});

describe("sandbox name prompt", () => {
  it("checkpoints a validated name before returning it to onboarding (#6743)", async () => {
    const checkpointSandboxName = vi.fn();
    const promptValidatedSandboxName = createPromptValidatedSandboxName({
      promptOrDefault: vi.fn(async () => "tm"),
      cliDisplayName: () => "NemoClaw",
      isNonInteractive: () => false,
      checkpointSandboxName,
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
    });

    await expect(promptValidatedSandboxName()).resolves.toBe("tm");
    expect(checkpointSandboxName).toHaveBeenCalledWith("tm", null);
  });

  it("propagates a checkpoint failure without treating the name as invalid (#6743)", async () => {
    const checkpointError = new Error("session write failed");
    const promptOrDefault = vi.fn(async () => "tm");
    const promptValidatedSandboxName = createPromptValidatedSandboxName({
      promptOrDefault,
      cliDisplayName: () => "NemoClaw",
      isNonInteractive: () => false,
      checkpointSandboxName: () => {
        throw checkpointError;
      },
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
    });

    await expect(promptValidatedSandboxName()).rejects.toBe(checkpointError);
    expect(promptOrDefault).toHaveBeenCalledTimes(1);
  });
});
