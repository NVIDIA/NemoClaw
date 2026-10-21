// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
  E2E_TARGET_CATALOGUE,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

describe("inference-switch catalogue boundary", () => {
  it("selects native-local enforcement coverage when IPv6 evidence changes (#13544)", () => {
    expect(
      catalogueTargetsForChangedFiles(["test/e2e/fixtures/native-local-ipv6-evidence.ts"]).map(
        (target) => target.id,
      ),
    ).toContain("inference-routing-openclaw-native");
    expect(
      catalogueTarget("inference-routing-openclaw-native").environmentOrInferenceEndpoint,
    ).toContain("Ubuntu");
    expect(
      catalogueTarget("inference-routing-openclaw-native").environmentOrInferenceEndpoint,
    ).toContain("skips WSL-only TC-INF-19");
  });

  it.each([
    "src/lib/inference/native-provider/contract.ts",
    "src/lib/inference/native-provider/custom-setup.ts",
    "src/lib/inference/native-provider/custom.ts",
    "src/lib/inference/native-provider/hosted.ts",
    "src/lib/onboard/setup-inference.ts",
    "src/lib/actions/inference-set/native.ts",
    "src/lib/actions/inference-set.ts",
    "test/e2e/live/openclaw-inference-switch-helpers.ts",
    "test/e2e/live/openclaw-inference-switch.test.ts",
  ])("selects native Anthropic switch coverage when %s changes (#13195)", (changedFile) => {
    const targetId = "openclaw-compatible-anthropic-inference-switch";
    expect(catalogueTargetsForChangedFiles([changedFile]).map((target) => target.id)).toContain(
      targetId,
    );
    const plan = buildE2eWorkflowPlan(
      {},
      { changedFiles: [changedFile], gatewayRuntimes: ["docker", "podman"] },
    );
    expect(
      plan.catalogueMatrices.standard
        .filter((row) => row.id === targetId)
        .map((row) => row.execution_id)
        .sort(),
    ).toEqual([
      "openclaw-compatible-anthropic-inference-switch-anthropic-docker",
      "openclaw-compatible-anthropic-inference-switch-anthropic-podman",
    ]);
  });

  it("omits native Anthropic switch coverage for unrelated changes (#13195)", () => {
    const changedFiles = ["src/lib/cli/public-display-defaults.ts"];
    const targetId = "openclaw-compatible-anthropic-inference-switch";
    expect(catalogueTargetsForChangedFiles(changedFiles).map((target) => target.id)).not.toContain(
      targetId,
    );
    const plan = buildE2eWorkflowPlan({}, { changedFiles, gatewayRuntimes: ["docker", "podman"] });
    expect(
      Object.values(plan.catalogueMatrices)
        .flat()
        .map((row) => row.id),
    ).not.toContain(targetId);
  });

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

  it("selects native Anthropic through the existing trusted selector (#13195)", () => {
    expect(catalogueTarget("openclaw-compatible-anthropic-inference-switch")).toMatchObject({
      targetId: "openclaw-inference-switch",
      profile: "standard",
      testFile: "test/e2e/live/openclaw-inference-switch.test.ts",
      shard: "anthropic",
      environment: {
        NEMOCLAW_SWITCH_NATIVE_CUSTOM: "1",
        NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
      },
    });
  });

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
