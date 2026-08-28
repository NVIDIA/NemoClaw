// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type VitestWatchTriggerPattern = {
  pattern: RegExp;
  testsToRun: (file: string, match: RegExpMatchArray) => string[];
};

const E2E_WORKFLOW_CONTRACTS = [
  "test/e2e/support/base-image-publication-workflow-boundary.test.ts",
  "test/e2e/support/cli-artifact-workflow-boundary.test.ts",
  "test/e2e/support/dcode-profile-import-gate-workflow-boundary.test.ts",
  "test/e2e/support/dockerhub-auth-workflow-boundary.test.ts",
  "test/e2e/support/e2e-host-dependency-workflow-boundary.test.ts",
  "test/e2e/support/e2e-operations-workflow-boundary.test.ts",
  "test/e2e/support/e2e-report-to-pr-workflow-boundary.test.ts",
  "test/e2e/support/e2e-workflow-trace.test.ts",
  "test/e2e/support/hermes-dashboard-workflow-boundary.test.ts",
  "test/e2e/support/hermes-workflow-boundary.test.ts",
  "test/automation/pull-requests/hosted-runner-recovery-workflow.test.ts",
  "test/e2e/support/inference-switch-workflow-boundary.test.ts",
  "test/e2e/support/llama-cpp-dgx-spark-qualification-workflow.test.ts",
  "test/e2e/support/jetson-workflow-boundary.test.ts",
  "test/e2e/support/managed-image-protected-runtime-workflow.test.ts",
  "test/e2e/support/mcp-workflow-boundary.test.ts",
  "test/e2e/support/mcp-workflow-compatibility.test.ts",
  "test/e2e/support/native-runtime-qualification-producer-workflow.test.ts",
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
    pattern: /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/,
    testsToRun: runTests("test/repository/github-actions-workflow-names.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)test\/helpers\/(?:onboard-fixture-contract\.json|onboard-script-mocks\.cjs)$/,
    testsToRun: runTests(
      "test/helpers/onboard-created-sandbox-fixture.test.ts",
      "test/onboarding/onboard-custom-dockerfile.test.ts",
      "test/onboarding/onboard-extra-provider-reconciliation.test.ts",
      "test/onboarding/onboard-fresh-create-identity.test.ts",
      "test/onboarding/onboard-installer-restore-intent.test.ts",
      "test/onboarding/onboard-managed-image-buildless-e2e.test.ts",
      "test/onboarding/onboard-mcp-observability-redirect.test.ts",
      "test/onboarding/onboard-messaging.test.ts",
      "test/onboarding/onboard-prepared-build-context.test.ts",
      "test/onboarding/onboard-reservation-recreate.test.ts",
      "test/onboarding/onboard-sandbox-build.test.ts",
      "test/onboarding/onboard-sandbox-recreation.test.ts",
      "test/onboarding/onboard-script-mocks-contract.test.ts",
      "test/onboarding/onboard-terminal-dashboard.test.ts",
      "test/onboarding/onboard.test.ts",
      "test/security/shellquote-sandbox.test.ts",
      "test/repository/source-require-loader.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)docs\/reference\/troubleshooting\.mdx$/,
    testsToRun: runTests("test/runtime/policy/policy-finality-docs.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/release-daily-brev-image\.yaml|scripts\/release-daily-brev-image\.sh)$/,
    testsToRun: runTests("test/automation/releases/release-daily-brev-image.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/release-lkg-brev-image\.yaml|scripts\/release-lkg-brev-image\.sh)$/,
    testsToRun: runTests("test/automation/releases/release-lkg-brev-image.test.ts"),
  },
  {
    pattern: /(?:^|\/)tools\/e2e\/brev-launchable-e2e\.sh$/,
    testsToRun: runTests(
      "test/e2e-runtime/brev-launchable-e2e.test.ts",
      "test/e2e-runtime/brev-launchable-gateway-diagnostics.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)managed-inference\/(?:models|presets|recipes|schemas)\/[^/]+\.(?:json|yaml)$/,
    testsToRun: runTests(
      "src/lib/inference/serving/catalog.test.ts",
      "src/lib/inference/serving/resolver.test.ts",
      "test/inference/managed/managed-inference-catalog-compiler.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)internal\/security-reviews\/hermes-0\.19\.0-dependency-review\.md$/,
    testsToRun: runTests("test/agents/hermes/hermes-dependency-review.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/actions\/resolve-hermes-base-image\/action\.yaml$/,
    testsToRun: runTests("test/platform/images/base-image-resolver-helper.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/actions\/resolve-reviewed-hermes-platform\/action\.yaml$/,
    testsToRun: runTests(
      "test/agents/hermes/reviewed-hermes-platform-action.test.ts",
      "test/platform/images/protected-managed-image-contract.test.ts",
      "test/e2e/support/managed-image-protected-runtime-workflow.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)agents\/hermes\/Dockerfile\.base$/,
    testsToRun: runTests(
      "test/agents/hermes/hermes-dependency-review.test.ts",
      "test/agents/hermes/hermes-share-mount-deps.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/runtime/sandbox/sandbox-provisioning.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)(agents\/(?:hermes|langchain-deepagents-code)\/)?Dockerfile$/,
    testsToRun: (_file, match) => {
      if (match[1] === "agents/hermes/") {
        return [
          "src/lib/onboard/managed-startup-profile.test.ts",
          "test/agents/hermes/hermes-mcp-runtime-capability.test.ts",
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
    testsToRun: runTests("test/agents/openclaw/runtime/pi-candidate-runtime-artifacts.test.ts"),
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
    testsToRun: runTests("test/onboarding/effective-policy-contracts.test.ts"),
  },
  {
    pattern: /(?:^|\/)nemoclaw-blueprint\/policies\/presets\/claude-code\.yaml$/,
    testsToRun: runTests("test/onboarding/effective-policy-contracts.test.ts"),
  },
  {
    pattern: /(?:^|\/)agents\/hermes\/runtime-config-guard\.py$/,
    testsToRun: runTests("src/lib/actions/sandbox/gateway-restart-hermes-drift.test.ts"),
  },
  {
    pattern: /(?:^|\/)agents\/hermes\/mcp-config-transaction\.py$/,
    testsToRun: runTests(
      "src/lib/actions/sandbox/gateway-restart-hermes-drift.test.ts",
      "test/agents/hermes/hermes-mcp-credential-revision.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)test\/e2e\/lib\/ci-compatible-inference\.sh$/,
    testsToRun: runTests("test/e2e/support/hosted-inference.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)nemoclaw\/(?:src\/shared\/openshell-policy-boundary\.cts|tsconfig\.shared\.json)$/,
    testsToRun: runTests("test/e2e/support/hermes-discord-policy-binding.test.ts"),
  },
  {
    pattern: /(?:^|\/)scripts\/setup-jetson\.sh$/,
    testsToRun: runTests("test/install/setup-jetson.test.ts"),
  },
  {
    pattern: /(?:^|\/)tools\/e2e\/contracts\/v1\/jetson-dispatch\.json$/,
    testsToRun: runTests("test/e2e/support/jetson-dispatch-client.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/base-image\.yaml|scripts\/export-managed-base-image-contract\.sh)$/,
    testsToRun: runTests(
      "test/inference/managed/managed-base-image-contract.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/managed-images\.yaml$/,
    testsToRun: runTests(
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/e2e-runtime/pull-public-exact-digest.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)test\/e2e\/live\/managed-image-activation-e2e-helpers\.ts$/,
    testsToRun: runTests("test/inference/managed/managed-image-publication-workflow.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/actions\/build-base-image-platform\/action\.yaml$/,
    testsToRun: runTests(
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
      "test/agents/openclaw/openclaw-dependency-review.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)\.github\/actions\/publish-base-image-manifest\//,
    testsToRun: runTests(
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/platform/images/publish-base-image-manifest.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/base-image-platform\.yaml$/,
    testsToRun: runTests(
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/install/perl-critical-cve-remediation.test.ts",
      "test/agents/openclaw/runtime/pi-candidate-runtime-artifacts.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)scripts\/checks\/validate-managed-base-index\.sh$/,
    testsToRun: runTests("test/inference/managed/validate-managed-base-index.test.ts"),
  },
  {
    pattern: /(?:^|\/)scripts\/checks\/download-hermes-source-archive[.]sh$/,
    testsToRun: runTests(
      "test/agents/hermes/hermes-share-mount-deps.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)scripts\/checks\/retry-docker-imagetools-inspect\.sh$/,
    testsToRun: runTests(
      "test/platform/images/retry-docker-imagetools-inspect.test.ts",
      "test/inference/managed/validate-managed-base-index.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)scripts\/checks\/pull-public-exact-digest\.sh$/,
    testsToRun: runTests(
      "test/e2e-runtime/pull-public-exact-digest.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
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
    pattern: /(?:^|\/)\.github\/workflows\/(?:pr-self-hosted|sandbox-images-and-e2e)\.yaml$/,
    testsToRun: runTests("test/e2e/support/sandbox-images-workflow-boundary.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/code-scanning\.yaml$/,
    testsToRun: runTests("test/repository/code-scanning-workflow.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/pr-merge-conflict-fixer\.yaml$/,
    testsToRun: runTests(
      "test/automation/pull-requests/pr-merge-conflict-fixer-workflow-boundary.test.ts",
    ),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/post-merge-docs\.yaml|tools\/post-merge-docs\/(?:review-policy\.yaml|[^/]+\.mts))$/,
    testsToRun: runTests("test/generation/post-merge-docs.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/pr-review-advisor\.yaml$/,
    testsToRun: runTests(
      "test/automation/pull-requests/pr-review-advisor-workflow-boundary.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)tools\/pr-review-advisor\/openshell-policy\.yaml$/,
    testsToRun: runTests(
      "test/automation/pull-requests/pr-review-advisor-workflow-boundary.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/e2e-main-retry\.yaml$/,
    testsToRun: runTests("test/e2e/support/main-run-retry.test.ts"),
  },
  {
    pattern: /(?:^|\/)\.github\/workflows\/(?:hosted-runner-recovery|platform-vitest-main)\.yaml$/,
    testsToRun: runTests("test/automation/pull-requests/hosted-runner-recovery-workflow.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/platform-vitest-main\.yaml|tools\/wsl\/ci-helper\.ps1)$/,
    testsToRun: runTests(
      "test/automation/e2e/platform-vitest-main-workflow.test.ts",
      "test/automation/e2e/wsl-ci-helper.test.ts",
    ),
  },
  {
    pattern: /(?:^|\/)ci\/platform-vitest-macos-requirements\.lock$/,
    testsToRun: runTests("test/automation/e2e/platform-vitest-main-workflow.test.ts"),
  },
  {
    pattern:
      /(?:^|\/)\.agents\/skills\/(?:nemoclaw-maintainer-cut-release-tag\/SKILL\.md|nemoclaw-maintainer-evening\/SKILL\.md|nemoclaw-maintainer-release-notes\/SKILL\.md|nemoclaw-maintainer-policies\/references\/release-train\.md)$/,
    testsToRun: runTests("test/automation/releases/release-post-tag-follow-through.test.ts"),
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
