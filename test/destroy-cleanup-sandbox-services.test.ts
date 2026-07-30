// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guard for #2717: cleanupSandboxServices must invoke
// `unloadOllamaModels()` exactly once across both branches of the destroy
// flow — never zero (orphans GPU memory) and never twice (the original
// duplicate-call bug). Mirrors the structural argument captured in the
// inline comments in `src/lib/actions/sandbox/destroy.ts`.

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CleanupSandboxServicesDeps } from "../src/lib/actions/sandbox/destroy.js";
import { cleanupSandboxServices } from "../src/lib/actions/sandbox/destroy.js";
import { SANDBOX_PROVIDER_SUFFIXES } from "../src/lib/onboard/sandbox-provider-cleanup.js";

type SandboxLike = {
  provider?: string | null;
  agent?: string | null;
  hermesInferenceProvider?: string;
  hermesToolGateways?: string[];
} | null;

function buildDeps(sandbox: SandboxLike): {
  deps: Required<
    Pick<
      CleanupSandboxServicesDeps,
      | "getSandbox"
      | "stopAll"
      | "unloadOllamaModels"
      | "runOpenshell"
      | "rmSync"
      | "removeHermesToolGatewayProviderState"
      | "warn"
    >
  >;
  stopAllCalls: Array<{ sandboxName: string }>;
  unloadCalls: number;
} {
  const stopAllCalls: Array<{ sandboxName: string }> = [];
  let unloadCalls = 0;
  return {
    stopAllCalls,
    get unloadCalls() {
      return unloadCalls;
    },
    deps: {
      getSandbox: vi.fn(() => sandbox as never),
      stopAll: vi.fn((opts: { sandboxName: string }) => {
        stopAllCalls.push(opts);
      }),
      unloadOllamaModels: vi.fn(() => {
        unloadCalls += 1;
      }),
      runOpenshell: vi.fn(() => ({ status: 0 })),
      rmSync: vi.fn(),
      removeHermesToolGatewayProviderState: vi.fn(() => true),
      warn: vi.fn(),
    },
  };
}

describe("cleanupSandboxServices Ollama unload (#2717)", () => {
  it("delegates GPU unload to stopAll() exactly once when stopHostServices=true", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    cleanupSandboxServices("regression-2717", { stopHostServices: true }, harness.deps);

    expect(harness.deps.stopAll).toHaveBeenCalledTimes(1);
    expect(harness.stopAllCalls[0]).toEqual({ sandboxName: "regression-2717" });
    // stopAll() invokes unloadOllamaModels() internally — see services.ts.
    // cleanupSandboxServices itself must not call it again.
    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.unloadCalls).toBe(0);
  });

  it("calls unloadOllamaModels() exactly once for an Ollama sandbox when stopHostServices=false", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps);

    expect(harness.deps.stopAll).not.toHaveBeenCalled();
    expect(harness.deps.unloadOllamaModels).toHaveBeenCalledTimes(1);
    expect(harness.unloadCalls).toBe(1);
  });

  it("skips unloadOllamaModels() entirely for non-Ollama providers", () => {
    const harness = buildDeps({ provider: "nvidia-prod" });

    cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps);

    expect(harness.deps.stopAll).not.toHaveBeenCalled();
    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("removes the sandbox PID dir and tears down all messaging providers", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps);

    expect(harness.deps.rmSync).toHaveBeenCalledWith(
      path.join("/tmp", "nemoclaw-services-regression-2717"),
      { recursive: true, force: true },
    );

    const providerDeleteCalls = vi
      .mocked(harness.deps.runOpenshell)
      .mock.calls.map((args) => args[0])
      .filter((argv) => argv[0] === "provider" && argv[1] === "delete");
    expect(providerDeleteCalls.map((argv) => argv[2])).toEqual(
      SANDBOX_PROVIDER_SUFFIXES.map((suffix) => `regression-2717-${suffix}`),
    );
  });

  it("removes both Hermes providers and identity-bound broker state after terminal cleanup", () => {
    const harness = buildDeps({
      provider: "hermes-provider",
      agent: "hermes",
      hermesInferenceProvider: "hermes-clone-hermes-inference",
      hermesToolGateways: ["nous-web"],
    });

    const result = cleanupSandboxServices(
      "hermes-clone",
      { stopHostServices: false },
      harness.deps,
    );

    const providerDeleteCalls = vi
      .mocked(harness.deps.runOpenshell)
      .mock.calls.map((args) => args[0].join(" "));
    expect(providerDeleteCalls).toContain("provider delete hermes-clone-hermes-inference");
    expect(providerDeleteCalls).toContain("provider delete hermes-clone-hermes-tool-gateway");
    expect(harness.deps.removeHermesToolGatewayProviderState).toHaveBeenCalledExactlyOnceWith(
      "hermes-clone",
    );
    expect(result).toEqual({
      identityBoundCleanupCompleted: true,
      identityBoundCleanupRequired: true,
    });
  });

  it("preserves Hermes broker state when provider cleanup fails", () => {
    const harness = buildDeps({
      provider: "hermes-provider",
      agent: "hermes",
      hermesInferenceProvider: "hermes-clone-hermes-inference",
      hermesToolGateways: ["nous-web"],
    });
    vi.mocked(harness.deps.runOpenshell).mockImplementation((args) =>
      args[2] === "hermes-clone-hermes-inference"
        ? { status: 1, stderr: "gateway transport unavailable" }
        : { status: 0 },
    );

    const result = cleanupSandboxServices(
      "hermes-clone",
      { stopHostServices: false },
      harness.deps,
    );

    expect(harness.deps.removeHermesToolGatewayProviderState).not.toHaveBeenCalled();
    expect(harness.deps.warn).toHaveBeenCalledWith(
      expect.stringContaining("preserving broker state for recovery"),
    );
    expect(result).toEqual({
      identityBoundCleanupCompleted: false,
      identityBoundCleanupRequired: true,
    });
  });

  it("rejects a truncated exact-NotFound prefix during Hermes cleanup", () => {
    const harness = buildDeps({
      provider: "hermes-provider",
      agent: "hermes",
      hermesInferenceProvider: "hermes-clone-hermes-inference",
      hermesToolGateways: ["nous-web"],
    });
    vi.mocked(harness.deps.runOpenshell).mockImplementation((args) =>
      args[2] === "hermes-clone-hermes-inference"
        ? {
            status: 1,
            stderr:
              "provider 'hermes-clone-hermes-inference' not found\n" +
              "x".repeat(64 * 1024) +
              "\nauthentication failed",
          }
        : { status: 0 },
    );

    const result = cleanupSandboxServices(
      "hermes-clone",
      { stopHostServices: false },
      harness.deps,
    );

    expect(result.identityBoundCleanupCompleted).toBe(false);
    expect(harness.deps.removeHermesToolGatewayProviderState).not.toHaveBeenCalled();
  });

  it("preserves Hermes broker state when gateway deletion was not confirmed", () => {
    const harness = buildDeps({
      provider: "hermes-provider",
      agent: "hermes",
      hermesInferenceProvider: "hermes-clone-hermes-inference",
      hermesToolGateways: ["nous-web"],
    });

    cleanupSandboxServices(
      "hermes-clone",
      { stopHostServices: false, removeIdentityBoundState: false },
      harness.deps,
    );

    expect(harness.deps.removeHermesToolGatewayProviderState).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(harness.deps.runOpenshell)
        .mock.calls.some(
          ([args]) =>
            args[0] === "provider" &&
            args[1] === "delete" &&
            (args[2]?.endsWith("-hermes-inference") || args[2]?.endsWith("-hermes-tool-gateway")),
        ),
    ).toBe(false);
  });

  it("rejects traversal-shaped sandbox names before any cleanup side effect", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    expect(() =>
      cleanupSandboxServices("x/../../victim", { stopHostServices: true }, harness.deps),
    ).toThrow("Invalid sandbox name");

    expect(harness.deps.getSandbox).not.toHaveBeenCalled();
    expect(harness.deps.stopAll).not.toHaveBeenCalled();
    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.deps.rmSync).not.toHaveBeenCalled();
    expect(harness.deps.runOpenshell).not.toHaveBeenCalled();
  });
});
