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
    inferenceRouteMutator: {
      setInferenceRoute: vi.fn(async () => ({ ok: true as const })),
    },
    gatewayName: "nemoclaw",
    isNonInteractive: vi.fn(() => false),
    promptValidationRecovery: vi.fn(async () => "selection" as const),
    classifyApplyFailure: vi.fn(() => ({ kind: "unknown" }) as never),
    localInferenceTimeoutSecs: 30,
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new ExitError(code);
    }),
    ...overrides,
  };
}

describe("local inference route recovery", () => {
  it("preserves a definite non-interactive route failure exit status", async () => {
    const setInferenceRoute = vi.fn(async () => ({
      ok: false as const,
      ambiguous: false,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
        exitCode: 17,
        message: "route failed",
      },
    }));
    const exitProcess = vi.fn((code: number): never => {
      throw new ExitError(code);
    });
    const deps = createDeps({
      inferenceRouteMutator: { setInferenceRoute },
      isNonInteractive: () => true,
      exitProcess,
    });

    await expect(
      createLocalInferenceRouteApplier(deps)("ollama-local", "qwen3.5:9b"),
    ).rejects.toEqual(new ExitError(17));

    expect(setInferenceRoute).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      route: { provider: "ollama-local", model: "qwen3.5:9b" },
      verification: "skip",
      verificationTimeoutSeconds: 30,
    });
    expect(deps.error).toHaveBeenNthCalledWith(1, "  route failed");
    expect(deps.error).toHaveBeenNthCalledWith(
      2,
      "  No sandbox was created. Fix the inference route and re-run `nemoclaw onboard --resume` to continue, or choose a different provider/model.",
    );
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(17);
    expect(deps.promptValidationRecovery).not.toHaveBeenCalled();
  });

  it("retries an interactive route failure and returns success", async () => {
    const setInferenceRoute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        ambiguous: false,
        error: {
          kind: "command",
          reason: "failed",
          exitCode: 9,
          message: "temporary route failure",
        },
      })
      .mockResolvedValueOnce({ ok: true });
    const recovery = { kind: "transport" } as never;
    const deps = createDeps({
      inferenceRouteMutator: { setInferenceRoute },
      promptValidationRecovery: vi.fn(async () => "retry" as const),
      classifyApplyFailure: vi.fn(() => recovery),
    });

    await expect(
      createLocalInferenceRouteApplier(deps)("vllm-local", "meta-llama/Llama-3"),
    ).resolves.toBe(false);

    expect(setInferenceRoute).toHaveBeenCalledTimes(2);
    expect(deps.error).toHaveBeenCalledOnce();
    expect(deps.error).toHaveBeenCalledWith("  temporary route failure");
    expect(deps.promptValidationRecovery).toHaveBeenCalledOnce();
    expect(deps.promptValidationRecovery).toHaveBeenCalledWith("Local vLLM", recovery, null, null);
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("returns to provider selection after an interactive route failure", async () => {
    const setInferenceRoute = vi.fn(async () => ({
      ok: false as const,
      ambiguous: false,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
        exitCode: 6,
        message: "select another",
      },
    }));
    const deps = createDeps({
      inferenceRouteMutator: { setInferenceRoute },
      promptValidationRecovery: vi.fn(async () => "selection" as const),
    });

    await expect(
      createLocalInferenceRouteApplier(deps)("ollama-local", "qwen3.5:9b"),
    ).resolves.toBe(true);

    expect(setInferenceRoute).toHaveBeenCalledOnce();
    expect(deps.promptValidationRecovery).toHaveBeenCalledOnce();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("stops without retrying when the route result is unknown", async () => {
    const setInferenceRoute = vi.fn(async () => ({
      ok: false as const,
      ambiguous: true,
      error: {
        kind: "timeout" as const,
        message: "route result unknown",
      },
    }));
    const deps = createDeps({ inferenceRouteMutator: { setInferenceRoute } });

    await expect(
      createLocalInferenceRouteApplier(deps)("ollama-local", "qwen3.5:9b"),
    ).rejects.toEqual(new ExitError(1));

    expect(setInferenceRoute).toHaveBeenCalledOnce();
    expect(deps.promptValidationRecovery).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenLastCalledWith(
      "  The route update result is unknown. Inspect gateway 'nemoclaw' before retrying onboarding.",
    );
  });
});
