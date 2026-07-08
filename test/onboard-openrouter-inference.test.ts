// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../src/lib/onboard/setup-inference.js";
import {
  createDirectSetupInferenceHarnessFactory,
  withProcessEnv,
} from "./support/setup-inference-test-harness.js";

const onboard = require("../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};

const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);

describe("OpenRouter onboarding inference setup", () => {
  it("configures OpenRouter through the remote provider setup branch (#5826)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: "sk-or-test" }, async () => {
      const harness = createDirectSetupInferenceHarness({
        overrides: { isNonInteractive: () => true },
      });

      await harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "openrouter-api",
        "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY",
      );

      const commands = harness.commands.map(({ command }) => command);
      assert.deepEqual(commands, [
        "provider get -g nemoclaw openrouter-api",
        "provider update -g nemoclaw openrouter-api --credential OPENROUTER_API_KEY --config OPENAI_BASE_URL=https://openrouter.ai/api/v1",
        "inference set -g nemoclaw --no-verify --provider openrouter-api --model moonshotai/kimi-k2.6",
      ]);
      assert.equal(harness.commands[1].env?.OPENROUTER_API_KEY, "sk-or-test");
      assert.ok(
        !commands.some((command) => command.includes("sk-or-test")),
        "OpenRouter key must not appear in argv",
      );
      expect(harness.verifyInferenceRoute).toHaveBeenCalledWith(
        "nemoclaw",
        "openrouter-api",
        "moonshotai/kimi-k2.6",
      );
      expect(harness.verifyOnboardInferenceSmoke).toHaveBeenCalledWith({
        provider: "openrouter-api",
        model: "moonshotai/kimi-k2.6",
        endpointUrl: "https://openrouter.ai/api/v1",
        credentialEnv: "OPENROUTER_API_KEY",
      });
      assert.deepEqual(harness.errors, []);
      assert.deepEqual(harness.logs, [
        "  ✓ Inference route set: openrouter-api / moonshotai/kimi-k2.6",
      ]);
    });
  });
});
