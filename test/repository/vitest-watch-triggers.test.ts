// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveVitestWatchTests,
  vitestWatchTriggerPatterns,
} from "../helpers/vitest-watch-triggers";

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

const OPAQUE_INPUTS = [
  ".github/workflows/release-daily-brev-image.yaml",
  "test/helpers/onboard-script-mocks.cjs",
  "scripts/release-daily-brev-image.sh",
  ".github/workflows/release-lkg-brev-image.yaml",
  "scripts/release-lkg-brev-image.sh",
  "tools/e2e/brev-launchable-e2e.sh",
  "managed-inference/models/example.yaml",
  "managed-inference/recipes/vllm.example.managed-cluster.v1.yaml",
  "internal/security-reviews/hermes-0.19.0-dependency-review.md",
  ".github/actions/resolve-hermes-base-image/action.yaml",
  ".github/actions/resolve-reviewed-hermes-platform/action.yaml",
  "Dockerfile",
  "agents/hermes/Dockerfile.base",
  "agents/hermes/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile",
  "agents/hermes/policy-additions.yaml",
  "src/lib/messaging/channels/telegram/policy/openclaw.yaml",
  "nemoclaw-blueprint/policies/presets/local-inference.yaml",
  "nemoclaw-blueprint/policies/presets/claude-code.yaml",
  "agents/hermes/runtime-config-guard.py",
  "agents/hermes/mcp-config-transaction.py",
  "test/e2e/lib/ci-compatible-inference.sh",
  "nemoclaw/src/shared/openshell-policy-boundary.cts",
  "nemoclaw/tsconfig.shared.json",
  "scripts/setup-jetson.sh",
  "tools/e2e/contracts/v1/jetson-dispatch.json",
  ".github/workflows/base-image.yaml",
  ".github/workflows/base-image-platform.yaml",
  "test/e2e/live/managed-image-activation-e2e-helpers.ts",
  "scripts/export-managed-base-image-contract.sh",
  "scripts/checks/download-hermes-source-archive.sh",
  "scripts/checks/validate-managed-base-index.sh",
  "scripts/e2e/sanitize-trace-timing.py",
  "test/e2e/manifests/openclaw-nvidia.yaml",
  ".github/workflows/e2e.yaml",
  ".github/workflows/e2e-standard-profile.yaml",
  ".github/workflows/portable-profile-e2e.yaml",
  "test/e2e/fixtures/portable-profile-systemctl-shim.sh",
  ".github/actions/docker-auth-setup/action.yaml",
  ".github/actions/docker-auth-cleanup/action.yaml",
  ".github/scripts/docker-auth-setup.sh",
  ".github/scripts/docker-auth-cleanup.sh",
  ".github/workflows/pr-self-hosted.yaml",
  ".github/workflows/sandbox-images-and-e2e.yaml",
  ".github/workflows/code-scanning.yaml",
  ".github/workflows/post-merge-docs.yaml",
  "tools/post-merge-docs/review-policy.yaml",
  "tools/post-merge-docs/artifact.mts",
  ".github/workflows/pr-review-advisor.yaml",
  "tools/pr-review-advisor/openshell-policy.yaml",
  ".github/workflows/hosted-runner-recovery.yaml",
  ".github/workflows/platform-vitest-main.yaml",
  "tools/wsl/ci-helper.ps1",
  "ci/platform-vitest-macos-requirements.lock",
  ".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md",
  ".agents/skills/nemoclaw-maintainer-evening/SKILL.md",
  ".agents/skills/nemoclaw-maintainer-release-notes/SKILL.md",
  ".agents/skills/nemoclaw-maintainer-policies/references/release-train.md",
] as const;

const WORKFLOW_NAME_TEST = "test/repository/github-actions-workflow-names.test.ts";

function triggeredBy(relativePath: string): string[] {
  return resolveVitestWatchTests(path.resolve(relativePath)).filter(
    (test) => test !== WORKFLOW_NAME_TEST,
  );
}

describe("Vitest opaque-input watch triggers", () => {
  it("maps the onboard child-process preload to its managed-image fixtures", () => {
    expect(triggeredBy("test/helpers/onboard-script-mocks.cjs")).toEqual([
      "test/onboarding/onboard-extra-provider-reconciliation.test.ts",
      "test/onboarding/onboard-installer-restore-intent.test.ts",
      "test/onboarding/onboard-messaging.test.ts",
      "test/onboarding/onboard-reservation-recreate.test.ts",
      "test/onboarding/onboard-sandbox-build.test.ts",
      "test/onboarding/onboard-sandbox-recreation.test.ts",
      "test/onboarding/onboard-terminal-dashboard.test.ts",
      "test/repository/source-require-loader.test.ts",
    ]);
  });

  it.each([".github/workflows/pr.yaml", ".github/workflows/pr.yml"])(
    "maps YAML workflow files to the shared display-name contract [%s]",
    (workflowPath) => {
      expect(resolveVitestWatchTests(path.resolve(workflowPath))).toContain(WORKFLOW_NAME_TEST);
    },
  );

  it.each([
    ".github/workflows/release-daily-brev-image.yaml",
    "scripts/release-daily-brev-image.sh",
  ])("maps each daily image caller input to its contract test [%s] (#9799)", (inputPath) => {
    expect(triggeredBy(inputPath)).toEqual(["test/automation/releases/release-daily-brev-image.test.ts"]);
  });

  it.each([".github/workflows/release-lkg-brev-image.yaml", "scripts/release-lkg-brev-image.sh"])(
    "maps each LKG image caller input to its contract test [%s] (#9798)",
    (inputPath) => {
      expect(triggeredBy(inputPath)).toEqual(["test/automation/releases/release-lkg-brev-image.test.ts"]);
    },
  );

  it("maps the Launchable host harness to its integration tests (#6409)", () => {
    expect(triggeredBy("tools/e2e/brev-launchable-e2e.sh")).toEqual([
      "test/e2e-runtime/brev-launchable-e2e.test.ts",
      "test/e2e-runtime/brev-launchable-gateway-diagnostics.test.ts",
    ]);
  });

  it.each([
    "nemoclaw/src/shared/openshell-policy-boundary.cts",
    "nemoclaw/tsconfig.shared.json",
  ])("maps each policy compiler input to its spawned fixture contract [%s] (#10016)", (inputPath) => {
    expect(triggeredBy(inputPath)).toEqual([
      "test/e2e/support/hermes-discord-policy-binding.test.ts",
    ]);
  });

  it.each([
    ".github/actions/docker-auth-setup/action.yaml",
    ".github/actions/docker-auth-cleanup/action.yaml",
    ".github/scripts/docker-auth-setup.sh",
    ".github/scripts/docker-auth-cleanup.sh",
  ])("maps current opaque inputs to their direct contract tests [%s] (#6692)", (authPath) => {
    expect(triggeredBy("managed-inference/models/example.yaml")).toEqual([
      "src/lib/inference/serving/catalog.test.ts",
      "src/lib/inference/serving/resolver.test.ts",
      "test/inference/managed/managed-inference-catalog-compiler.test.ts",
    ]);
    expect(triggeredBy("managed-inference/recipes/vllm.example.managed-cluster.v1.yaml")).toEqual([
      "src/lib/inference/serving/catalog.test.ts",
      "src/lib/inference/serving/resolver.test.ts",
      "test/inference/managed/managed-inference-catalog-compiler.test.ts",
    ]);
    expect(triggeredBy("internal/security-reviews/hermes-0.19.0-dependency-review.md")).toEqual([
      "test/agents/hermes/hermes-dependency-review.test.ts",
    ]);
    expect(triggeredBy(".github/actions/resolve-hermes-base-image/action.yaml")).toEqual([
      "test/platform/images/base-image-resolver-helper.test.ts",
    ]);
    expect(
      triggeredBy(".github/actions/resolve-reviewed-hermes-platform/action.yaml"),
    ).toEqual([
      "test/agents/hermes/reviewed-hermes-platform-action.test.ts",
      "test/platform/images/protected-managed-image-contract.test.ts",
      "test/e2e/support/managed-image-protected-runtime-workflow.test.ts",
    ]);
    expect(triggeredBy("Dockerfile")).toEqual([
      "src/lib/onboard/managed-startup-profile.test.ts",
      "src/lib/sandbox/optimized-build-context-copy-sources.test.ts",
    ]);
    expect(triggeredBy("agents/hermes/Dockerfile.base")).toEqual([
      "test/agents/hermes/hermes-dependency-review.test.ts",
      "test/agents/hermes/hermes-share-mount-deps.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/runtime/sandbox/sandbox-provisioning.test.ts",
    ]);
    expect(triggeredBy("agents/hermes/Dockerfile")).toEqual([
      "src/lib/onboard/managed-startup-profile.test.ts",
      "test/agents/hermes/hermes-mcp-runtime-capability.test.ts",
    ]);
    expect(triggeredBy("scripts/checks/download-hermes-source-archive.sh")).toEqual([
      "test/agents/hermes/hermes-share-mount-deps.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
    ]);
    expect(triggeredBy("agents/langchain-deepagents-code/Dockerfile")).toEqual([
      "src/lib/onboard/managed-startup-profile.test.ts",
    ]);
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
    expect(triggeredBy("nemoclaw-blueprint/policies/presets/claude-code.yaml")).toEqual([
      "test/onboarding/effective-policy-contracts.test.ts",
    ]);
    expect(triggeredBy("agents/hermes/runtime-config-guard.py")).toEqual([
      "src/lib/actions/sandbox/gateway-restart-hermes-drift.test.ts",
    ]);
    expect(triggeredBy("agents/hermes/mcp-config-transaction.py")).toEqual([
      "src/lib/actions/sandbox/gateway-restart-hermes-drift.test.ts",
      "test/agents/hermes/hermes-mcp-credential-revision.test.ts",
    ]);
    expect(triggeredBy("test/e2e/lib/ci-compatible-inference.sh")).toEqual([
      "test/e2e/support/hosted-inference.test.ts",
    ]);
    expect(triggeredBy("scripts/setup-jetson.sh")).toEqual(["test/install/setup-jetson.test.ts"]);
    expect(triggeredBy("tools/e2e/contracts/v1/jetson-dispatch.json")).toEqual([
      "test/e2e/support/jetson-dispatch-client.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/base-image.yaml")).toEqual([
      "test/agents/openclaw/runtime/pi-candidate-runtime-artifacts.test.ts",
      "test/inference/managed/managed-base-image-contract.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/managed-images.yaml")).toEqual([
      "test/agents/openclaw/runtime/pi-candidate-runtime-artifacts.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/e2e-runtime/pull-public-exact-digest.test.ts",
    ]);
    expect(triggeredBy("test/e2e/live/managed-image-activation-e2e-helpers.ts")).toEqual([
      "test/inference/managed/managed-image-publication-workflow.test.ts",
    ]);
    expect(triggeredBy("scripts/export-managed-base-image-contract.sh")).toEqual([
      "test/inference/managed/managed-base-image-contract.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
    ]);
    expect(triggeredBy(".github/actions/build-base-image-platform/action.yaml")).toEqual([
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
      "test/agents/openclaw/openclaw-dependency-review.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
    ]);
    expect(triggeredBy(".github/actions/publish-base-image-manifest/action.yaml")).toEqual([
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/platform/images/publish-base-image-manifest.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/base-image-platform.yaml")).toEqual([
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/install/perl-critical-cve-remediation.test.ts",
      "test/agents/openclaw/runtime/pi-candidate-runtime-artifacts.test.ts",
    ]);
    expect(triggeredBy("scripts/checks/validate-managed-base-index.sh")).toEqual([
      "test/inference/managed/validate-managed-base-index.test.ts",
    ]);
    expect(triggeredBy("scripts/checks/retry-docker-imagetools-inspect.sh")).toEqual([
      "test/platform/images/retry-docker-imagetools-inspect.test.ts",
      "test/inference/managed/validate-managed-base-index.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
      "test/agents/deepagents/dcode-base-image-workflow.test.ts",
    ]);
    expect(triggeredBy("scripts/checks/pull-public-exact-digest.sh")).toEqual([
      "test/e2e-runtime/pull-public-exact-digest.test.ts",
      "test/inference/managed/managed-image-publication-workflow.test.ts",
    ]);
    expect(triggeredBy("scripts/e2e/sanitize-trace-timing.py")).toEqual([
      "test/e2e/support/e2e-scorecard.test.ts",
      "test/e2e/support/sanitize-trace-timing.test.ts",
    ]);
    expect(triggeredBy("test/e2e/manifests/openclaw-nvidia.yaml")).toEqual([
      "test/e2e/support/e2e-manifests.test.ts",
    ]);
    expect(triggeredBy("test/e2e/manifests/openclaw-nvidia.yml")).toEqual([]);
    expect(triggeredBy(".github/workflows/e2e.yaml")).toEqual(E2E_WORKFLOW_CONTRACTS);
    expect(triggeredBy(".github/workflows/e2e-standard-profile.yaml")).toEqual([
      "test/e2e/support/standard-profile-workflow-boundary.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/portable-profile-e2e.yaml")).toEqual([
      "test/e2e/support/portable-profile-rootless-runtime-workflow.test.ts",
      "test/e2e/support/portable-profile-systemctl-shim.test.ts",
    ]);
    expect(triggeredBy("test/e2e/live/portable-profile-rootless-linux.test.ts")).toEqual([
      "test/e2e/support/portable-profile-rootless-runtime-workflow.test.ts",
    ]);
    expect(triggeredBy("test/e2e/fixtures/portable-profile-systemctl-shim.sh")).toEqual([
      "test/e2e/support/portable-profile-systemctl-shim.test.ts",
    ]);

    expect(triggeredBy(authPath)).toEqual([
      "test/e2e/support/dockerhub-auth-workflow-boundary.test.ts",
    ]);

    expect(triggeredBy(".github/workflows/sandbox-images-and-e2e.yaml")).toEqual([
      "test/e2e/support/sandbox-images-workflow-boundary.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/pr-self-hosted.yaml")).toEqual([
      "test/e2e/support/sandbox-images-workflow-boundary.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/code-scanning.yaml")).toEqual([
      "test/repository/code-scanning-workflow.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/post-merge-docs.yaml")).toEqual([
      "test/generation/post-merge-docs.test.ts",
    ]);
    expect(triggeredBy("tools/post-merge-docs/review-policy.yaml")).toEqual([
      "test/generation/post-merge-docs.test.ts",
    ]);
    expect(triggeredBy("tools/post-merge-docs/artifact.mts")).toEqual([
      "test/generation/post-merge-docs.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/pr-review-advisor.yaml")).toEqual([
      "test/automation/pull-requests/pr-review-advisor-workflow-boundary.test.ts",
    ]);
    expect(triggeredBy("tools/pr-review-advisor/openshell-policy.yaml")).toEqual([
      "test/automation/pull-requests/pr-review-advisor-workflow-boundary.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/hosted-runner-recovery.yaml")).toEqual([
      "test/automation/pull-requests/hosted-runner-recovery-workflow.test.ts",
    ]);
    expect(triggeredBy(".github/workflows/platform-vitest-main.yaml")).toEqual([
      "test/automation/pull-requests/hosted-runner-recovery-workflow.test.ts",
      "test/automation/e2e/platform-vitest-main-workflow.test.ts",
      "test/automation/e2e/wsl-ci-helper.test.ts",
    ]);
    expect(triggeredBy("tools/wsl/ci-helper.ps1")).toEqual([
      "test/automation/e2e/platform-vitest-main-workflow.test.ts",
      "test/automation/e2e/wsl-ci-helper.test.ts",
    ]);
    expect(triggeredBy("ci/platform-vitest-macos-requirements.lock")).toEqual([
      "test/automation/e2e/platform-vitest-main-workflow.test.ts",
    ]);
    expect(triggeredBy(".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md")).toEqual([
      "test/automation/releases/release-post-tag-follow-through.test.ts",
    ]);
    expect(triggeredBy(".agents/skills/nemoclaw-maintainer-evening/SKILL.md")).toEqual([
      "test/automation/releases/release-post-tag-follow-through.test.ts",
    ]);
    expect(triggeredBy(".agents/skills/nemoclaw-maintainer-release-notes/SKILL.md")).toEqual([
      "test/automation/releases/release-post-tag-follow-through.test.ts",
    ]);
    expect(
      triggeredBy(".agents/skills/nemoclaw-maintainer-policies/references/release-train.md"),
    ).toEqual(["test/automation/releases/release-post-tag-follow-through.test.ts"]);
  });

  it.each(Array.from(vitestWatchTriggerPatterns, (value) => [value]))(
    "returns only concrete test files that exist [case %#] (#6692)",
    (trigger) => {
      const triggeredTests = new Set(OPAQUE_INPUTS.flatMap(triggeredBy));

      expect(triggeredTests.size).toBeGreaterThan(0);
      for (const testFile of triggeredTests) {
        expect(testFile).toMatch(/\.test\.ts$/);
        expect(testFile).not.toMatch(/[?*{}[\]]/);
        expect(fs.existsSync(testFile), testFile).toBe(true);
      }

      expect(trigger.pattern.global).toBe(false);
      expect(trigger.pattern.sticky).toBe(false);
    },
  );

  it("leaves unrelated YAML, shell, Python, and workflow files alone (#6692)", () => {
    expect(triggeredBy("notes/example.yaml")).toEqual([]);
    expect(triggeredBy("scripts/unrelated.py")).toEqual([]);
    expect(triggeredBy("test/e2e/lib/unrelated.sh")).toEqual([]);
    expect(triggeredBy("agents/hermes/hermes-wrapper.py")).toEqual([]);
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
