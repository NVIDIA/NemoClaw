// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const PROXY_DIST = require.resolve("../../../../dist/lib/inference/ollama/proxy");
const LOCAL_DIST = require.resolve("../../../../dist/lib/inference/local");
const CREDS_DIST = require.resolve("../../../../dist/lib/credentials/store");

interface MockSetup {
  installed: string[];
  promptValues: string[];
}

function loadProxyWithMocks(setup: MockSetup): {
  proxy: typeof import("../../../../dist/lib/inference/ollama/proxy");
  promptArgs: string[];
  restore: () => void;
} {
  const local = require(LOCAL_DIST);
  const creds = require(CREDS_DIST);
  const originalGetOllamaModelOptions = local.getOllamaModelOptions;
  const originalPrompt = creds.prompt;
  const promptArgs: string[] = [];
  let promptCallIndex = 0;

  local.getOllamaModelOptions = () => setup.installed;
  creds.prompt = async (message: string) => {
    promptArgs.push(message);
    const value = setup.promptValues[promptCallIndex];
    promptCallIndex += 1;
    return value ?? "";
  };

  delete require.cache[PROXY_DIST];
  const proxy = require(PROXY_DIST);
  return {
    proxy,
    promptArgs,
    restore() {
      delete require.cache[PROXY_DIST];
      local.getOllamaModelOptions = originalGetOllamaModelOptions;
      creds.prompt = originalPrompt;
    },
  };
}

describe("promptOllamaModel installed-model fit filter", () => {
  let active: { restore: () => void } | null = null;
  afterEach(() => {
    active?.restore();
    active = null;
  });

  it("downgrades to a starter model when the only installed entry exceeds available memory", async () => {
    const setup = loadProxyWithMocks({
      installed: ["qwen3.6:35b"],
      // Enter on the rendered default.
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 12_000,
    });
    expect(result).toBe("qwen3.5:9b");
  });

  it("keeps a fitting installed model as the default", async () => {
    const setup = loadProxyWithMocks({
      installed: ["qwen3.5:9b", "qwen3.6:35b"],
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 12_000,
    });
    // Only qwen3.5:9b fits; the menu offers only it, Enter selects it.
    expect(result).toBe("qwen3.5:9b");
  });

  it("respects unknown installed tags (not in the registry) even when nothing else fits", async () => {
    const setup = loadProxyWithMocks({
      installed: ["my-custom:model"],
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel({
      type: "nvidia",
      totalMemoryMB: 131_072,
      availableMemoryMB: 12_000,
    });
    expect(result).toBe("my-custom:model");
  });

  it("drops excludeModels entries from the installed-fitting menu so a repeat probe-fail does not loop", async () => {
    // Caller (selectAndValidateOllamaModel) records `nemotron-3-nano:30b` as a
    // probe-fail and excludes it. Without this filter, pressing Enter on the
    // installed-fitting list would re-select the broken model and dead-loop.
    const setup = loadProxyWithMocks({
      installed: ["nemotron-3-nano:30b", "qwen3.5:9b"],
      promptValues: [""],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel(
      {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 131_072,
      },
      { excludeModels: new Set(["nemotron-3-nano:30b"]) },
    );
    expect(result).toBe("qwen3.5:9b");
  });

  it("falls back to bootstrap options and never re-offers excluded entries", async () => {
    const setup = loadProxyWithMocks({
      installed: ["nemotron-3-nano:30b"],
      // Pick the first menu entry explicitly. With nemotron-3-nano:30b
      // excluded, the bootstrap fall-back menu lists [qwen3.5:9b, qwen3.6:35b]
      // smallest-first; option 1 must resolve to qwen3.5:9b, never the
      // excluded tag.
      promptValues: ["1"],
    });
    active = setup;
    const result = await setup.proxy.promptOllamaModel(
      {
        type: "nvidia",
        totalMemoryMB: 131_072,
        availableMemoryMB: 131_072,
      },
      { excludeModels: new Set(["nemotron-3-nano:30b"]) },
    );
    expect(result).toBe("qwen3.5:9b");
    expect(result).not.toBe("nemotron-3-nano:30b");
  });
});
