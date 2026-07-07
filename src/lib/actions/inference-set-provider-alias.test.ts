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

import { describe, expect, it, vi } from "vitest";
import type { ConfigValue } from "../security/credential-filter";
import {
  INFERENCE_SET_INSTALLER_PROVIDER_ALIASES,
  INFERENCE_SET_SUPPORTED_PROVIDER_NAMES,
  normalizeInferenceSetProvider,
  runInferenceSet,
} from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

// onboard's provider config is the source of truth the local alias map must
// stay in sync with. Imported here (test only — not into the inference-set hot
// path) to drive the parity check below. providers.ts is a CJS module.
import * as onboardProvidersNs from "../onboard/providers";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const onboardProviders: any =
  (onboardProvidersNs as unknown as { default?: unknown }).default ?? onboardProvidersNs;

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

describe("runInferenceSet SSRF-block guidance — facet 2 (#6321)", () => {
  // A stand-in DNS-pinning guard: rejects any URL whose host resolves internal
  // (mirrors rewriteConfigUrlsWithDnsPinning blocking an RFC1918 address).
  function ssrfGuard() {
    return vi.fn(async (value: ConfigValue): Promise<ConfigValue> => {
      if (String(value).includes("inference-api.nvidia.com") || String(value).includes("10.")) {
        throw new Error(
          `URL hostname "inference-api.nvidia.com" resolves to private/internal address "10.48.203.205". This could expose internal services to the sandbox.`,
        );
      }
      return value;
    });
  }

  it("keeps the SSRF guard AND adds an actionable hint when the sandbox is already on this provider", async () => {
    // The reporter's case: a sandbox onboarded on compatible-endpoint against an
    // internal Hub. `inference set --endpoint-url <internal>` still (correctly)
    // trips the SSRF guard — but the message now tells the operator they can
    // omit --endpoint-url to switch only the model.
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "nvidia/model-a",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      rewriteConfigUrlsWithDnsPinning: ssrfGuard(),
    });

    const attempt = runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "nvidia/model-b",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        noVerify: true,
      },
      deps,
    );
    // Guard still fires (no security relaxation) ...
    await expect(attempt).rejects.toThrow(
      /endpoint-url is not allowed:.*private\/internal address/,
    );
    // ... but the message now guides toward the working same-provider path.
    await expect(attempt).rejects.toThrow(/already configured for 'compatible-endpoint'/);
    await expect(attempt).rejects.toThrow(/omit --endpoint-url/);
  });

  it("switches the model WITHOUT --endpoint-url on a same-provider sandbox (the guided path works, guard never runs)", async () => {
    // Proves the hint's advice is real: dropping --endpoint-url reuses the
    // established route and the model switch succeeds without touching the guard.
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
        models: { providers: { inference: { api: "openai-completions", models: [] } } },
      },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "nvidia/model-a",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      rewriteConfigUrlsWithDnsPinning: ssrfGuard(),
    });

    await expect(
      runInferenceSet(
        { provider: "compatible-endpoint", model: "nvidia/model-b", noVerify: true },
        deps,
      ),
    ).resolves.toBeTruthy();
    // No --endpoint-url supplied → the SSRF guard is never consulted.
    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
  });

  it("does NOT add the same-provider hint when switching to a DIFFERENT provider (bare SSRF error stands)", async () => {
    // entry.provider is nvidia-prod; the operator is switching to
    // compatible-endpoint with an internal URL. There is no established route to
    // fall back to, so the guard's bare message stands with no "omit" hint.
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      rewriteConfigUrlsWithDnsPinning: ssrfGuard(),
    });

    const attempt = runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "nvidia/model-b",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        noVerify: true,
      },
      deps,
    );
    await expect(attempt).rejects.toThrow(
      /endpoint-url is not allowed:.*private\/internal address/,
    );
    await expect(attempt).rejects.not.toThrow(/omit --endpoint-url/);
  });
});

describe("installer alias parity with onboard provider config — facet 1 drift guard (#6321)", () => {
  it("matches onboard's getEffectiveProviderName for every shared provider key", () => {
    // Bind the local alias map to onboard's source of truth: for every installer
    // key onboard accepts that resolves to a provider inference set supports,
    // normalizeInferenceSetProvider must produce the exact same OpenShell name.
    // If onboard renames a provider or adds an alias, this fails until the local
    // map is updated — closing the drift gap CodeRabbit / the PR advisor flagged.
    const supported = new Set<string>(INFERENCE_SET_SUPPORTED_PROVIDER_NAMES);
    const aliasKeys: string[] = Object.keys(
      onboardProviders.NON_INTERACTIVE_PROVIDER_ALIASES ?? {},
    );
    const directKeys: string[] = Array.from(
      (onboardProviders.NON_INTERACTIVE_PROVIDER_KEYS ?? new Set()) as Iterable<string>,
    );
    const onboardKeys = [...new Set([...aliasKeys, ...directKeys])];
    // Sanity: onboard exposes a non-trivial key set (guards against an import
    // that silently resolved to an empty object).
    expect(onboardKeys.length).toBeGreaterThan(5);

    const checked: string[] = [];
    for (const key of onboardKeys) {
      const canonical = onboardProviders.NON_INTERACTIVE_PROVIDER_ALIASES?.[key] ?? key;
      const onboardResolved: string | null = onboardProviders.getEffectiveProviderName(canonical);
      if (!onboardResolved || !supported.has(onboardResolved)) continue; // not an inference-set target
      checked.push(key);
      expect(
        normalizeInferenceSetProvider(key),
        `inference set must map onboard key '${key}' to '${onboardResolved}'`,
      ).toBe(onboardResolved);
    }
    // We actually exercised a meaningful set (anthropicCompatible, build, etc.).
    expect(checked.length).toBeGreaterThan(3);
  });
});
