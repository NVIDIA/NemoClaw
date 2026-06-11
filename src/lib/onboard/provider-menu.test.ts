// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildInferenceProviderMenu } from "../../../dist/lib/onboard/provider-menu";

const REMOTE_PROVIDER_CONFIG = {
  build: { label: "NVIDIA Endpoints" },
  openai: { label: "OpenAI" },
  custom: { label: "Other OpenAI-compatible endpoint" },
  anthropic: { label: "Anthropic" },
  anthropicCompatible: { label: "Other Anthropic-compatible endpoint" },
  gemini: { label: "Google Gemini" },
  hermesProvider: { label: "Hermes Provider" },
};

function buildMenu(overrides: Partial<Parameters<typeof buildInferenceProviderMenu>[0]> = {}) {
  return buildInferenceProviderMenu({
    remoteProviderConfig: REMOTE_PROVIDER_CONFIG,
    agentProviderOptions: [],
    experimental: false,
    gpuNimCapable: false,
    hasOllama: false,
    ollamaRunning: false,
    ollamaHost: null,
    ollamaPort: 11434,
    isWsl: false,
    hasWindowsOllama: false,
    isWindowsHostOllama: false,
    windowsHostLabelSuffix: "",
    windowsHostInstallLabel: "Install Ollama on Windows host (recommended)",
    windowsHostStartLabel: () => "Start Ollama on Windows host (suggested)",
    windowsOllamaReachable: false,
    winOllamaLoopbackOnly: false,
    ollamaInstallEntry: null,
    vllmEntries: [],
    routedEnabled: false,
    ...overrides,
  });
}

describe("buildInferenceProviderMenu", () => {
  it("returns the base remote providers in the existing prompt order", () => {
    const result = buildMenu();

    expect(result.hermesProviderAvailable).toBe(false);
    expect(result.options.map((option) => option.key)).toEqual([
      "build",
      "openai",
      "custom",
      "anthropic",
      "anthropicCompatible",
      "gemini",
    ]);
  });

  it("adds local, routed, and agent-scoped providers after the base remote entries", () => {
    const result = buildMenu({
      agentProviderOptions: ["hermesProvider", "build"],
      experimental: true,
      gpuNimCapable: true,
      hasOllama: true,
      ollamaRunning: true,
      ollamaHost: "127.0.0.1",
      isWsl: false,
      ollamaInstallEntry: { key: "install-ollama", label: "Install Ollama (Linux)" },
      vllmEntries: [{ key: "install-vllm", label: "Install vLLM (DGX Spark)" }],
      routedEnabled: true,
    });

    expect(result.hermesProviderAvailable).toBe(true);
    expect(result.options.map((option) => option.key)).toEqual([
      "build",
      "openai",
      "custom",
      "anthropic",
      "anthropicCompatible",
      "gemini",
      "ollama",
      "nim-local",
      "install-vllm",
      "install-ollama",
      "routed",
      "hermesProvider",
    ]);
    expect(result.options.find((option) => option.key === "build")?.label).toBe("NVIDIA Endpoints");
    expect(result.options.find((option) => option.key === "hermesProvider")?.label).toBe(
      "Hermes Provider",
    );
  });

  it("offers Windows-host Ollama install when WSL has no Windows Ollama", () => {
    const result = buildMenu({
      isWsl: true,
      hasWindowsOllama: false,
      windowsHostInstallLabel: "Install Ollama on Windows host (requires Docker Desktop)",
    });

    expect(result.options.at(-1)).toEqual({
      key: "install-windows-ollama",
      label: "Install Ollama on Windows host (requires Docker Desktop)",
    });
  });

  it("offers Windows-host Ollama start when detected but not currently selected", () => {
    const result = buildMenu({
      isWsl: true,
      hasWindowsOllama: true,
      isWindowsHostOllama: false,
      windowsOllamaReachable: true,
      windowsHostStartLabel: ({ reachable }) =>
        reachable ? "Use Ollama on Windows host - running" : "Start Ollama on Windows host",
    });

    expect(result.options.at(-1)).toEqual({
      key: "start-windows-ollama",
      label: "Use Ollama on Windows host - running",
    });
  });

  it("does not add a separate Windows-host start entry when running Ollama already resolves there", () => {
    const result = buildMenu({
      isWsl: true,
      hasOllama: false,
      ollamaRunning: true,
      ollamaHost: "host.docker.internal",
      hasWindowsOllama: true,
      isWindowsHostOllama: true,
    });

    expect(result.options.map((option) => option.key)).toContain("ollama");
    expect(result.options.map((option) => option.key)).not.toContain("start-windows-ollama");
  });
});
