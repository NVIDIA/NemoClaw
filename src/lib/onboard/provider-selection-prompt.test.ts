// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

import { promptForInferenceProviderSelection } from "../../../dist/lib/onboard/provider-selection-prompt";

const options = [
  { key: "build", label: "NVIDIA Endpoints" },
  { key: "openai", label: "OpenAI" },
  { key: "custom", label: "Other OpenAI-compatible endpoint" },
];

function makeSelectSpy() {
  return vi.fn((_: string, defaultIdx: number, entries: typeof options) => entries[defaultIdx - 1]);
}

function makePrompt(reply: string) {
  return vi.fn(async (_question: string) => reply);
}

function makeLog() {
  return vi.fn((_message?: string) => {});
}

describe("promptForInferenceProviderSelection", () => {
  it("renders the provider menu and defaults to the build provider", async () => {
    const prompt = makePrompt("");
    const log = makeLog();
    const selectFromNumberedMenu = makeSelectSpy();

    const selected = await promptForInferenceProviderSelection({
      options,
      vllmRunning: false,
      ollamaRunning: false,
      env: {},
      prompt,
      log,
      selectFromNumberedMenu,
    });

    assert.equal(selected.key, "build");
    assert.deepEqual(
      log.mock.calls.map((call) => call[0]),
      [
        "",
        "  Select your inference provider:",
        "    1) NVIDIA Endpoints",
        "    2) OpenAI",
        "    3) Other OpenAI-compatible endpoint",
        "",
      ],
    );
    assert.equal(prompt.mock.calls[0]?.[0], "  Choose [1]: ");
    assert.deepEqual(selectFromNumberedMenu.mock.calls[0], ["", 1, options]);
  });

  it("prints detected local inference suggestions before the menu", async () => {
    const prompt = makePrompt("2");
    const log = makeLog();
    const selectFromNumberedMenu = makeSelectSpy();

    await promptForInferenceProviderSelection({
      options,
      vllmRunning: true,
      ollamaRunning: true,
      env: {},
      prompt,
      log,
      selectFromNumberedMenu,
    });

    assert.deepEqual(
      log.mock.calls.slice(0, 3).map((call) => call[0]),
      ["  Detected local inference options: vLLM, Ollama", "", ""],
    );
  });

  it("uses NEMOCLAW_PROVIDER as the default choice when it matches an option", async () => {
    const prompt = makePrompt("");
    const log = makeLog();
    const selectFromNumberedMenu = makeSelectSpy();

    const selected = await promptForInferenceProviderSelection({
      options,
      vllmRunning: false,
      ollamaRunning: false,
      env: { NEMOCLAW_PROVIDER: "OPENAI" },
      prompt,
      log,
      selectFromNumberedMenu,
    });

    assert.equal(selected.key, "openai");
    assert.equal(prompt.mock.calls[0]?.[0], "  Choose [2]: ");
    assert.deepEqual(selectFromNumberedMenu.mock.calls[0], ["", 2, options]);
  });

  it("falls back to the build option when the env hint is unavailable", async () => {
    const prompt = makePrompt("");
    const log = makeLog();
    const selectFromNumberedMenu = makeSelectSpy();
    const reorderedOptions = [options[1], options[2], options[0]];

    const selected = await promptForInferenceProviderSelection({
      options: reorderedOptions,
      vllmRunning: false,
      ollamaRunning: false,
      env: { NEMOCLAW_PROVIDER: "missing-provider" },
      prompt,
      log,
      selectFromNumberedMenu,
    });

    assert.equal(selected.key, "build");
    assert.equal(prompt.mock.calls[0]?.[0], "  Choose [3]: ");
    assert.deepEqual(selectFromNumberedMenu.mock.calls[0], ["", 3, reorderedOptions]);
  });
});
