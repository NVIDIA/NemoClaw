// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  catalogueTarget,
  E2E_TARGET_CATALOGUE,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";

describe("inference-switch catalogue boundary", () => {
  it.each([{ scenario: "OpenClaw" }, { scenario: "Hermes" }])(
    "keeps both agents on their reviewed provider-switch contracts [$scenario]",
    ({ scenario }) => {
      expect(() => validateE2eTargetCatalogue(E2E_TARGET_CATALOGUE)).not.toThrow();
      const openclaw = catalogueTarget("openclaw-inference-switch");
      expect(openclaw).toMatchObject({
        profile: "nvidia-api",
        testFile: "test/e2e/live/openclaw-inference-switch.test.ts",
        environment: {
          NEMOCLAW_AGENT: "openclaw",
          NEMOCLAW_E2E_SHARD: "native-nvidia",
          NEMOCLAW_SWITCH_PROVIDER: "nvidia-prod",
          NEMOCLAW_SWITCH_MODEL: "nvidia/nemotron-3-super-120b-a12b",
          NEMOCLAW_SWITCH_INFERENCE_API: "openai-completions",
        },
      });
      expect(openclaw.environment).not.toHaveProperty("NEMOCLAW_SWITCH_MOCK_ANTHROPIC");

      const hermes = catalogueTarget("hermes-inference-switch");
      expect(hermes).toMatchObject({
        profile: "nvidia-api",
        testFile: "test/e2e/live/hermes-inference-switch.test.ts",
        hostPreparation: "hermes-swap",
        runnerComparison: true,
        shard: "native-nvidia",
        environment: {
          NEMOCLAW_AGENT: "hermes",
          NEMOCLAW_SWITCH_PROVIDER: "nvidia-prod",
          NEMOCLAW_SWITCH_MODEL: "nvidia/nemotron-3-super-120b-a12b",
          NEMOCLAW_SWITCH_INFERENCE_API: "openai-completions",
        },
      });
      expect(hermes.environment).not.toHaveProperty("NEMOCLAW_SWITCH_MOCK_ANTHROPIC");
      const target = ({ OpenClaw: openclaw, Hermes: hermes } as const)[scenario]!;
      expect(target.environment).not.toHaveProperty("NEMOCLAW_E2E_USE_HOSTED_INFERENCE");
    },
  );

  it("keeps canonical compatible Anthropic switch targets for both agents", () => {
    expect(catalogueTarget("openclaw-compatible-anthropic-inference-switch")).toMatchObject({
      targetId: "openclaw-inference-switch",
      profile: "standard",
      testFile: "test/e2e/live/openclaw-inference-switch.test.ts",
      runnerKey: "",
      shard: "anthropic",
      environment: {
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_E2E_SHARD: "anthropic",
        NEMOCLAW_SWITCH_PROVIDER: "compatible-anthropic-endpoint",
        NEMOCLAW_SWITCH_MODEL: "mock-anthropic-model",
        NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
        NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "1",
      },
    });
    expect(catalogueTarget("hermes-compatible-anthropic-inference-switch")).toMatchObject({
      targetId: "hermes-inference-switch",
      profile: "standard",
      testFile: "test/e2e/live/hermes-inference-switch.test.ts",
      runnerKey: "hermes-inference-switch",
      hostPreparation: "hermes-swap",
      runnerComparison: true,
      shard: "anthropic",
      environment: {
        NEMOCLAW_AGENT: "hermes",
        NEMOCLAW_SWITCH_PROVIDER: "compatible-anthropic-endpoint",
        NEMOCLAW_SWITCH_MODEL: "mock-anthropic-model",
        NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
        NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "1",
      },
    });
  });
});
