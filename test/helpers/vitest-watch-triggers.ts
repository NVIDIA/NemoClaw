// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type VitestWatchTriggerPattern = {
  pattern: RegExp;
  testsToRun: (file: string, match: RegExpMatchArray) => string[];
};

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

function runTests(...tests: string[]): () => string[] {
  return () => [...tests];
}

export const vitestWatchTriggerPatterns: VitestWatchTriggerPattern[] = [
  {
    pattern: /(?:^|\/)agents\/hermes\/policy-additions\.yaml$/,
    testsToRun: runTests(
      "src/lib/onboard/initial-policy-real-policy.test.ts",
      "src/lib/onboard/initial-policy.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)src\/lib\/messaging\/channels\/[^/]+\/policy\/(?:hermes|openclaw)\.yaml$/,
    testsToRun: runTests("src/lib/messaging/channels/policy.test.ts"),
  },
  {
    pattern: /(?:^|\/)nemoclaw-blueprint\/policies\/presets\/local-inference\.yaml$/,
    testsToRun: runTests(
      "src/lib/onboard/inference-providers/compatible-endpoint-gateway-route.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)agents\/hermes\/(?:mcp-config-transaction|runtime-config-guard)\.py$/,
    testsToRun: runTests("src/lib/actions/sandbox/gateway-restart-hermes-drift.test.ts"),
  },
  {
    pattern: /(?:^|\/)test\/e2e\/lib\/ci-compatible-inference\.sh$/,
    testsToRun: runTests("test/e2e/support/hosted-inference.test.ts"),
  },
  {
    pattern: /(?:^|\/)scripts\/e2e\/sanitize-trace-timing\.py$/,
    testsToRun: runTests(
      "test/e2e/support/e2e-scorecard.test.ts",
      "test/e2e/support/sanitize-trace-timing.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)test\/e2e\/manifests\/[^/]+\.yaml$/,
    testsToRun: runTests("test/e2e/support/e2e-manifests.test.ts"),
  },
  {
    pattern: /(?:^|\/)test\/e2e\/docs\/parity-inventory\.generated\.json$/,
    testsToRun: runTests("test/e2e/support/e2e-migration-policy.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/e2e\.yaml$/,
    testsToRun: runTests(...E2E_WORKFLOW_CONTRACTS),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/pr-e2e-gate\.yaml$/,
    testsToRun: runTests("test/pr-e2e-gate-workflow.test.ts", "test/pr-e2e-required.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/platform-vitest-main\.yaml|ci\/platform-vitest-macos-requirements\.lock)$/,
    testsToRun: runTests("test/platform-vitest-main-workflow.test.ts"),
  },
];

export function resolveVitestWatchTests(file: string): string[] {
  const normalized = file.replaceAll("\\", "/");
  const tests = new Set<string>();
  for (const trigger of vitestWatchTriggerPatterns) {
    const match = trigger.pattern.exec(normalized);
    if (!match) continue;
    for (const test of trigger.testsToRun(normalized, match)) tests.add(test);
  }
  return [...tests];
}
