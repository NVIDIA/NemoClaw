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

import type { CleanupSandboxServicesDeps } from "../dist/lib/actions/sandbox/destroy.js";
import { cleanupSandboxServices } from "../dist/lib/actions/sandbox/destroy.js";

type SandboxLike = { provider?: string | null } | null;

function buildDeps(sandbox: SandboxLike): {
  deps: Required<Pick<CleanupSandboxServicesDeps, "getSandbox" | "stopAll" | "unloadOllamaModels" | "runOpenshell" | "rmSync">>;
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
    },
  };
}

describe("cleanupSandboxServices Ollama unload (#2717)", () => {
  it("delegates GPU unload to stopAll() exactly once when stopHostServices=true", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    cleanupSandboxServices(
      "regression-2717",
      { stopHostServices: true },
      harness.deps,
    );

    expect(harness.deps.stopAll).toHaveBeenCalledTimes(1);
    expect(harness.stopAllCalls[0]).toEqual({ sandboxName: "regression-2717" });
    // stopAll() invokes unloadOllamaModels() internally — see services.ts.
    // cleanupSandboxServices itself must not call it again.
    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.unloadCalls).toBe(0);
  });

  it("calls unloadOllamaModels() exactly once for an Ollama sandbox when stopHostServices=false", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    cleanupSandboxServices(
      "regression-2717",
      { stopHostServices: false },
      harness.deps,
    );

    expect(harness.deps.stopAll).not.toHaveBeenCalled();
    expect(harness.deps.unloadOllamaModels).toHaveBeenCalledTimes(1);
    expect(harness.unloadCalls).toBe(1);
  });

  it("skips unloadOllamaModels() entirely for non-Ollama providers", () => {
    const harness = buildDeps({ provider: "nvidia-prod" });

    cleanupSandboxServices(
      "regression-2717",
      { stopHostServices: false },
      harness.deps,
    );

    expect(harness.deps.stopAll).not.toHaveBeenCalled();
    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("removes the sandbox PID dir and tears down all messaging providers", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    cleanupSandboxServices(
      "regression-2717",
      { stopHostServices: false },
      harness.deps,
    );

    expect(harness.deps.rmSync).toHaveBeenCalledWith(
      path.join("/tmp", "nemoclaw-services-regression-2717"),
      { recursive: true, force: true },
    );

    const providerDeleteCalls = vi
      .mocked(harness.deps.runOpenshell)
      .mock.calls.map((args) => args[0])
      .filter((argv) => argv[0] === "provider" && argv[1] === "delete");
    expect(providerDeleteCalls.map((argv) => argv[2])).toEqual([
      "regression-2717-telegram-bridge",
      "regression-2717-discord-bridge",
      "regression-2717-slack-bridge",
      "regression-2717-slack-app",
    ]);
  });
});
