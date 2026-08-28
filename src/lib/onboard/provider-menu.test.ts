// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import { buildInferenceProviderMenu } from "./provider-menu";
import { resolveRequestedProviderSelection } from "./provider-selection";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

const REMOTE_PROVIDER_CONFIG = {
  build: { label: "NVIDIA Endpoints" },
  openrouter: { label: "OpenRouter" },
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
    nvidiaPlatform: undefined,
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
      "openrouter",
      "openai",
      "custom",
      "anthropic",
      "anthropicCompatible",
      "gemini",
      "llama-cpp",
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
      "openrouter",
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
      "llama-cpp",
    ]);
    expect(result.options.find((option) => option.key === "build")?.label).toBe("NVIDIA Endpoints");
    expect(result.options.find((option) => option.key === "hermesProvider")?.label).toBe(
      "Hermes Provider",
    );
  });

  it("preserves the priority order and identity of managed llama.cpp profiles", () => {
    const managedLlamaCppOptions = [
      {
        key: "install-llama-cpp",
        label: "Managed llama.cpp: Recommended model (recommended)",
        managedLlamaCppRecipeId: "llama-cpp.recommended.v1",
      },
      {
        key: "install-llama-cpp",
        label: "Managed llama.cpp: Alternate model",
        managedLlamaCppRecipeId: "llama-cpp.alternate.v1",
      },
    ];

    const result = buildMenu({ managedLlamaCppOptions });

    expect(result.options.filter(({ key }) => key === "install-llama-cpp")).toEqual(
      managedLlamaCppOptions,
    );
  });

  it("keeps Local NVIDIA NIM unavailable on N1x while retaining managed vLLM (#8574)", () => {
    const menu = buildMenu({
      experimental: true,
      gpuNimCapable: true,
      nvidiaPlatform: "n1x",
      vllmEntries: [{ key: "install-vllm", label: "Install vLLM (N1x) [Deferred preview]" }],
    });
    const providerKeys = menu.options.map(({ key }) => key);

    expect(providerKeys).not.toContain("nim-local");
    expect(providerKeys).toContain("install-vllm");
    expect(
      resolveRequestedProviderSelection({
        options: menu.options,
        requestedProvider: "nim-local",
        sandboxName: null,
        remoteProviderConfig: {},
        isWsl: false,
        isWindowsHostOllama: false,
        windowsHostOllamaSupported: false,
        hermesProviderAvailable: false,
        readRecordedProvider: () => null,
        readRecordedNimContainer: () => null,
        readRecordedModel: () => null,
      }),
    ).toEqual({
      kind: "failure",
      reason: { kind: "requested-provider-unavailable", providerKey: "nim-local" },
    });
  });

  it("rejects explicit Local NVIDIA NIM on N1x before NIM setup (#8574)", async () => {
    const error = vi.fn();
    const handleNimLocalSelection = vi.fn<SetupNimFlowDeps["handleNimLocalSelection"]>();
    const setupNim = createSetupNim(
      makeDeps({
        experimental: true,
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "nim-local",
        detectInferenceProviderHostState: () =>
          makeHostState({
            gpuNimCapable: true,
            vllmEntries: [{ key: "install-vllm", label: "Install vLLM (N1x) [Deferred preview]" }],
          }),
        error,
        exitProcess: (code) => unexpected(`exitProcess(${code})`),
        handleNimLocalSelection,
      }),
    );

    await expect(
      setupNim({ type: "nvidia", platform: "n1x", nimCapable: true } as never),
    ).rejects.toThrow("Unexpected exitProcess(1) call");
    expect(error).toHaveBeenCalledWith(
      "  Requested provider 'nim-local' is not available in this environment.",
    );
    expect(handleNimLocalSelection).not.toHaveBeenCalled();
  });

  it("offers Windows-host Ollama install when WSL has no Windows Ollama", () => {
    const result = buildMenu({
      isWsl: true,
      hasWindowsOllama: false,
      windowsHostInstallLabel: "Install Ollama on Windows host (requires Docker Desktop)",
    });

    expect(result.options.at(-2)).toEqual({
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

    expect(result.options.at(-2)).toEqual({
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
      windowsOllamaReachable: true,
    });

    expect(result.options.map((option) => option.key)).toContain("ollama");
    expect(result.options.map((option) => option.key)).not.toContain("start-windows-ollama");
  });

  it("offers a Windows-host restart when WSL reachability is not Docker reachability (#10100)", () => {
    const result = buildMenu({
      isWsl: true,
      hasOllama: false,
      ollamaRunning: true,
      ollamaHost: "host.docker.internal",
      hasWindowsOllama: true,
      isWindowsHostOllama: true,
      windowsOllamaReachable: false,
      windowsHostStartLabel: () => "Restart Ollama on Windows host",
    });

    expect(result.options.map((option) => option.key)).toContain("start-windows-ollama");
  });

  it("offers restart without executable detection and omits Windows-host install (#7472)", () => {
    const result = buildMenu({
      isWsl: true,
      hasOllama: false,
      ollamaRunning: true,
      ollamaHost: "host.docker.internal",
      hasWindowsOllama: false,
      isWindowsHostOllama: true,
    });

    expect(result.options.map((option) => option.key)).toContain("ollama");
    expect(result.options.map((option) => option.key)).toContain("start-windows-ollama");
    expect(result.options.map((option) => option.key)).not.toContain("install-windows-ollama");
  });
});
