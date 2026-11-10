// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";

/** Bind the packaged provider APIs; OpenClaw owns discovery and model metadata. */
export function nativeModelCatalogSource(source: string) {
  const entry = (relative: string) =>
    JSON.stringify(path.join(source, "dist", relative).replaceAll("\\", "/"));
  return `
export async function parseNativeConfiguration(text) {
  __nemoPrepareAssetRoot();
  const { l: parseConfigJson5 } = await import(${entry("io.read-helpers-ZKp-UiGx.js")});
  const result = parseConfigJson5(text);
  if (!result.ok || !result.parsed || typeof result.parsed !== "object" || Array.isArray(result.parsed))
    throw Error("The saved OpenClaw configuration is invalid; it has not been overwritten.");
  return result.parsed;
}
export async function buildNativeModelCatalog(inference, baseUrl, apiKey) {
  __nemoPrepareAssetRoot();
  const { t: modelKey } = await import(${entry("model-key-CMdQNkZf.js")});
  const { a: legacyModelKey } = await import(${entry("model-ref-shared-Dz7QU0Lx.js")});
  let provider = "nemoclawNative";
  let configuration;
  if (inference === "nvidia") {
    provider = "nvidia";
    const { buildSelectableLiveNvidiaProvider } = await import(${entry("extensions/nvidia/provider-catalog.js")});
    configuration = await buildSelectableLiveNvidiaProvider();
  } else if (inference === "openrouter") {
    provider = "openrouter";
    const { buildOpenrouterLiveProvider } = await import(${entry("extensions/openrouter/provider-catalog.js")});
    configuration = await buildOpenrouterLiveProvider({ baseUrl, apiKey });
  } else if (inference === "compatible" || inference === "local") {
    const { discoverOpenAICompatibleLocalModels } = await import(${entry("plugin-sdk/provider-setup.js")});
    configuration = { api: "openai-completions", models: await discoverOpenAICompatibleLocalModels({
      baseUrl, apiKey, label: "Configured provider", discoverRuntimeContext: false,
    }) };
  } else throw Error("Unsupported native inference provider");
  return {
    provider,
    configuration: { ...configuration, baseUrl, apiKey, timeoutSeconds: 180 },
    references: Object.fromEntries(configuration.models.map(model => [model.id, modelKey(provider, model.id)])),
    referenceAliases: Object.fromEntries(configuration.models.flatMap(model => {
      const legacy = legacyModelKey(provider, model.id);
      return legacy ? [[legacy, modelKey(provider, model.id)]] : [];
    })),
  };
}
`;
}
