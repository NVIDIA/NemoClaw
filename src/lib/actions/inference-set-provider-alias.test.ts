// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression coverage for #6321:
//   Facet 1 — `inference set --provider anthropicCompatible` (the installer
//     name onboard accepts) was rejected as unsupported; only the OpenShell
//     name `compatible-anthropic-endpoint` was accepted. The two commands
//     used different vocabularies for the same provider.
//   Facet 3 — `inference set` on a Deep Agents (dcode /
//     langchain-deepagents-code) sandbox refused with a blunt message and no
//     next step. dcode bakes its model at image-build time, so the fix is an
//     actionable error pointing at re-onboard.

import { describe, expect, it } from "vitest";
import {
  INFERENCE_SET_INSTALLER_PROVIDER_ALIASES,
  INFERENCE_SET_SUPPORTED_PROVIDER_NAMES,
  normalizeInferenceSetProvider,
  runInferenceSet,
} from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

describe("normalizeInferenceSetProvider — facet 1 provider-name drift (#6321)", () => {
  it("maps the installer name onboard uses to its OpenShell provider name", () => {
    expect(normalizeInferenceSetProvider("anthropicCompatible")).toBe(
      "compatible-anthropic-endpoint",
    );
    expect(normalizeInferenceSetProvider("build")).toBe("nvidia-prod");
    expect(normalizeInferenceSetProvider("openai")).toBe("openai-api");
    expect(normalizeInferenceSetProvider("custom")).toBe("compatible-endpoint");
    expect(normalizeInferenceSetProvider("ollama")).toBe("ollama-local");
  });

  it("is case-insensitive and trims whitespace on the installer key", () => {
    expect(normalizeInferenceSetProvider("  AnthropicCompatible  ")).toBe(
      "compatible-anthropic-endpoint",
    );
    expect(normalizeInferenceSetProvider("BUILD")).toBe("nvidia-prod");
  });

  it("passes OpenShell provider names through unchanged", () => {
    for (const name of INFERENCE_SET_SUPPORTED_PROVIDER_NAMES) {
      expect(normalizeInferenceSetProvider(name)).toBe(name);
    }
  });

  it("passes an unrecognized provider through unchanged (validation still rejects it later)", () => {
    expect(normalizeInferenceSetProvider("totally-made-up")).toBe("totally-made-up");
  });

  it("every installer alias resolves to a supported OpenShell provider name (drift guard)", () => {
    const supported = new Set<string>(INFERENCE_SET_SUPPORTED_PROVIDER_NAMES);
    for (const [alias, resolved] of Object.entries(INFERENCE_SET_INSTALLER_PROVIDER_ALIASES)) {
      expect(
        supported.has(resolved),
        `${alias} -> ${resolved} not in SUPPORTED_PROVIDER_NAMES`,
      ).toBe(true);
    }
  });
});

describe("runInferenceSet accepts the installer provider name — facet 1 (#6321)", () => {
  it("does not reject `anthropicCompatible` as unsupported", async () => {
    // Reporter's exact command shape: onboard with anthropicCompatible, then
    // switch with the same name. The provider must normalize to
    // compatible-anthropic-endpoint and reuse durable endpoint metadata rather
    // than hit "Unsupported provider 'anthropicCompatible'".
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/anthropic/model-a" } } },
        models: { providers: { inference: { api: "anthropic-messages", models: [] } } },
      },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic/model-a",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      },
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "anthropic/model-a",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    });

    await expect(
      runInferenceSet(
        { provider: "anthropicCompatible", model: "anthropic/model-b", noVerify: true },
        deps,
      ),
    ).resolves.toBeTruthy();

    // The persisted provider must be the normalized OpenShell name, not the
    // installer alias, so the sandbox registry stays canonical.
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({ provider: "compatible-anthropic-endpoint" }),
    ]);
  });

  it("still rejects a genuinely unsupported provider name", async () => {
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: { name: "alpha", agent: "openclaw" },
    });
    await expect(
      runInferenceSet({ provider: "totally-made-up", model: "nvidia/model-a" }, deps),
    ).rejects.toThrow(/Unsupported provider 'totally-made-up'/);
  });
});

describe("runInferenceSet dcode refusal message — facet 3 (#6321)", () => {
  it("points Deep Agents users at re-onboard instead of a dead-end refusal", async () => {
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: { name: "dcode-sb", agent: "langchain-deepagents-code" },
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-a", sandboxName: "dcode-sb" },
        deps,
      ),
    ).rejects.toThrow(/re-onboard with the new selection/);

    // The message keeps the original "supports OpenClaw and Hermes" statement
    // for compatibility with anything matching on it, and adds the dcode hint.
    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-a", sandboxName: "dcode-sb" },
        deps,
      ),
    ).rejects.toThrow(/supports OpenClaw and Hermes sandboxes/);
  });

  it("does NOT add the dcode hint for other unsupported agents", async () => {
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: { name: "spark-sb", agent: "spark" },
    });
    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-a", sandboxName: "spark-sb" },
        deps,
      ),
    ).rejects.toThrow(/supports OpenClaw and Hermes sandboxes; 'spark-sb' uses 'spark'\.$/);
  });
});
