// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { testTimeout } from "../helpers/timeouts";
import { runNativeDockerWindowsProviderBoundary } from "../support/onboard-selection-test-helpers.js";

const PROVIDER_SELECTION_TEST_TIMEOUT_MS = testTimeout(60_000);
const WINDOWS_EFFECT_MARKERS = /WINDOWS_INSTALL_CALLED|WINDOWS_SETUP_CALLED|WINDOWS_SWITCH_CALLED/;
const WINDOWS_ACTION_MARKERS = new RegExp(
  `MODEL_SELECTION_REACHED|${WINDOWS_EFFECT_MARKERS.source}`,
);

describe(
  "Windows-host Ollama security boundary",
  { timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS },
  () => {
    it.each([
      { provider: "start-windows-ollama", installed: true },
      { provider: "install-windows-ollama", installed: false },
    ] as const)("rejects $provider on native Docker WSL before launching Ollama", (scenario) => {
      const boundary = runNativeDockerWindowsProviderBoundary({
        ...scenario,
        reachable: false,
        timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
      });

      assert.equal(boundary.status, 1, `${scenario.provider} unexpectedly passed`);
      assert.match(boundary.stderr, /\[non-interactive\] Aborting:/);
      assert.match(boundary.stderr, new RegExp(scenario.provider + " requires Docker Desktop"));
      assert.match(boundary.stderr, /Choose WSL-local Ollama/);
      assert.doesNotMatch(boundary.stderr, WINDOWS_ACTION_MARKERS);
    });

    it.each([
      { provider: "start-windows-ollama", rejectedKey: "start-windows-ollama" },
      { provider: "install-windows-ollama", rejectedKey: "start-windows-ollama" },
    ] as const)(
      "rejects reachable Windows-host Ollama on native Docker WSL [$provider]",
      (scenario) => {
        const boundary = runNativeDockerWindowsProviderBoundary({
          provider: scenario.provider,
          installed: true,
          reachable: true,
          timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
        });

        assert.equal(boundary.status, 1, `${scenario.provider} unexpectedly passed`);
        assert.match(boundary.stderr, /\[non-interactive\] Aborting:/);
        assert.match(
          boundary.stderr,
          new RegExp(scenario.rejectedKey + " requires Docker Desktop"),
        );
        assert.match(boundary.stderr, /Choose WSL-local Ollama/);
        assert.doesNotMatch(boundary.stderr, WINDOWS_ACTION_MARKERS);
      },
    );

    it("routes generic Ollama to WSL-local setup when the Windows route is unprotected", () => {
      const boundary = runNativeDockerWindowsProviderBoundary({
        provider: "ollama",
        installed: true,
        reachable: true,
        timeoutMs: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
      });

      assert.equal(boundary.status, 1);
      assert.match(boundary.stderr, /OLLAMA_READINESS_PROBED/);
      assert.match(boundary.stderr, /MODEL_SELECTION_REACHED/);
      assert.doesNotMatch(boundary.stderr, /requires Docker Desktop/);
      assert.doesNotMatch(boundary.stderr, WINDOWS_EFFECT_MARKERS);
    });
  },
);
