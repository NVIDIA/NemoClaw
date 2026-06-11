// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { reportProviderSelectionFailure } from "../../../dist/lib/onboard/provider-selection-failure";

function report(overrides: Partial<Parameters<typeof reportProviderSelectionFailure>[0]>): {
  errors: string[];
  rejected: Array<{ providerKey: string; windowsHostSelected: boolean }>;
} {
  const errors: string[] = [];
  const rejected: Array<{ providerKey: string; windowsHostSelected: boolean }> = [];

  reportProviderSelectionFailure({
    reason: { kind: "requested-provider-unavailable", providerKey: "missing" },
    isWindowsHostOllama: false,
    rejectWindowsHostOllama: (providerKey, windowsHostSelected) => {
      rejected.push({ providerKey, windowsHostSelected });
      return true;
    },
    writeError: (message) => errors.push(message),
    ...overrides,
  });

  return { errors, rejected };
}

describe("reportProviderSelectionFailure", () => {
  it("reports recorded WSL Ollama recovery as unavailable on Windows host", () => {
    const { errors, rejected } = report({
      reason: {
        kind: "wsl-recorded-ollama-windows-host",
        recordedProvider: "ollama-local",
      },
    });

    assert.deepEqual(rejected, []);
    assert.deepEqual(errors, [
      "  Recorded provider 'ollama-local' (WSL Ollama) is not available in this environment.",
      "  Hint: Windows-host Ollama is reachable here; re-run with NEMOCLAW_PROVIDER=ollama to use it explicitly.",
    ]);
  });

  it("adds a Windows-host hint when recorded provider recovery has a host action", () => {
    const { errors, rejected } = report({
      reason: {
        kind: "recorded-provider-unavailable",
        recordedProvider: "ollama-local",
        recoveredKey: "ollama",
        windowsHostKey: "start-windows-ollama",
      },
    });

    assert.deepEqual(rejected, []);
    assert.deepEqual(errors, [
      "  Recorded provider 'ollama-local' is not available in this environment.",
      "  Set NEMOCLAW_PROVIDER explicitly, or restore the missing local-inference dependency.",
      "  Hint: Windows-host Ollama is available here — re-run with NEMOCLAW_PROVIDER=start-windows-ollama to use it.",
    ]);
  });

  it("delegates unsupported Windows-host Ollama failures to the rejection helper", () => {
    const { errors, rejected } = report({
      reason: { kind: "unsupported-windows-host-ollama", providerKey: "start-windows-ollama" },
      isWindowsHostOllama: true,
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(rejected, [
      { providerKey: "start-windows-ollama", windowsHostSelected: true },
    ]);
  });

  it("reports Hermes Provider when requested for an unsupported agent", () => {
    const { errors, rejected } = report({
      reason: { kind: "hermes-provider-unavailable" },
    });

    assert.deepEqual(rejected, []);
    assert.deepEqual(errors, [
      "  Hermes Provider is only available when onboarding Hermes Agent.",
      "  Re-run with `nemohermes onboard` or `nemoclaw onboard --agent hermes`.",
    ]);
  });

  it("reports unavailable requested providers", () => {
    const { errors, rejected } = report({
      reason: { kind: "requested-provider-unavailable", providerKey: "missing-provider" },
    });

    assert.deepEqual(rejected, []);
    assert.deepEqual(errors, [
      "  Requested provider 'missing-provider' is not available in this environment.",
    ]);
  });
});
