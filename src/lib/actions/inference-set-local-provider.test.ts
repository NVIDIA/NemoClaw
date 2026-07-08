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

  it("forces --no-verify for a local provider whose host validation passes", async () => {
    const deps = createDeps({ config: localConfig(), session: baseSession() });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b" }, deps);

    expect(deps.calls.validateLocalProvider).toHaveBeenCalledWith("ollama-local");
    const args = deps.calls.captureOpenshell.mock.calls[0][0] as string[];
    expect(args).toContain("--no-verify");
    expect(deps.calls.ensureLocalProviderReachable).not.toHaveBeenCalled();
  });

  it("warns and proceeds with --no-verify when the host stack is reachable despite a failed probe", async () => {
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
    const args = deps.calls.captureOpenshell.mock.calls[0][0] as string[];
    expect(args).toContain("--no-verify");
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

  it("does not run local validation or force --no-verify for cloud providers", async () => {
    const deps = createDeps({
      config: localConfig(),
      session: baseSession(),
    });

    await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b" },
      deps,
    );

    expect(deps.calls.validateLocalProvider).not.toHaveBeenCalled();
    expect(deps.calls.ensureLocalProviderReachable).not.toHaveBeenCalled();
    const args = deps.calls.captureOpenshell.mock.calls[0][0] as string[];
    expect(args).not.toContain("--no-verify");
  });
});
