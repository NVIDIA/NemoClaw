// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { resolveRequestedProviderSelection } from "../../../dist/lib/onboard/provider-selection";

const option = (key: string) => ({ key, label: key });

const remoteProviderConfig = {
  build: { providerName: "nvidia-prod" },
  openai: { providerName: "openai-api" },
  hermesProvider: { providerName: "hermes-provider" },
};

function resolve(overrides: Partial<Parameters<typeof resolveRequestedProviderSelection>[0]> = {}) {
  return resolveRequestedProviderSelection({
    options: [option("build")],
    requestedProvider: null,
    sandboxName: "sandbox",
    remoteProviderConfig,
    isWsl: false,
    isWindowsHostOllama: false,
    windowsHostOllamaSupported: false,
    hermesProviderAvailable: false,
    readRecordedProvider: () => null,
    readRecordedNimContainer: () => null,
    readRecordedModel: () => null,
    ...overrides,
  });
}

describe("resolveRequestedProviderSelection", () => {
  it("falls back install action keys to currently available providers", () => {
    const result = resolve({
      options: [option("build"), option("ollama")],
      requestedProvider: "install-ollama",
    });

    assert.equal(result.kind, "selected");
    if (result.kind === "selected") {
      assert.equal(result.selected.key, "ollama");
      assert.equal(result.recoveredFromSandbox, false);
      assert.equal(result.recoveredModel, null);
    }
  });

  it("recovers the recorded provider and model when no provider was requested", () => {
    const result = resolve({
      options: [option("build"), option("openai")],
      readRecordedProvider: () => "openai-api",
      readRecordedModel: () => "gpt-example",
    });

    assert.equal(result.kind, "selected");
    if (result.kind === "selected") {
      assert.equal(result.selected.key, "openai");
      assert.equal(result.recoveredFromSandbox, true);
      assert.equal(result.recoveredModel, "gpt-example");
    }
  });

  it("does not silently map a recorded WSL Ollama provider to Windows-host Ollama", () => {
    const result = resolve({
      options: [option("build"), option("ollama")],
      isWsl: true,
      isWindowsHostOllama: true,
      windowsHostOllamaSupported: true,
      readRecordedProvider: () => "ollama-local",
    });

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") {
      assert.equal(result.reason.kind, "wsl-recorded-ollama-windows-host");
    }
  });

  it("returns a Windows-host hint when recorded Ollama is unavailable but a host action exists", () => {
    const result = resolve({
      options: [option("build"), option("start-windows-ollama")],
      readRecordedProvider: () => "ollama-local",
    });

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") {
      assert.equal(result.reason.kind, "recorded-provider-unavailable");
      if (result.reason.kind === "recorded-provider-unavailable") {
        assert.equal(result.reason.recoveredKey, "ollama");
        assert.equal(result.reason.windowsHostKey, "start-windows-ollama");
      }
    }
  });

  it("reports Hermes Provider as agent-gated when it is requested for another agent", () => {
    const result = resolve({
      requestedProvider: "hermesProvider",
      hermesProviderAvailable: false,
    });

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") {
      assert.equal(result.reason.kind, "hermes-provider-unavailable");
    }
  });

  it("reports unsupported Windows-host Ollama before applying compatible fallbacks", () => {
    const result = resolve({
      requestedProvider: "start-windows-ollama",
      isWindowsHostOllama: true,
      windowsHostOllamaSupported: false,
    });

    assert.equal(result.kind, "failure");
    if (result.kind === "failure") {
      assert.equal(result.reason.kind, "unsupported-windows-host-ollama");
    }
  });

  it("defaults to NVIDIA Endpoints when no requested or recorded provider is available", () => {
    const result = resolve({
      options: [option("build"), option("openai")],
    });

    assert.equal(result.kind, "selected");
    if (result.kind === "selected") {
      assert.equal(result.selected.key, "build");
      assert.equal(result.recoveredFromSandbox, false);
    }
  });
});
