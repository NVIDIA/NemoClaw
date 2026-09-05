// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { testTimeout } from "../helpers/timeouts";
import { runNativeDockerWindowsProviderBoundary } from "../support/onboard-selection-test-helpers.js";

const PROVIDER_SELECTION_TEST_TIMEOUT_MS = testTimeout(60_000);
const FORBIDDEN_WINDOWS_ACTIONS =
  /MODEL_SELECTION_REACHED|WINDOWS_INSTALL_CALLED|WINDOWS_SETUP_CALLED|WINDOWS_SWITCH_CALLED/;

describe("native Docker WSL provider boundary", () => {
  it.each([
    { provider: "start-windows-ollama", installed: true },
    { provider: "install-windows-ollama", installed: false },
  ] as const)("rejects $provider before launching Ollama", (scenario) => {
    const boundary = runNativeDockerWindowsProviderBoundary({
      ...scenario,
      reachable: false,
      timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
    });

    assert.equal(boundary.status, 1, `${scenario.provider} unexpectedly passed`);
    assert.match(boundary.stderr, /\[non-interactive\] Aborting:/);
    assert.match(boundary.stderr, new RegExp(scenario.provider + " requires Docker Desktop"));
    assert.match(boundary.stderr, /Choose WSL-local Ollama/);
    assert.doesNotMatch(boundary.stderr, FORBIDDEN_WINDOWS_ACTIONS);
  });

  it.each(["start-windows-ollama", "install-windows-ollama"] as const)(
    "rejects an explicit reachable Windows-host provider path [%s]",
    (provider) => {
      const boundary = runNativeDockerWindowsProviderBoundary({
        provider,
        installed: true,
        reachable: true,
        timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
      });
      const effectiveProvider =
        provider === "install-windows-ollama" ? "start-windows-ollama" : provider;

      assert.equal(boundary.status, 1, `${provider} unexpectedly passed`);
      assert.match(boundary.stderr, /\[non-interactive\] Aborting:/);
      assert.match(boundary.stderr, new RegExp(effectiveProvider + " requires Docker Desktop"));
      assert.match(boundary.stderr, /Choose WSL-local Ollama/);
      assert.doesNotMatch(boundary.stderr, FORBIDDEN_WINDOWS_ACTIONS);
    },
  );
});
