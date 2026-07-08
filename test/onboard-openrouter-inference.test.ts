// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../src/lib/onboard/setup-inference.js";
import {
  createDirectSetupInferenceHarnessFactory,
  withProcessEnv,
} from "./support/setup-inference-test-harness.js";

const onboard = require("../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const openrouterRuntimeOnboard =
  require("../src/lib/onboard/openrouter-runtime") as typeof import("../src/lib/onboard/openrouter-runtime.js");
const openrouterRuntimeAdapter =
  require("../src/lib/inference/openrouter-runtime-adapter") as typeof import("../src/lib/inference/openrouter-runtime-adapter.js");

const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);

describe("OpenRouter onboarding inference setup", () => {
  it("configures OpenRouter through the remote provider setup branch (#5826)", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: "sk-or-test" }, async () => {
      const ensureAdapter = vi.fn(async () => ({
        baseUrl: "http://host.openshell.internal:11437/v1",
        localBaseUrl: "http://127.0.0.1:11437/v1",
        logPath: "/tmp/openrouter-adapter.log",
      }));
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          isNonInteractive: () => true,
          openrouterRuntimeOnboard: {
            setupOpenRouterRuntimeInference: (input) =>
              openrouterRuntimeOnboard.setupOpenRouterRuntimeInference({
                ...input,
                ensureAdapter,
              }),
          },
        },
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
        "provider update -g nemoclaw openrouter-api --credential OPENROUTER_API_KEY --config OPENAI_BASE_URL=http://host.openshell.internal:11437/v1",
        "inference set -g nemoclaw --no-verify --provider openrouter-api --model moonshotai/kimi-k2.6 --timeout 180",
      ]);
      assert.equal(harness.commands[1].env?.OPENROUTER_API_KEY, "sk-or-test");
      expect(ensureAdapter).toHaveBeenCalledWith({
        authorizationHash:
          openrouterRuntimeAdapter.openRouterRuntimeAuthorizationHash("sk-or-test"),
      });
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
        endpointUrl: "http://127.0.0.1:11437/v1",
        credentialEnv: "OPENROUTER_API_KEY",
        forceOpenAiLike: true,
      });
      assert.deepEqual(harness.errors, []);
      assert.deepEqual(harness.logs, [
        "  OpenRouter Runtime adapter ready: sandbox route http://host.openshell.internal:11437/v1, host log /tmp/openrouter-adapter.log",
        "  ✓ Inference route set: openrouter-api / moonshotai/kimi-k2.6",
      ]);
    });
  });

  it("does not start the header adapter when the OpenShell credential is missing", async () => {
    await withProcessEnv({ OPENROUTER_API_KEY: undefined }, async () => {
      const ensureAdapter = vi.fn(async () => ({
        baseUrl: "http://host.openshell.internal:11437/v1",
        localBaseUrl: "http://127.0.0.1:11437/v1",
        logPath: "/tmp/openrouter-adapter.log",
      }));
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          isNonInteractive: () => true,
          openrouterRuntimeOnboard: {
            setupOpenRouterRuntimeInference: (input) =>
              openrouterRuntimeOnboard.setupOpenRouterRuntimeInference({
                ...input,
                ensureAdapter,
              }),
          },
        },
      });

      await expect(
        harness.setupInference(
          "test-box",
          "moonshotai/kimi-k2.6",
          "openrouter-api",
          "https://openrouter.ai/api/v1",
          "OPENROUTER_API_KEY",
        ),
      ).rejects.toThrow("EXIT_CALLED:1");

      expect(ensureAdapter).not.toHaveBeenCalled();
      expect(harness.commands).toEqual([]);
      expect(harness.errors).toEqual([
        "  A host credential is required to configure provider 'openrouter-api'.",
      ]);
    });
  });
});
