// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createLocalInferenceRouteApplier,
  type LocalInferenceRouteDeps,
} from "./local-inference-route";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`EXIT_CALLED:${code}`);
  }
}

function createDeps(overrides: Partial<LocalInferenceRouteDeps> = {}): LocalInferenceRouteDeps {
  return {
    runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    isNonInteractive: vi.fn(() => false),
    promptValidationRecovery: vi.fn(async () => "selection" as const),
    classifyApplyFailure: vi.fn(() => ({ kind: "unknown" }) as never),
    compactText: vi.fn((value: string) => value.trim()),
    redact: vi.fn((value: string) => value),
    localInferenceTimeoutSecs: 30,
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new ExitError(code);
    }),
    ...overrides,
  };
}

describe("local inference route recovery", () => {
  it("redacts a failed non-interactive route and preserves its exit status", async () => {
    const runOpenshell = vi.fn(() => ({
      status: 17,
      stderr: "route failed with secret-token",
      stdout: "secret-token detail",
    }));
    const redact = vi.fn((value: string) => value.replaceAll("secret-token", "[redacted]"));
    const exitProcess = vi.fn((code: number): never => {
      throw new ExitError(code);
    });
    const deps = createDeps({
      runOpenshell,
      isNonInteractive: () => true,
      redact,
      exitProcess,
    });

    await expect(
      createLocalInferenceRouteApplier(deps)("ollama-local", "qwen3.5:9b"),
    ).rejects.toEqual(new ExitError(17));

    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "--no-verify",
        "--provider",
        "ollama-local",
        "--model",
        "qwen3.5:9b",
        "--timeout",
        "30",
      ],
      { ignoreError: true },
    );
    expect(redact).toHaveBeenCalledWith("route failed with secret-token secret-token detail");
    expect(deps.error).toHaveBeenNthCalledWith(
      1,
      "  route failed with [redacted] [redacted] detail",
    );
    expect(deps.error).toHaveBeenNthCalledWith(
      2,
      "  No sandbox was created. Fix the inference route and re-run `nemoclaw onboard --resume` to continue, or choose a different provider/model.",
    );
    expect(vi.mocked(deps.error).mock.calls.flat().join("\n")).not.toContain("secret-token");
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(17);
    expect(deps.promptValidationRecovery).not.toHaveBeenCalled();
  });

  it("retries an interactive route failure and returns success", async () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "temporary route failure" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const recovery = { kind: "transport" } as never;
    const deps = createDeps({
      runOpenshell,
      promptValidationRecovery: vi.fn(async () => "retry" as const),
      classifyApplyFailure: vi.fn(() => recovery),
    });

    await expect(
      createLocalInferenceRouteApplier(deps)("vllm-local", "meta-llama/Llama-3"),
    ).resolves.toBe(false);

    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(deps.error).toHaveBeenCalledOnce();
    expect(deps.error).toHaveBeenCalledWith("  temporary route failure");
    expect(deps.promptValidationRecovery).toHaveBeenCalledOnce();
    expect(deps.promptValidationRecovery).toHaveBeenCalledWith("Local vLLM", recovery, null, null);
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("returns to provider selection after an interactive route failure", async () => {
    const runOpenshell = vi.fn(() => ({ status: 6, stdout: "", stderr: "select another" }));
    const deps = createDeps({
      runOpenshell,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });

    await expect(
      createLocalInferenceRouteApplier(deps)("ollama-local", "qwen3.5:9b"),
    ).resolves.toBe(true);

    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(deps.promptValidationRecovery).toHaveBeenCalledOnce();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });
});
