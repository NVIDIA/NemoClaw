// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

describe("runInferenceSet local-provider verification", () => {
  const localConfig = (): ConfigObject => ({
    agents: { defaults: { model: { primary: "inference/qwen2.5:7b" } } },
    models: {
      providers: {
        inference: {
          api: "openai-completions",
          models: [{ id: "qwen2.5:7b", name: "inference/qwen2.5:7b" }],
        },
      },
    },
  });

  it("uses a native sandbox request without changing the gateway route (#12558)", async () => {
    const deps = createDeps({ config: localConfig(), session: baseSession() });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b" }, deps);

    expect(deps.calls.validateLocalProvider).toHaveBeenCalledWith("ollama-local");
    expect(deps.calls.captureOpenshell.mock.calls.some(([args]) => args[0] === "inference")).toBe(
      false,
    );
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        nativeLocalProviderAttachment: expect.objectContaining({
          endpointUrl: "http://host.openshell.internal:11435/v1",
        }),
      }),
    );
    expect(deps.calls.ensureLocalProviderReachable).not.toHaveBeenCalled();
  });

  it("normalizes the underscore provider spelling before the local-provider branch (#11369)", async () => {
    // The reporter's exact input `ollama_local` must reach the local-provider
    // path as the canonical `ollama-local`, so host validation and the OpenShell
    // selection both use the normalized name (not the underscore spelling).
    const deps = createDeps({ config: localConfig(), session: baseSession() });

    await runInferenceSet({ provider: "ollama_local", model: "qwen2.5:7b" }, deps);

    expect(deps.calls.validateLocalProvider).toHaveBeenCalledWith("ollama-local");
    const openshellArgs = deps.calls.captureOpenshell.mock.calls
      .map((call) => call[0])
      .flat()
      .map(String);
    expect(openshellArgs).not.toContain("inference");
    expect(openshellArgs).not.toContain("ollama_local");
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ provider: "ollama-local" }),
    );
  });

  it("requires a sandbox-native probe when host reachability recovers (#12558)", async () => {
    const deps = createDeps({
      config: localConfig(),
      session: baseSession(),
      localValidation: {
        ok: false,
        message: "Local Ollama is responding on 127.0.0.1, but the container check failed.",
        diagnostic: "add-host probe timed out",
      },
      localReachable: true,
    });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b" }, deps);

    expect(deps.calls.ensureLocalProviderReachable).toHaveBeenCalledWith("ollama-local");
    expect(deps.calls.captureOpenshell.mock.calls.some(([args]) => args[0] === "inference")).toBe(
      false,
    );
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        nativeLocalProviderAttachment: expect.objectContaining({
          endpointUrl: "http://host.openshell.internal:11435/v1",
        }),
      }),
    );
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/reachable/);
  });

  it("aborts without touching the route when the host stack is unreachable", async () => {
    const deps = createDeps({
      config: localConfig(),
      session: baseSession(),
      localValidation: {
        ok: false,
        message: "Local Ollama was selected, but nothing is responding on http://127.0.0.1:11434.",
      },
      localReachable: false,
    });

    await expect(
      runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b" }, deps),
    ).rejects.toThrow(/Cannot reach local provider 'ollama-local'/);
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not change selection when the gateway prerequisite is missing (#12558)", async () => {
    const deps = createDeps({ config: localConfig(), session: baseSession() });
    deps.requireNativeProviderPolicy = async () => {
      throw new Error("composition disabled");
    };
    await expect(
      runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b" }, deps),
    ).rejects.toThrow("composition disabled");
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("does not run local validation or force --no-verify for cloud providers", async () => {
    const deps = createDeps({
      config: localConfig(),
      session: baseSession(),
    });

    await runInferenceSet({ provider: "openai-api", model: "gpt-5.4-mini" }, deps);

    expect(deps.calls.validateLocalProvider).not.toHaveBeenCalled();
    expect(deps.calls.ensureLocalProviderReachable).not.toHaveBeenCalled();
    const args = deps.calls.captureOpenshell.mock.calls[0][0] as string[];
    expect(args).not.toContain("--no-verify");
  });
});
