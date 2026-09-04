// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guard for #2717: cleanupSandboxServices must invoke
// `unloadOllamaModels()` exactly once across both branches when the sandbox
// owns Ollama cleanup work, and never for an unrelated provider. This avoids
// both orphaned GPU memory and the original duplicate-call bug.

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CleanupSandboxServicesDeps } from "../../../src/lib/actions/sandbox/destroy.js";
import { cleanupSandboxServices } from "../../../src/lib/actions/sandbox/destroy.js";
import { ollamaModelRefsMatch } from "../../../src/lib/inference/ollama/model-discovery.js";
import type { OllamaUnloadResult } from "../../../src/lib/inference/ollama/proxy.js";
import { SANDBOX_PROVIDER_SUFFIXES } from "../../../src/lib/onboard/sandbox-provider-cleanup.js";

type SandboxLike = { name?: string; model?: string | null; provider?: string | null } | null;
type StopAllOptions = {
  sandboxName: string;
  cleanupOllamaModels?: boolean;
  unloadOllamaModels?: () => OllamaUnloadResult | void;
};

function buildDeps(
  sandbox: SandboxLike,
  peers: Exclude<SandboxLike, null>[] = [],
): {
  deps: Required<
    Pick<
      CleanupSandboxServicesDeps,
      | "getSandbox"
      | "listSandboxes"
      | "stopAll"
      | "unloadOllamaModels"
      | "loadPendingOllamaModelCleanup"
      | "clearPendingOllamaModelCleanup"
      | "withOllamaModelOwnershipLock"
      | "ollamaModelRefsMatch"
      | "runOpenshell"
      | "rmSync"
      | "stopGooglechatWebhookTunnel"
      | "googlechatWebhookTunnelPidDir"
    >
  >;
  stopAllCalls: StopAllOptions[];
  unloadCalls: number;
  unloadArgs: Array<readonly string[] | undefined>;
} {
  const stopAllCalls: StopAllOptions[] = [];
  const target = sandbox
    ? { name: "regression-2717", model: "target-model:latest", ...sandbox }
    : null;
  let unloadCalls = 0;
  const unloadArgs: Array<readonly string[] | undefined> = [];
  return {
    stopAllCalls,
    unloadArgs,
    get unloadCalls() {
      return unloadCalls;
    },
    deps: {
      getSandbox: vi.fn(() => target as never),
      listSandboxes: vi.fn(() => ({
        sandboxes: [...(target ? [target] : []), ...peers] as never,
        defaultSandbox: null,
      })),
      stopAll: vi.fn((opts: StopAllOptions) => {
        stopAllCalls.push(opts);
        return opts.cleanupOllamaModels === false ? undefined : opts.unloadOllamaModels?.();
      }),
      unloadOllamaModels: vi.fn((onlyModels?: readonly string[]) => {
        unloadCalls += 1;
        unloadArgs.push(onlyModels);
      }),
      loadPendingOllamaModelCleanup: vi.fn(() => []),
      clearPendingOllamaModelCleanup: vi.fn(),
      withOllamaModelOwnershipLock: (operation) => operation(),
      ollamaModelRefsMatch,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      rmSync: vi.fn(),
      stopGooglechatWebhookTunnel: vi.fn(() => "/tmp/nemoclaw-services-regression-2717-googlechat"),
      googlechatWebhookTunnelPidDir: vi.fn((pidDir) => `${pidDir}-googlechat`),
    },
  };
}

describe("cleanupSandboxServices Ollama unload (#2717)", () => {
  const cleanupFailure = {
    ok: false as const,
    outcome: "discovery-failed" as const,
    endpoint: "http://host.docker.internal:11434",
    selectedModels: [],
    discoveries: [],
    requests: [],
    message: "could not connect",
  };

  it("delegates GPU unload to stopAll() exactly once when stopHostServices=true", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    cleanupSandboxServices("regression-2717", { stopHostServices: true }, harness.deps);

    expect(harness.deps.stopAll).toHaveBeenCalledTimes(1);
    expect(harness.stopAllCalls[0]).toEqual(
      expect.objectContaining({
        sandboxName: "regression-2717",
        cleanupOllamaModels: true,
        unloadOllamaModels: expect.any(Function),
      }),
    );
    expect(harness.deps.unloadOllamaModels).toHaveBeenCalledOnce();
    expect(harness.unloadCalls).toBe(1);
  });

  it("skips host-wide Ollama discovery for a final sandbox with no Ollama ownership", () => {
    const harness = buildDeps({ provider: "nvidia-prod" });

    cleanupSandboxServices("regression-2717", { stopHostServices: true }, harness.deps);

    expect(harness.stopAllCalls).toEqual([
      expect.objectContaining({
        sandboxName: "regression-2717",
        cleanupOllamaModels: false,
        unloadOllamaModels: expect.any(Function),
      }),
    ]);
    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("keeps host-wide Ollama cleanup enabled for retained model recovery", () => {
    const harness = buildDeps({ provider: "nvidia-prod" });
    vi.mocked(harness.deps.loadPendingOllamaModelCleanup).mockReturnValue(["old-model"]);

    cleanupSandboxServices("regression-2717", { stopHostServices: true }, harness.deps);

    expect(harness.stopAllCalls).toEqual([
      expect.objectContaining({
        sandboxName: "regression-2717",
        cleanupOllamaModels: true,
        unloadOllamaModels: expect.any(Function),
      }),
    ]);
    expect(harness.deps.unloadOllamaModels).toHaveBeenCalledOnce();
  });

  it("holds model ownership while final host-wide cleanup runs", () => {
    const harness = buildDeps({ provider: "ollama-local" });
    let ownershipHeld = false;
    harness.deps.withOllamaModelOwnershipLock = vi.fn((operation) => {
      ownershipHeld = true;
      try {
        return operation();
      } finally {
        ownershipHeld = false;
      }
    });
    vi.mocked(harness.deps.unloadOllamaModels).mockImplementation(() => {
      expect(ownershipHeld).toBe(true);
    });

    cleanupSandboxServices("regression-2717", { stopHostServices: true }, harness.deps);

    expect(harness.deps.stopAll).toHaveBeenCalledOnce();
    expect(harness.deps.unloadOllamaModels).toHaveBeenCalledOnce();
    expect(ownershipHeld).toBe(false);
  });

  it("calls unloadOllamaModels() exactly once for an Ollama sandbox when stopHostServices=false", () => {
    const harness = buildDeps({ provider: "ollama-local" });

    cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps);

    expect(harness.deps.stopAll).not.toHaveBeenCalled();
    expect(harness.deps.unloadOllamaModels).toHaveBeenCalledTimes(1);
    expect(harness.unloadArgs).toEqual([["target-model:latest"]]);
    expect(harness.unloadCalls).toBe(1);
  });

  it("releases only the destroyed sandbox model when another Ollama sandbox uses a different model", () => {
    const harness = buildDeps({ provider: "ollama-local", model: "target-model:latest" }, [
      { name: "peer", provider: "ollama-local", model: "peer-model:latest" },
    ]);

    cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps);

    expect(harness.unloadArgs).toEqual([["target-model:latest"]]);
  });

  it("keeps a model that another Ollama sandbox shares", () => {
    const harness = buildDeps({ provider: "ollama-local", model: "shared-model" }, [
      { name: "peer", provider: "ollama-local", model: "shared-model:latest" },
    ]);

    cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps);

    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
  });

  it("retries a pending superseded model after the sandbox route changes", () => {
    const harness = buildDeps({ provider: "nvidia-prod", model: "new-model" });
    vi.mocked(harness.deps.loadPendingOllamaModelCleanup).mockReturnValue(["old-model"]);

    cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps);

    expect(harness.unloadArgs).toEqual([["old-model"]]);
    expect(harness.deps.clearPendingOllamaModelCleanup).toHaveBeenCalledWith("regression-2717", [
      "old-model",
    ]);
  });

  it("keeps a pending superseded model that an Ollama peer shares", () => {
    const harness = buildDeps({ provider: "nvidia-prod", model: "new-model" }, [
      { name: "peer", provider: "ollama-local", model: "old-model:latest" },
    ]);
    vi.mocked(harness.deps.loadPendingOllamaModelCleanup).mockReturnValue(["old-model"]);

    cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps);

    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.deps.clearPendingOllamaModelCleanup).not.toHaveBeenCalled();
  });

  it("preserves destroy recovery state when stopAll cannot release Ollama", () => {
    const harness = buildDeps({ provider: "ollama-local" });
    vi.mocked(harness.deps.stopAll).mockReturnValue(cleanupFailure);

    expect(() =>
      cleanupSandboxServices("regression-2717", { stopHostServices: true }, harness.deps),
    ).toThrow(/saved route were retained.*retry destroy/);
    expect(harness.deps.rmSync).not.toHaveBeenCalled();
  });

  it("preserves destroy recovery state when stopAll throws unexpectedly (#10553)", () => {
    const harness = buildDeps({ provider: "ollama-local" });
    const stopError = new Error(`unexpected cleanup failure ${"detail ".repeat(100)}`);
    vi.mocked(harness.deps.stopAll).mockImplementation(() => {
      throw stopError;
    });

    let thrown: unknown;
    try {
      cleanupSandboxServices("regression-2717", { stopHostServices: true }, harness.deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ cause: stopError });
    expect((thrown as Error).message).toMatch(
      /sandbox 'regression-2717' was deleted.*local registry and cleanup state.*nemoclaw regression-2717 destroy/,
    );
    expect((thrown as Error).message.length).toBeLessThan(700);
    expect(harness.deps.rmSync).not.toHaveBeenCalled();
    expect(harness.deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("preserves destroy recovery state when scoped Ollama release fails", () => {
    const harness = buildDeps({ provider: "ollama-local" });
    vi.mocked(harness.deps.unloadOllamaModels).mockReturnValue(cleanupFailure);

    expect(() =>
      cleanupSandboxServices("regression-2717", { stopHostServices: false }, harness.deps),
    ).toThrow(/saved route were retained.*retry destroy/);
    expect(harness.deps.rmSync).not.toHaveBeenCalled();
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
    expect(harness.deps.stopGooglechatWebhookTunnel).toHaveBeenCalledWith("regression-2717");
    expect(harness.deps.rmSync).toHaveBeenCalledWith(
      path.join("/tmp", "nemoclaw-services-regression-2717-googlechat"),
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

  it("fails closed before other cleanup when the Google Chat tunnel cannot stop", () => {
    const harness = buildDeps({ provider: "ollama-local" });
    vi.mocked(harness.deps.stopGooglechatWebhookTunnel).mockImplementation(() => {
      throw new Error("cloudflared refused to stop");
    });

    expect(() =>
      cleanupSandboxServices("regression-2717", { stopHostServices: true }, harness.deps),
    ).toThrow(/Refusing to finish sandbox cleanup/);

    expect(harness.deps.getSandbox).not.toHaveBeenCalled();
    expect(harness.deps.stopAll).not.toHaveBeenCalled();
    expect(harness.deps.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.deps.rmSync).not.toHaveBeenCalled();
    expect(harness.deps.runOpenshell).not.toHaveBeenCalled();
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
    expect(harness.deps.stopGooglechatWebhookTunnel).not.toHaveBeenCalled();
  });
});
