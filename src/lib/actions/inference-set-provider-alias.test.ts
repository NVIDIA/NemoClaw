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
import { shellQuote } from "../core/shell-quote";
// onboard's provider config is the source of truth the local alias map must
// stay in sync with. Imported here (test only — not into the inference-set hot
// path) to drive the parity check below. providers.ts is a CJS module.
import * as onboardProvidersNs from "../onboard/providers";
import type { ConfigObject } from "../security/credential-filter";
import {
  INFERENCE_SET_INSTALLER_PROVIDER_ALIASES,
  INFERENCE_SET_SUPPORTED_PROVIDER_NAMES,
  normalizeInferenceSetProvider,
  runInferenceSet,
} from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";
import { nativeCompatibleFixture } from "../inference/native-compatible/switch.test-support";

const onboardProviders: any =
  (onboardProvidersNs as unknown as { default?: unknown }).default ?? onboardProvidersNs;

// PRA-2: after a security rejection, `inference set` must not have applied any
// persistence or gateway side effect. Assert every mutation / side-effect dep is
// untouched (readers such as readSandboxConfig are allowed).
function expectNoInferenceMutation(calls: ReturnType<typeof createDeps>["calls"]): void {
  expect(calls.captureOpenshell).not.toHaveBeenCalled();
  expect(calls.updateSandbox).not.toHaveBeenCalled();
  expect(calls.writeSandboxConfig).not.toHaveBeenCalled();
  expect(calls.updateSession).not.toHaveBeenCalled();
  expect(calls.recomputeSandboxConfigHash).not.toHaveBeenCalled();
  expect(calls.restartSandboxGateway).not.toHaveBeenCalled();
}

describe("normalizeInferenceSetProvider — facet 1 provider-name drift (#6321)", () => {
  it("maps the installer name onboard uses to its OpenShell provider name", () => {
    expect(normalizeInferenceSetProvider("anthropicCompatible")).toBe(
      "compatible-anthropic-endpoint",
    );
    expect(normalizeInferenceSetProvider("build")).toBe("nvidia-prod");
    expect(normalizeInferenceSetProvider("openai")).toBe("openai-api");
    expect(normalizeInferenceSetProvider("openrouter")).toBe("openrouter-api");
    expect(normalizeInferenceSetProvider("open-router")).toBe("openrouter-api");
    expect(normalizeInferenceSetProvider("custom")).toBe("compatible-endpoint");
    expect(normalizeInferenceSetProvider("ollama")).toBe("ollama-local");
  });

  it("is case-insensitive and trims whitespace on the installer key", () => {
    expect(normalizeInferenceSetProvider("  AnthropicCompatible  ")).toBe(
      "compatible-anthropic-endpoint",
    );
    expect(normalizeInferenceSetProvider("BUILD")).toBe("nvidia-prod");
  });

  it.each(INFERENCE_SET_SUPPORTED_PROVIDER_NAMES)(
    "passes the OpenShell provider name %s through unchanged",
    (name) => {
      expect(normalizeInferenceSetProvider(name)).toBe(name);
    },
  );

  it("passes an unrecognized provider through unchanged for gateway validation", () => {
    expect(normalizeInferenceSetProvider("totally-made-up")).toBe("totally-made-up");
  });

  // #11369: underscore-spelled provider inputs (installer-style) must normalize
  // to the canonical hyphenated OpenShell provider name, instead of being
  // rejected as unsupported.
  it("normalizes the underscore spelling of a canonical local provider name", () => {
    expect(normalizeInferenceSetProvider("ollama_local")).toBe("ollama-local");
    expect(normalizeInferenceSetProvider("vllm_local")).toBe("vllm-local");
  });

  it("normalizes underscore spellings of other canonical provider names", () => {
    expect(normalizeInferenceSetProvider("nvidia_prod")).toBe("nvidia-prod");
    expect(normalizeInferenceSetProvider("llama_cpp_local")).toBe("llama-cpp-local");
  });

  it("normalizes underscore spellings of installer alias keys", () => {
    expect(normalizeInferenceSetProvider("open_router")).toBe("openrouter-api");
    expect(normalizeInferenceSetProvider("nim_local")).toBe("nvidia-nim");
    expect(normalizeInferenceSetProvider("llama_cpp")).toBe("llama-cpp-local");
    expect(normalizeInferenceSetProvider("nous_portal")).toBe("hermes-provider");
  });

  it("is case-insensitive and trims whitespace on underscore spellings", () => {
    expect(normalizeInferenceSetProvider("  Ollama_Local  ")).toBe("ollama-local");
    expect(normalizeInferenceSetProvider("VLLM_LOCAL")).toBe("vllm-local");
  });

  it("passes an unsupported underscore spelling through unchanged (validation still rejects it)", () => {
    // A made-up name is not rescued by underscore folding; it passes through so
    // downstream validation still rejects it.
    expect(normalizeInferenceSetProvider("totally_made_up")).toBe("totally_made_up");
  });

  it.each([...INFERENCE_SET_SUPPORTED_PROVIDER_NAMES])(
    "normalizes the underscore spelling of canonical name %s back to the hyphenated form",
    (name) => {
      const underscored = name.replaceAll("-", "_");
      expect(normalizeInferenceSetProvider(underscored)).toBe(name);
    },
  );

  it.each(Object.entries(INFERENCE_SET_INSTALLER_PROVIDER_ALIASES))(
    "resolves the %s installer alias to the supported %s provider",
    (alias, resolved) => {
      const supported = new Set<string>(INFERENCE_SET_SUPPORTED_PROVIDER_NAMES);
      expect(
        supported.has(resolved),
        `${alias} -> ${resolved} not in SUPPORTED_PROVIDER_NAMES`,
      ).toBe(true);
    },
  );
});

describe("runInferenceSet accepts the installer provider name — facet 1 (#6321)", () => {
  it("does not reject `anthropicCompatible` as unsupported", async () => {
    // Reporter's exact command shape: onboard with anthropicCompatible, then
    // switch with the same name. The provider must normalize to
    // compatible-anthropic-endpoint and reuse durable endpoint metadata rather
    // than hit "Unsupported provider 'anthropicCompatible'".
    const native = await nativeCompatibleFixture(
      "https://inference-api.nvidia.com/v1",
      "anthropic-messages",
    );
    const deps = createDeps({
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
      config: {
        agents: { defaults: { model: { primary: "inference/anthropic/model-a" } } },
        models: { providers: { inference: { api: "anthropic-messages", models: [] } } },
      },
      entry: {
        nativeCompatibleProviderAttachment: native.receipt,
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
    expect(
      deps.calls.updateSandbox.mock.calls
        .filter(([, fields]) => fields.provider !== undefined)
        .at(-1),
    ).toEqual(["alpha", expect.objectContaining({ provider: "compatible-anthropic-endpoint" })]);
  });

  it("still rejects a genuinely unsupported provider name", async () => {
    const output =
      "nvidia-prod\nqa-non-inference\ncompatible-endpoint\nllama-cpp-local\nollama-local\n";
    const captureOpenshell = vi.fn(() => ({ status: 0, output, stdout: output, stderr: "" }));
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw-18080",
      },
      captureOpenshell,
    });
    await expect(
      runInferenceSet({ provider: "totally-made-up", model: "nvidia/model-a" }, deps),
    ).rejects.toThrow(
      "Unsupported provider 'totally-made-up'. Selectable providers registered on gateway " +
        "'nemoclaw-18080': compatible-endpoint, llama-cpp-local, nvidia-prod, ollama-local, qa-non-inference.",
    );
    expect(captureOpenshell).toHaveBeenCalledWith(
      ["provider", "list", "-g", "nemoclaw-18080", "--names"],
      expect.objectContaining({ timeout: 5_000 }),
    );
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSession).not.toHaveBeenCalled();
    expect(deps.calls.recomputeSandboxConfigHash).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });

  it("accepts an additional registered provider without replacing its native config", async () => {
    const provider = "native-extra";
    const nativeProviderConfig = {
      api: "openai-completions",
      apiKey: "native-owned-reference",
      baseUrl: "https://native.example/v1",
      models: [{ id: "vendor/model-a", name: "vendor/model-a" }],
    };
    const output = `nvidia-prod\n${provider}\n`;
    const captureOpenshell = vi.fn(() => ({ status: 0, output, stdout: output, stderr: "" }));
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: {
        providers: {
          inference: { api: "openai-completions", models: [] },
          [provider]: nativeProviderConfig,
        },
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw-18080",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      captureOpenshell,
    });

    await expect(
      runInferenceSet({ provider, model: "vendor/model-b", noVerify: true }, deps),
    ).resolves.toMatchObject({ provider, model: "vendor/model-b" });

    expect(captureOpenshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "list", "-g", "nemoclaw-18080", "--names"],
      expect.objectContaining({ ignoreError: true, timeout: 5_000 }),
    );
    expect(captureOpenshell).toHaveBeenNthCalledWith(
      2,
      [
        "inference",
        "set",
        "-g",
        "nemoclaw-18080",
        "--no-verify",
        "--provider",
        provider,
        "--model",
        "vendor/model-b",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(captureOpenshell).toHaveBeenCalledTimes(2);
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalledOnce();
    expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalledWith(
      "alpha",
      expect.arrayContaining([
        expect.objectContaining({
          dotpath: "models.providers.inference",
          value: expect.objectContaining({
            models: expect.arrayContaining([expect.objectContaining({ id: "vendor/model-b" })]),
          }),
        }),
      ]),
      "nemoclaw-18080",
    );
    expect(
      deps.calls.updateSandbox.mock.calls
        .filter(([, fields]) => fields.provider !== undefined)
        .at(-1),
    ).toEqual([
      "alpha",
      expect.objectContaining({
        provider,
        endpointUrl: null,
        credentialEnv: null,
      }),
    ]);
  });

  it("uses the scoped native provider and persists the canonical provider instead of its alias (#6321)", async () => {
    const native = await nativeCompatibleFixture(
      "https://inference-api.nvidia.com/v1",
      "anthropic-messages",
    );
    const deps = createDeps({
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
      config: {
        agents: { defaults: { model: { primary: "inference/anthropic/model-a" } } },
        models: { providers: { inference: { api: "anthropic-messages", models: [] } } },
      },
      entry: {
        nativeCompatibleProviderAttachment: native.receipt,
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

    expect(native.adapter.getProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: native.profile.providerName }),
    );
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ provider: "compatible-anthropic-endpoint" }),
    );
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

  it("shell-quotes the sandbox name in the dcode re-onboard hint (#6321)", async () => {
    // The hint embeds the sandbox name inside a copy-pasteable `onboard` command.
    // validateName currently restricts names to a metacharacter-free shape, so
    // shellQuote is defense-in-depth: it must still wrap the name so the command
    // stays safe if a name ever reaches this path unvalidated or the name policy
    // loosens. Lock in that the wrapper is applied (single-quoted form present),
    // not raw interpolation.
    const name = "dcode-sb";
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: { name, agent: "langchain-deepagents-code" },
    });
    const attempt = runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/model-a", sandboxName: name },
      deps,
    );

    // shellQuote always single-quotes, so the hint carries the quoted form.
    // `toThrow(string)` does a substring match on the error message.
    expect(shellQuote(name)).toBe("'dcode-sb'");
    await expect(attempt).rejects.toThrow(`--name ${shellQuote(name)} --fresh`);
    // The bare, unquoted name must not sit directly after --name.
    await expect(attempt).rejects.not.toThrow(`--name ${name} --fresh`);
  });

  // PRA-2: validateName blocks metacharacter names before the recovery hint, so
  // shellQuote is defense-in-depth.
  it.each(["a b", "a'b", "a;b", "a$(id)", "a`id`"])(
    "keeps the metacharacter input %j inside one shell argument",
    (meta) => {
      const quoted = shellQuote(meta);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      // After removing the only legal break-out escape ('\''), no bare single
      // quote remains — nothing can terminate the quoted argument early.
      expect(quoted.slice(1, -1).replaceAll("'\\''", "")).not.toContain("'");
    },
  );
});

describe("native hosted endpoint SSRF validation (#6321)", () => {
  it.each([undefined, "onboard", "inference-set"] as const)(
    "refuses private DNS with endpoint provenance %s before mutation",
    async (endpointSource) => {
      const lookup = vi.fn(async () => [{ address: "10.48.203.205", family: 4 }]);
      const native = await nativeCompatibleFixture("https://inference-api.nvidia.com/v1");
      const deps = createDeps({
        config: {},
        entry: {
          name: "alpha",
          agent: "openclaw",
          nativeCompatibleProviderAttachment: native.receipt,
          provider: "compatible-endpoint",
          model: "old",
          endpointUrl: "https://inference-api.nvidia.com/v1",
          endpointSource,
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
        },
        resolveNativeCompatibleEndpointHost: lookup,
      });
      await expect(
        runInferenceSet(
          {
            provider: "compatible-endpoint",
            model: "new",
            endpointUrl: "https://inference-api.nvidia.com/v1",
            noVerify: true,
          },
          deps,
        ),
      ).rejects.toThrow("hosted endpoint failed network validation");
      expect(lookup).toHaveBeenCalled();
      expectNoInferenceMutation(deps.calls);
    },
  );

  it("refuses a different private endpoint despite onboarding provenance", async () => {
    const native = await nativeCompatibleFixture("https://inference-api.nvidia.com/v1");
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        nativeCompatibleProviderAttachment: native.receipt,
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: "https://inference-api.nvidia.com/v1",
        endpointSource: "onboard",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: "https://10.0.0.5/v1",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toThrow("hosted endpoint failed network validation");
    expectNoInferenceMutation(deps.calls);
  });

  it("reuses a valid owned receipt for a model-only switch without managed route mutation", async () => {
    const native = await nativeCompatibleFixture("https://inference-api.nvidia.com/v1");
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/old" } } },
        models: { providers: { inference: { api: "openai-completions", models: [] } } },
      },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: native.profile.endpoint,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
        nativeCompatibleProviderAttachment: native.receipt,
      },
      providerAdapter: native.providerAdapter,
      resolveNativeCompatibleEndpointHost: native.lookup,
    });
    await expect(
      runInferenceSet({ provider: "compatible-endpoint", model: "new", noVerify: true }, deps),
    ).resolves.toBeTruthy();
    expect(native.lookup).toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ model: "new", nativeCompatibleProviderAttachment: native.receipt }),
    );
  });
});

describe("installer alias parity with onboard provider config — facet 1 drift guard (#6321)", () => {
  const supported = new Set<string>(INFERENCE_SET_SUPPORTED_PROVIDER_NAMES);
  const aliasKeys: string[] = Object.keys(onboardProviders.NON_INTERACTIVE_PROVIDER_ALIASES ?? {});
  const directKeys: string[] = Array.from(
    (onboardProviders.NON_INTERACTIVE_PROVIDER_KEYS ?? new Set()) as Iterable<string>,
  );
  const onboardKeys = [...new Set([...aliasKeys, ...directKeys])];
  const relevant = onboardKeys
    .map((key) => ({
      key,
      onboardResolved: onboardProviders.getEffectiveProviderName(
        onboardProviders.NON_INTERACTIVE_PROVIDER_ALIASES?.[key] ?? key,
      ) as string | null,
    }))
    .filter(
      (entry): entry is { key: string; onboardResolved: string } =>
        !!entry.onboardResolved && supported.has(entry.onboardResolved),
    );

  it("loads a meaningful set of onboard provider keys", () => {
    // Sanity: onboard exposes a non-trivial key set (guards against an import
    // that silently resolved to an empty object).
    expect(onboardKeys.length).toBeGreaterThan(5);
    expect(relevant.length).toBeGreaterThan(3);
  });

  it.each(relevant)(
    "maps the onboard $key key to the $onboardResolved OpenShell provider",
    ({ key, onboardResolved }) => {
      expect(
        normalizeInferenceSetProvider(key),
        `inference set must map onboard key '${key}' to '${onboardResolved}'`,
      ).toBe(onboardResolved);
    },
  );
});
