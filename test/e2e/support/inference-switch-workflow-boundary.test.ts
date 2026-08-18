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
        profile: "standard",
        testFile: "test/e2e/live/openclaw-inference-switch.test.ts",
        environment: {
          NEMOCLAW_AGENT: "openclaw",
          NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "1",
        },
      });

      const hermes = catalogueTarget("hermes-inference-switch");
      expect(hermes).toMatchObject({
        profile: "standard",
        testFile: "test/e2e/live/hermes-inference-switch.test.ts",
        hostPreparation: "hermes-swap",
        runnerComparison: true,
        shard: "anthropic",
        environment: {
          NEMOCLAW_AGENT: "hermes",
          NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
          NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "1",
        },
      });
      const target = ({ OpenClaw: openclaw, Hermes: hermes } as const)[scenario]!;
      expect(target.environment).not.toHaveProperty("NEMOCLAW_E2E_USE_HOSTED_INFERENCE");
    },
  );
});
