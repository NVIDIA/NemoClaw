// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type VitestWatchTriggerPattern = {
  pattern: RegExp;
  testsToRun: (file: string, match: RegExpMatchArray) => string[];
};

const E2E_WORKFLOW_CONTRACTS = [
  "test/e2e/support/dcode-profile-import-gate-workflow-boundary.test.ts",
  "test/e2e/support/dockerhub-auth-workflow-boundary.test.ts",
  "test/e2e/support/e2e-host-dependency-workflow-boundary.test.ts",
  "test/e2e/support/e2e-operations-workflow-boundary.test.ts",
  "test/e2e/support/e2e-report-to-pr-workflow-boundary.test.ts",
  "test/e2e/support/e2e-workflow-trace.test.ts",
  "test/e2e/support/hermes-dashboard-workflow-boundary.test.ts",
  "test/e2e/support/hermes-workflow-boundary.test.ts",
  "test/hosted-runner-recovery-workflow.test.ts",
  "test/e2e/support/inference-switch-workflow-boundary.test.ts",
  "test/e2e/support/llama-cpp-dgx-spark-qualification-workflow.test.ts",
  "test/e2e/support/jetson-workflow-boundary.test.ts",
  "test/e2e/support/mcp-workflow-boundary.test.ts",
  "test/e2e/support/mcp-workflow-compatibility.test.ts",
  "test/e2e/support/openclaw-plugin-runtime-exdev-workflow-boundary.test.ts",
  "test/e2e/support/onboard-timeout-contract.test.ts",
  "test/e2e/support/openshell-gateway-auth-contract-workflow-boundary.test.ts",
  "test/e2e/support/openshell-gateway-upgrade-workflow-boundary.test.ts",
  "test/e2e/support/prepare-e2e-workflow-boundary.test.ts",
  "test/e2e/support/runner-pressure-workflow-boundary.test.ts",
  "test/e2e/support/sandbox-images-workflow-boundary.test.ts",
  "test/e2e/support/security-posture-workflow-boundary.test.ts",
  "test/e2e/support/shared-e2e-workflow-boundary.test.ts",
  "test/e2e/support/staging-brev-launchable-identity-workflow-boundary.test.ts",
  "test/e2e/support/standard-profile-workflow-boundary.test.ts",
  "test/e2e/support/trusted-hermes-swap-workflow-boundary.test.ts",
  "test/e2e/support/upload-e2e-artifacts-workflow-boundary.test.ts",
  "test/e2e/support/workflow-plan.test.ts",
] as const;

function runTests(...tests: string[]): () => string[] {
  return () => [...tests];
}

export const vitestWatchTriggerPatterns: VitestWatchTriggerPattern[] = [
  {
    pattern: /(?:^|\/)docs\/reference\/troubleshooting\.mdx$/,
    testsToRun: runTests("test/policy-finality-docs.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/release-daily-brev-image\.yaml|scripts\/release-daily-brev-image\.sh)$/,
    testsToRun: runTests("test/release-daily-brev-image.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/release-lkg-brev-image\.yaml|scripts\/release-lkg-brev-image\.sh)$/,
    testsToRun: runTests("test/release-lkg-brev-image.test.ts"),
  },
  {
    pattern: /(?:^|\/)tools\/e2e\/brev-launchable-e2e\.sh$/,
    testsToRun: runTests("test/brev-launchable-e2e.test.ts"),
  },
  {
    pattern: /(?:^|\/)managed-inference\/(?:models|presets|recipes|schemas)\/[^/]+\.(?:json|yaml)$/,
    testsToRun: runTests(
      "src/lib/inference/serving/catalog.test.ts",
      "src/lib/inference/serving/resolver.test.ts",
      "test/managed-inference-catalog-compiler.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)internal\/security-reviews\/hermes-0\.19\.0-dependency-review\.md$/,
    testsToRun: runTests("test/hermes-dependency-review.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/actions\/resolve-hermes-base-image\/action\.yaml$/,
    testsToRun: runTests("test/base-image-resolver-helper.test.ts"),
  },
  {
    pattern: /(?:^|\/)agents\/hermes\/Dockerfile\.base$/,
    testsToRun: runTests(
      "test/hermes-dependency-review.test.ts",
      "test/hermes-share-mount-deps.test.ts",
      "test/managed-image-publication-workflow.test.ts",
      "test/sandbox-provisioning.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)(agents\/(?:hermes|langchain-deepagents-code)\/)?Dockerfile$/,
    testsToRun: (_file, match) => {
      if (match[1] === "agents/hermes/") {
        return [
          "src/lib/onboard/managed-startup-profile.test.ts",
          "test/hermes-mcp-runtime-capability.test.ts",
        ];
      }
      return match[1]
        ? ["src/lib/onboard/managed-startup-profile.test.ts"]
        : [
            "src/lib/onboard/managed-startup-profile.test.ts",
            "src/lib/sandbox/optimized-build-context-copy-sources.test.ts",
          ];
    },
  },
  {
    pattern: /(?:^|\/)agents\/hermes\/policy-additions\.yaml$/,
    testsToRun: runTests(
      "src/lib/onboard/initial-policy-real-policy.test.ts",
      "src/lib/onboard/initial-policy.test.ts",
    ),
  },
  {
    pattern:
      /(?:^|\/)(?:agents\/pi\/(?:Dockerfile(?:\.base)?|dependency-review\.md|generate-config\.ts|manifest\.yaml|policy-additions\.yaml|start\.sh|pi-runtime\/package(?:-lock)?\.json)|\.github\/workflows\/(?:managed-images|base-image)\.yaml)$/,
    testsToRun: runTests("test/pi-candidate-runtime-artifacts.test.ts"),
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
    pattern: /(?:^|\/)nemoclaw-blueprint\/policies\/presets\/local-memory\.yaml$/,
    testsToRun: runTests("test/effective-policy-contracts.test.ts"),
  },
  {
    pattern: /(?:^|\/)nemoclaw-blueprint\/policies\/presets\/claude-code\.yaml$/,
    testsToRun: runTests("test/effective-policy-contracts.test.ts"),
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
    pattern: /(?:^|\/)scripts\/setup-jetson\.sh$/,
    testsToRun: runTests("test/setup-jetson.test.ts"),
  },
  {
    pattern: /(?:^|\/)tools\/e2e\/contracts\/v1\/jetson-dispatch\.json$/,
    testsToRun: runTests("test/e2e/support/jetson-dispatch-client.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/base-image\.yaml|scripts\/export-managed-base-image-contract\.sh)$/,
    testsToRun: runTests(
      "test/managed-base-image-contract.test.ts",
      "test/managed-image-publication-workflow.test.ts",
      "test/dcode-base-image-workflow.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/managed-images\.yaml$/,
    testsToRun: runTests(
      "test/managed-image-publication-workflow.test.ts",
      "test/pull-public-exact-digest.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)\.github\/actions\/build-base-image-platform\/action\.yaml$/,
    testsToRun: runTests(
      "test/dcode-base-image-workflow.test.ts",
      "test/openclaw-dependency-review.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/base-image-platform\.yaml$/,
    testsToRun: runTests(
      "test/dcode-base-image-workflow.test.ts",
      "test/managed-image-publication-workflow.test.ts",
      "test/perl-critical-cve-remediation.test.ts",
      "test/pi-candidate-runtime-artifacts.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)scripts\/checks\/validate-managed-base-index\.sh$/,
    testsToRun: runTests("test/validate-managed-base-index.test.ts"),
  },
  {
    pattern: /(?:^|\/)scripts\/checks\/download-hermes-source-archive[.]sh$/,
    testsToRun: runTests(
      "test/hermes-share-mount-deps.test.ts",
      "test/managed-image-publication-workflow.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)scripts\/checks\/retry-docker-imagetools-inspect\.sh$/,
    testsToRun: runTests(
      "test/retry-docker-imagetools-inspect.test.ts",
      "test/validate-managed-base-index.test.ts",
      "test/managed-image-publication-workflow.test.ts",
      "test/dcode-base-image-workflow.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)scripts\/checks\/pull-public-exact-digest\.sh$/,
    testsToRun: runTests(
      "test/pull-public-exact-digest.test.ts",
      "test/managed-image-publication-workflow.test.ts",
    ),
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
    pattern: /(?:^|\/)\.github\/workflows\/e2e\.yaml$/,
    testsToRun: runTests(...E2E_WORKFLOW_CONTRACTS),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/e2e-standard-profile\.yaml$/,
    testsToRun: runTests("test/e2e/support/standard-profile-workflow-boundary.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/portable-profile-e2e\.yaml$/,
    testsToRun: runTests(
      "test/e2e/support/portable-profile-rootless-runtime-workflow.test.ts",
      "test/e2e/support/portable-profile-systemctl-shim.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)test\/e2e\/live\/portable-profile-rootless-linux\.test\.ts$/,
    testsToRun: runTests("test/e2e/support/portable-profile-rootless-runtime-workflow.test.ts"),
  },
  {
    pattern: /(?:^|\/)test\/e2e\/fixtures\/portable-profile-systemctl-shim\.sh$/,
    testsToRun: runTests("test/e2e/support/portable-profile-systemctl-shim.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)\.github\/(?:actions\/docker-auth-(?:cleanup|setup)\/action\.yaml|scripts\/docker-auth-(?:cleanup|setup)\.sh)$/,
    testsToRun: runTests("test/e2e/support/dockerhub-auth-workflow-boundary.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/sandbox-images-and-e2e\.yaml$/,
    testsToRun: runTests("test/e2e/support/sandbox-images-workflow-boundary.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/code-scanning\.yaml$/,
    testsToRun: runTests("test/code-scanning-workflow.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/pr-merge-conflict-fixer\.yaml$/,
    testsToRun: runTests("test/pr-merge-conflict-fixer-workflow-boundary.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/post-merge-docs\.yaml|tools\/post-merge-docs\/(?:review-policy\.yaml|[^/]+\.mts))$/,
    testsToRun: runTests("test/post-merge-docs.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/pr-review-advisor\.yaml$/,
    testsToRun: runTests(
      "test/pr-review-advisor-workflow-boundary.test.ts",
      "test/pr-review-advisor-openshell-workflow-boundary.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)tools\/pr-review-advisor\/openshell-policy\.yaml$/,
    testsToRun: runTests("test/pr-review-advisor-openshell-workflow-boundary.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/e2e-main-retry\.yaml$/,
    testsToRun: runTests("test/e2e-main-retry-workflow.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/(?:hosted-runner-recovery|platform-vitest-main)\.yaml$/,
    testsToRun: runTests("test/hosted-runner-recovery-workflow.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/platform-vitest-main\.yaml|tools\/wsl\/ci-helper\.ps1)$/,
    testsToRun: runTests(
      "test/platform-vitest-main-workflow.test.ts",
      "test/wsl-ci-helper.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)ci\/platform-vitest-macos-requirements\.lock$/,
    testsToRun: runTests("test/platform-vitest-main-workflow.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)\.agents\/skills\/(?:nemoclaw-maintainer-cut-release-tag\/SKILL\.md|nemoclaw-maintainer-evening\/SKILL\.md|nemoclaw-maintainer-release-notes\/SKILL\.md|nemoclaw-maintainer-policies\/references\/release-train\.md)$/,
    testsToRun: runTests("test/release-post-tag-follow-through.test.ts"),
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
