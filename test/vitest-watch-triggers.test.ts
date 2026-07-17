// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import rootVitestConfig from "../vitest.config";
import {
  resolveVitestWatchTests,
  vitestWatchTriggerPatterns,
} from "./helpers/vitest-watch-triggers";

const E2E_WORKFLOW_CONTRACTS = [
  "test/e2e/support/channels-add-remove-workflow-boundary.test.ts",
  "test/e2e/support/dcode-profile-import-gate-workflow-boundary.test.ts",
  "test/e2e/support/dockerhub-auth-workflow-boundary.test.ts",
  "test/e2e/support/e2e-host-dependency-workflow-boundary.test.ts",
  "test/e2e/support/e2e-operations-workflow-boundary.test.ts",
  "test/e2e/support/e2e-report-to-pr-workflow-boundary.test.ts",
  "test/e2e/support/e2e-workflow.test.ts",
  "test/e2e/support/e2e-workflow-trace.test.ts",
  "test/e2e/support/gateway-guard-workflow-boundary.test.ts",
  "test/e2e/support/hermes-dashboard-workflow-boundary.test.ts",
  "test/e2e/support/hermes-workflow-boundary.test.ts",
  "test/e2e/support/inference-switch-workflow-boundary.test.ts",
  "test/e2e/support/jetson-workflow-boundary.test.ts",
  "test/e2e/support/mcp-workflow-boundary.test.ts",
  "test/e2e/support/mcp-workflow-compatibility.test.ts",
  "test/e2e/support/openclaw-discord-workflow-boundary.test.ts",
  "test/e2e/support/openclaw-plugin-runtime-exdev-workflow-boundary.test.ts",
  "test/e2e/support/openclaw-slack-workflow-boundary.test.ts",
  "test/e2e/support/openshell-gateway-auth-contract-workflow-boundary.test.ts",
  "test/e2e/support/openshell-gateway-upgrade-workflow-boundary.test.ts",
  "test/e2e/support/prepare-e2e-workflow-boundary.test.ts",
  "test/e2e/support/sandbox-images-workflow-boundary.test.ts",
  "test/e2e/support/sandbox-operations-workflow-boundary.test.ts",
  "test/e2e/support/security-posture-workflow-boundary.test.ts",
  "test/e2e/support/shared-e2e-workflow-boundary.test.ts",
  "test/e2e/support/spark-install-workflow-boundary.test.ts",
  "test/e2e/support/tunnel-lifecycle-workflow-boundary.test.ts",
  "test/e2e/support/upload-e2e-artifacts-workflow-boundary.test.ts",
  "test/e2e/support/workflow-plan.test.ts",
] as const;

const OPAQUE_INPUTS = [
  "agents/hermes/policy-additions.yaml",
  "src/lib/messaging/channels/telegram/policy/openclaw.yaml",
  "nemoclaw-blueprint/policies/presets/local-inference.yaml",
  "agents/hermes/runtime-config-guard.py",
  "agents/hermes/mcp-config-transaction.py",
  "test/e2e/lib/ci-compatible-inference.sh",
  "scripts/e2e/sanitize-trace-timing.py",
  "test/e2e/manifests/openclaw-nvidia.yaml",
  "test/e2e/docs/parity-inventory.generated.json",
  ".github/workflows/e2e.yaml",
  ".github/workflows/pr-e2e-gate.yaml",
  ".github/workflows/platform-vitest-main.yaml",
  "ci/platform-vitest-macos-requirements.lock",
] as const;

function triggeredBy(relativePath: string): string[] {
  return resolveVitestWatchTests(path.resolve(relativePath));
}

describe("Vitest opaque-input watch triggers", () => {
  // source-shape-contract: compatibility -- Root watch mode must install the canonical opaque-input trigger resolver
  it("registers the focused mappings at the root configuration boundary (#6692)", () => {
    expect(rootVitestConfig.test?.watchTriggerPatterns).toBe(vitestWatchTriggerPatterns);
  });

  it("maps current opaque inputs to their direct contract tests (#6692)", () => {
    expect(triggeredBy("agents/hermes/policy-additions.yaml")).toEqual([
      "src/lib/onboard/initial-policy-real-policy.test.ts",
      "src/lib/onboard/initial-policy.test.ts",
    ]);
    expect(triggeredBy("src/lib/messaging/channels/telegram/policy/openclaw.yaml")).toEqual([
      "src/lib/messaging/channels/policy.test.ts",
    ]);
    expect(triggeredBy("nemoclaw-blueprint/policies/presets/local-inference.yaml")).toEqual([
      "src/lib/onboard/inference-providers/compatible-endpoint-gateway-route.test.ts",
    ]);
    expect(triggeredBy("agents/hermes/runtime-config-guard.py")).toEqual([
      "src/lib/actions/sandbox/gateway-restart-hermes-drift.test.ts",
    ]);
    expect(triggeredBy("agents/hermes/mcp-config-transaction.py")).toEqual([
      "src/lib/actions/sandbox/gateway-restart-hermes-drift.test.ts",
    ]);
    expect(triggeredBy("test/e2e/lib/ci-compatible-inference.sh")).toEqual([
      "test/e2e/support/hosted-inference.test.ts",
    ]);
    expect(triggeredBy("scripts/e2e/sanitize-trace-timing.py")).toEqual([
      "test/e2e/support/e2e-scorecard.test.ts",
      "test/e2e/support/sanitize-trace-timing.test.ts",
    ]);
    expect(triggeredBy("test/e2e/manifests/openclaw-nvidia.yaml")).toEqual([
      "test/e2e/support/e2e-manifests.test.ts",
    ]);
    expect(triggeredBy("test/e2e/manifests/openclaw-nvidia.yml")).toEqual([]);
    expect(triggeredBy("test/e2e/docs/parity-inventory.generated.json")).toEqual([
      "test/e2e/support/e2e-migration-policy.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/e2e.yaml")).toEqual(E2E_WORKFLOW_CONTRACTS);
    expect(triggeredBy(".github/workflows/pr-e2e-gate.yaml")).toEqual([
      "test/pr-e2e-gate-workflow.test.ts",
      "test/pr-e2e-required.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/platform-vitest-main.yaml")).toEqual([
      "test/platform-vitest-main-workflow.test.ts",
    ]);
    expect(triggeredBy("ci/platform-vitest-macos-requirements.lock")).toEqual([
      "test/platform-vitest-main-workflow.test.ts",
    ]);
  });

  it("returns only concrete test files that exist (#6692)", () => {
    const triggeredTests = new Set(OPAQUE_INPUTS.flatMap(triggeredBy));

    expect(triggeredTests.size).toBeGreaterThan(0);
    for (const testFile of triggeredTests) {
      expect(testFile).toMatch(/\.test\.ts$/);
      expect(testFile).not.toMatch(/[?*{}[\]]/);
      expect(fs.existsSync(testFile), testFile).toBe(true);
    }
    for (const trigger of vitestWatchTriggerPatterns) {
      expect(trigger.pattern.global).toBe(false);
      expect(trigger.pattern.sticky).toBe(false);
    }
  });

  it("leaves unrelated YAML, shell, Python, and workflow files alone (#6692)", () => {
    expect(triggeredBy("notes/example.yaml")).toEqual([]);
    expect(triggeredBy("scripts/unrelated.py")).toEqual([]);
    expect(triggeredBy("test/e2e/lib/unrelated.sh")).toEqual([]);
    expect(triggeredBy("agents/hermes/hermes-wrapper.py")).toEqual([]);
    expect(triggeredBy(".github/workflows/regression-e2e.yaml")).toEqual([]);
  });

  it("normalizes Windows-style paths before matching (#6692)", () => {
    expect(
      resolveVitestWatchTests("C:\\workspace\\NemoClaw\\scripts\\e2e\\sanitize-trace-timing.py"),
    ).toEqual([
      "test/e2e/support/e2e-scorecard.test.ts",
      "test/e2e/support/sanitize-trace-timing.test.ts",
    ]);
  });
});
