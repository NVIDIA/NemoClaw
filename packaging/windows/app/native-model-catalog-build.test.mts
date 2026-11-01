// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { nativeModelCatalogSource } from "./native-model-catalog-build.mts";
import type { NativeModelCatalog } from "../runtime/native-openclaw-models.mts";

test("the compiled adapter delegates provider discovery, metadata and references to pinned OpenClaw APIs", async () => {
  const calls: { provider: string; parameters: unknown }[] = [];
  const models = [
    {
      id: "vendor/model",
      name: "Native name",
      reasoning: true,
      contextWindow: 234567,
      maxTokens: 7654,
      compat: { requiresStringContent: true },
    },
  ];
  const modules: Record<string, string> = {
    "io.read-helpers-ZKp-UiGx.js":
      "export function l(text) { return globalThis.nativeParse(text); }",
    "model-key-CMdQNkZf.js":
      'export function t(provider, id) { return "native-reference:" + provider + ":" + id; }',
    "model-ref-shared-Dz7QU0Lx.js":
      'export function a(provider, id) { return provider === "nvidia" ? "native-legacy:" + provider + ":" + id : null; }',
    "extensions/nvidia/provider-catalog.js":
      'export async function buildSelectableLiveNvidiaProvider() { return globalThis.nativeProvider("nvidia"); }',
    "extensions/openrouter/provider-catalog.js":
      'export async function buildOpenrouterLiveProvider(params) { return globalThis.nativeProvider("openrouter", params); }',
    "plugin-sdk/provider-setup.js":
      'export async function discoverOpenAICompatibleLocalModels(params) { return globalThis.nativeProvider("compatible", params).models; }',
  };
  const bundled = await build({
    stdin: {
      contents:
        "function __nemoPrepareAssetRoot() {}\n" + nativeModelCatalogSource("/pinned/openclaw"),
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    plugins: [
      {
        name: "native-api-contract",
        setup(builder) {
          builder.onResolve({ filter: /\/pinned\/openclaw\/dist\// }, (args) => ({
            path: args.path.split("/dist/")[1]!,
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
            assert(args.path in modules, "Only the pinned native APIs may be imported");
            return { contents: modules[args.path], loader: "js" };
          });
        },
      },
    ],
  });
  const module = {
    exports: {} as {
      parseNativeConfiguration(text: string): Promise<unknown>;
      buildNativeModelCatalog(
        provider: string,
        url: string,
        token: string,
      ): Promise<NativeModelCatalog>;
    },
  };
  runInNewContext(bundled.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    nativeParse: (text: string) => ({
      ok: text !== "invalid",
      parsed: text === "null" ? null : { native: text },
    }),
    nativeProvider(provider: string, parameters: unknown) {
      calls.push({ provider, parameters });
      return {
        models,
        api: "openai-completions",
        apiKey: "upstream-placeholder",
        baseUrl: "https://upstream.invalid",
      };
    },
  });
  assert.equal(
    ((await module.exports.parseNativeConfiguration("fixture")) as { native: string }).native,
    "fixture",
  );
  for (const invalid of ["invalid", "null"])
    await assert.rejects(module.exports.parseNativeConfiguration(invalid), /not been overwritten/);
  for (const inference of ["nvidia", "openrouter", "compatible", "local"]) {
    const result = await module.exports.buildNativeModelCatalog(
      inference,
      "http://127.0.0.1:18790/v1",
      "guest-token",
    );
    assert.equal(result.configuration.models, models);
    assert.equal(result.configuration.baseUrl, "http://127.0.0.1:18790/v1");
    assert.equal(result.configuration.apiKey, "guest-token");
    assert.equal(
      result.references[models[0]!.id],
      `native-reference:${result.provider}:vendor/model`,
    );
    assert.deepEqual(
      Object.entries(result.referenceAliases ?? {}),
      inference === "nvidia"
        ? [["native-legacy:nvidia:vendor/model", "native-reference:nvidia:vendor/model"]]
        : [],
    );
    assert.equal(
      result.provider,
      ["nvidia", "openrouter"].includes(inference) ? inference : "nemoclawNative",
    );
    assert.equal(calls.at(-1)!.provider, inference === "local" ? "compatible" : inference);
    if (inference !== "nvidia")
      assert.equal((calls.at(-1)!.parameters as { apiKey: string }).apiKey, "guest-token");
  }
  await assert.rejects(
    module.exports.buildNativeModelCatalog("unregistered", "https://other.invalid", "guest-token"),
    /Unsupported/,
  );
});
