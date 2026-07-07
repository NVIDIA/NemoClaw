// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { getWindowsHostOllamaDockerRequirement } from "../src/lib/onboard/local-inference-topology.js";
import { buildInferenceProviderMenu } from "../src/lib/onboard/provider-menu.js";
import { resolveRequestedProviderSelection } from "../src/lib/onboard/provider-selection.js";
import { reportProviderSelectionFailure } from "../src/lib/onboard/provider-selection-failure.js";

import { requireFailedProviderResolution } from "./support/onboard-selection-test-helpers.js";

const TEST_REMOTE_PROVIDER_CONFIG = {
  build: { label: "NVIDIA Endpoints", providerName: "nvidia-prod" },
  openai: { label: "OpenAI", providerName: "openai-api" },
  custom: {
    label: "Other OpenAI-compatible endpoint",
    providerName: "compatible-endpoint",
  },
  anthropic: { label: "Anthropic", providerName: "anthropic-prod" },
  anthropicCompatible: {
    label: "Other Anthropic-compatible endpoint",
    providerName: "compatible-anthropic-endpoint",
  },
  gemini: { label: "Google Gemini", providerName: "gemini-api" },
};

type WindowsRequirement = ReturnType<typeof getWindowsHostOllamaDockerRequirement>;
type ProviderMenuOverrides = Partial<Parameters<typeof buildInferenceProviderMenu>[0]>;

function buildProviderMenu(overrides: ProviderMenuOverrides = {}) {
  return buildInferenceProviderMenu({
    remoteProviderConfig: TEST_REMOTE_PROVIDER_CONFIG,
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

function buildWindowsProviderMenu(
  requirement: WindowsRequirement,
  overrides: ProviderMenuOverrides = {},
) {
  return buildProviderMenu({
    isWsl: true,
    windowsHostLabelSuffix: requirement.supported ? "" : requirement.labelSuffix,
    windowsHostInstallLabel: requirement.installLabel,
    windowsHostStartLabel: requirement.startLabel,
    ...overrides,
  });
}

function resolveWindowsProvider(
  options: Array<{ key: string; label: string }>,
  requestedProvider: string,
  overrides: Partial<Parameters<typeof resolveRequestedProviderSelection>[0]> = {},
) {
  return resolveRequestedProviderSelection({
    options,
    requestedProvider,
    sandboxName: null,
    remoteProviderConfig: TEST_REMOTE_PROVIDER_CONFIG,
    isWsl: true,
    isWindowsHostOllama: false,
    windowsHostOllamaSupported: true,
    hermesProviderAvailable: false,
    readRecordedProvider: () => null,
    readRecordedNimContainer: () => null,
    readRecordedModel: () => null,
    ...overrides,
  });
}

describe("onboard Windows-host Ollama provider rejection", () => {
  it("does not satisfy start-windows-ollama with WSL-local Ollama", () => {
    const requirement = getWindowsHostOllamaDockerRequirement("docker-desktop");
    const { options } = buildWindowsProviderMenu(requirement, {
      hasOllama: true,
      ollamaRunning: true,
      ollamaHost: "127.0.0.1",
      hasWindowsOllama: false,
    });
    const resolution = resolveWindowsProvider(options, "start-windows-ollama", {
      isWsl: true,
      isWindowsHostOllama: false,
    });
    assert.equal(resolution.kind, "failure");
    const failedResolution = requireFailedProviderResolution(resolution);

    const setup = vi.fn();
    const switchHost = vi.fn();
    const errors: string[] = [];
    reportProviderSelectionFailure({
      reason: failedResolution.reason,
      isWindowsHostOllama: false,
      rejectWindowsHostOllama: () => {
        setup();
        switchHost();
        return true;
      },
      writeError: (message) => errors.push(message),
    });

    assert.match(errors.join("\n"), /Requested provider 'start-windows-ollama' is not available/);
    assert.equal(setup.mock.calls.length, 0);
    assert.equal(switchHost.mock.calls.length, 0);
  });

  it("does not satisfy install-windows-ollama with non-WSL local Ollama", () => {
    const requirement = getWindowsHostOllamaDockerRequirement(null);
    const { options } = buildWindowsProviderMenu(requirement, {
      hasOllama: true,
      ollamaRunning: true,
      ollamaHost: "127.0.0.1",
      isWsl: false,
      hasWindowsOllama: false,
    });
    const resolution = resolveWindowsProvider(options, "install-windows-ollama", {
      isWsl: false,
      isWindowsHostOllama: false,
    });
    assert.equal(resolution.kind, "failure");
    const failedResolution = requireFailedProviderResolution(resolution);

    const install = vi.fn();
    const setup = vi.fn();
    const errors: string[] = [];
    reportProviderSelectionFailure({
      reason: failedResolution.reason,
      isWindowsHostOllama: false,
      rejectWindowsHostOllama: () => {
        install();
        setup();
        return true;
      },
      writeError: (message) => errors.push(message),
    });

    assert.match(errors.join("\n"), /Requested provider 'install-windows-ollama' is not available/);
    assert.equal(install.mock.calls.length, 0);
    assert.equal(setup.mock.calls.length, 0);
  });
});
