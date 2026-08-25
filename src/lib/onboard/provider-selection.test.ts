// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { resolveRequestedProviderSelection } from "./provider-selection";

const option = (key: string) => ({ key, label: key });

const remoteProviderConfig = {
  build: { providerName: "nvidia-prod" },
  openai: { providerName: "openai-api" },
  hermesProvider: { providerName: "hermes-provider" },
};

// Ternary accessor (no `if`, per the changed-test-file conditionals guardrail).
const selectedKey = (result: ReturnType<typeof resolveRequestedProviderSelection>) =>
  result.kind === "selected" ? result.selected.key : null;

function resolve(overrides: Partial<Parameters<typeof resolveRequestedProviderSelection>[0]> = {}) {
  return resolveRequestedProviderSelection({
    options: [option("build")],
    requestedProvider: null,
    sandboxName: "sandbox",
    remoteProviderConfig,
    isWsl: false,
    isWindowsHostOllama: false,
    windowsHostOllamaSupported: false,
    windowsHostOllamaReachable: false,
    hermesProviderAvailable: false,
    ollamaRunning: false,
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

  it("reuses a running Ollama daemon instead of reinstalling on the Windows host (#7472)", () => {
    // WSL mirrored networking: the Windows daemon answers on loopback first, so
    // the probe reads isWindowsHostOllama false and the menu keeps the install
    // entry. Express still requests it; the running daemon must win anyway.
    const result = resolve({
      options: [option("build"), option("ollama"), option("install-windows-ollama")],
      requestedProvider: "install-windows-ollama",
      isWsl: true,
      isWindowsHostOllama: false,
      windowsHostOllamaSupported: true,
      ollamaRunning: true,
    });

    assert.equal(selectedKey(result), "ollama");
  });

  it("still installs on the Windows host when no daemon responds (#7472)", () => {
    const result = resolve({
      options: [option("build"), option("install-windows-ollama")],
      requestedProvider: "install-windows-ollama",
      isWsl: true,
      windowsHostOllamaSupported: true,
      ollamaRunning: false,
    });

    assert.equal(selectedKey(result), "install-windows-ollama");
  });

  it("restarts Windows-host Ollama when only WSL can reach the daemon (#10100)", () => {
    const result = resolve({
      options: [option("build"), option("ollama"), option("start-windows-ollama")],
      requestedProvider: "install-windows-ollama",
      isWsl: true,
      isWindowsHostOllama: true,
      windowsHostOllamaSupported: true,
      windowsHostOllamaReachable: false,
      ollamaRunning: true,
    });

    assert.equal(selectedKey(result), "start-windows-ollama");
  });

  it("restarts Docker-unreachable Windows-host Ollama for an explicit Ollama request (#10100)", () => {
    const result = resolve({
      options: [option("build"), option("ollama"), option("start-windows-ollama")],
      requestedProvider: "ollama",
      isWsl: true,
      isWindowsHostOllama: true,
      windowsHostOllamaSupported: true,
      windowsHostOllamaReachable: false,
      ollamaRunning: true,
    });

    assert.equal(selectedKey(result), "start-windows-ollama");
  });

  it("rejects explicit Windows-host Ollama on an unsupported container runtime (#10100)", () => {
    const result = resolve({
      options: [option("build"), option("ollama")],
      requestedProvider: "ollama",
      isWsl: true,
      isWindowsHostOllama: true,
      windowsHostOllamaSupported: false,
      windowsHostOllamaReachable: false,
      ollamaRunning: true,
    });

    assert.equal(result.kind, "failure");
    assert.equal(
      result.kind === "failure" ? result.reason.kind : null,
      "unsupported-windows-host-ollama",
    );
  });

  it("still installs WSL-local Ollama when a daemon is already running (#7472)", () => {
    // Guards the narrow scope: widening the collapse to install-ollama would
    // skip the upgrade entry resolveOllamaInstallMenuEntry keeps for a
    // running-but-stale daemon.
    const result = resolve({
      options: [option("build"), option("ollama"), option("install-ollama")],
      requestedProvider: "install-ollama",
      ollamaRunning: true,
    });

    assert.equal(selectedKey(result), "install-ollama");
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

  it("auto-selects managed vLLM on a DGX managed-vLLM platform when no provider is given (#7293)", () => {
    const result = resolve({
      options: [option("build"), option("install-vllm")],
      preferManagedVllmDefault: true,
    });

    assert.equal(selectedKey(result), "install-vllm");
  });

  it("auto-selects an already-running local vLLM on a managed-vLLM platform (#7293)", () => {
    // When vLLM is already running, the menu exposes only `vllm` (not install-vllm).
    const result = resolve({
      options: [option("build"), option("vllm")],
      preferManagedVllmDefault: true,
    });

    assert.equal(selectedKey(result), "vllm");
  });

  it("keeps the cloud default when the caller does not prefer managed vLLM (#7293)", () => {
    // The menu can expose managed vLLM without changing the automatic selection.
    const result = resolve({
      options: [option("build"), option("install-vllm")],
      preferManagedVllmDefault: false,
    });

    assert.equal(selectedKey(result), "build");
  });

  it("keeps the cloud default when no managed-vLLM entry is available (#7293)", () => {
    const result = resolve({
      options: [option("build"), option("openai")],
      preferManagedVllmDefault: true,
    });

    assert.equal(selectedKey(result), "build");
  });
});
