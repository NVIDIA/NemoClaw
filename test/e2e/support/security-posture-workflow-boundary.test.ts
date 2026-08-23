// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  catalogueTarget,
  E2E_TARGET_CATALOGUE,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";

describe("security-posture catalogue boundary", () => {
  it.each([{ scenario: "OpenClaw" }, { scenario: "Hermes" }])(
    "keeps one credential-free posture target per agent [$scenario]",
    ({ scenario }) => {
      expect(() => validateE2eTargetCatalogue(E2E_TARGET_CATALOGUE)).not.toThrow();
      const openclaw = catalogueTarget("security-posture-openclaw");
      const hermes = catalogueTarget("security-posture-hermes");

      const target = ({ OpenClaw: openclaw, Hermes: hermes } as const)[scenario]!;
      expect(target).toMatchObject({
        targetId: "security-posture",
        profile: "nvidia-inference",
        installMode: "credential-free",
        restoreCli: true,
        artifactLayout: "flat-shard",
        environment: {
          NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS: "1",
          NEMOCLAW_E2E_SECURITY_POSTURE: "1",
        },
      });

      expect(openclaw).toMatchObject({
        shard: "openclaw",
        testFile: "test/e2e/live/full-e2e.test.ts",
      });
      expect(hermes).toMatchObject({
        shard: "hermes",
        testFile: "test/e2e/live/hermes-e2e.test.ts",
        hostPreparation: "hermes-swap",
        runnerComparison: true,
      });
    },
  );
});
