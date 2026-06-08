// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

import {
  shouldRunBranchValidationE2E,
  shouldRunInstallerIntegration,
  shouldRunLiveE2EScenarios,
} from "./test/e2e-scenario/framework/live-project-gate.ts";
import { testTimeout } from "./test/helpers/timeouts";

const isGithubActions = process.env.GITHUB_ACTIONS === "true";
const isCi = isGithubActions || process.env.CI === "true" || process.env.CI === "1";
const LIVE_E2E_PROJECT_TIMEOUT_MS = 30 * 60 * 1000;
const runInstallerIntegration = shouldRunInstallerIntegration();
const runLiveE2EScenarios = shouldRunLiveE2EScenarios();
const runBranchValidationE2E = shouldRunBranchValidationE2E();

export default defineConfig({
  test: {
    env: {
      NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
    },
    // CI logs are easiest to scan when test chatter stays quiet and failures
    // surface as GitHub annotations at the relevant file and line.
    reporters: isGithubActions ? ["github-actions"] : ["default"],
    silent: isCi,
    hideSkippedTests: isCi,
    projects: [
      {
        test: {
          name: "cli",
          testTimeout: testTimeout(),
          include: ["test/**/*.test.{js,ts}", "src/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/.claude/**",
            "test/e2e/**",
            "test/install-preflight.test.ts",
            "test/install-openshell-version-check.test.ts",
          ],
        },
      },
      {
        test: {
          name: "installer-integration",
          include: runInstallerIntegration
            ? [
                "test/install-preflight.test.ts",
                "test/install-openshell-version-check.test.ts",
              ]
            : [],
          // Slow tests that spawn real bash install.sh processes.
          // Run in CI or explicitly with:
          //   NEMOCLAW_RUN_INSTALLER_TESTS=1 npx vitest run --project installer-integration
          // Excluded from pre-commit/pre-push to avoid flaky timeouts.
        },
      },
      {
        test: {
          name: "plugin",
          include: ["nemoclaw/src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "e2e-scenario-framework",
          testTimeout: testTimeout(),
          include: ["test/e2e-scenario/framework-tests/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "e2e-scenarios-live",
          testTimeout: testTimeout(LIVE_E2E_PROJECT_TIMEOUT_MS),
          include: runLiveE2EScenarios ? ["test/e2e-scenario/live/**/*.test.ts"] : [],
          // Live scenario tests are opt-in because they install, onboard, and
          // mutate real NemoClaw/OpenShell state. Run explicitly with:
          //   NEMOCLAW_RUN_E2E_SCENARIOS=1 npx vitest run --project e2e-scenarios-live
        },
      },
      {
        test: {
          name: "e2e-branch-validation",
          include: runBranchValidationE2E ? ["test/e2e/brev-e2e.test.ts"] : [],
          // Branch validation E2E: rsyncs the branch over a Brev instance
          // provisioned from the published NemoClaw launchable image and
          // runs the selected test suites. Only run when explicitly enabled:
          //   NEMOCLAW_RUN_BRANCH_VALIDATION_E2E=1 npx vitest run --project e2e-branch-validation
          //
          // Override the project-root `silent: isCi` setting — diagnostic
          // output from createBrevInstance / waitForSsh / waitForLaunchableReady
          // is essential for debugging Brev provisioning timing and the
          // overall suite runs in a single `describe` block, so there's no
          // test chatter to suppress anyway.
          // Gate on a workflow-owned sentinel or Brev auth env. Historically
          // this used BREV_API_TOKEN (short-lived refresh token); newer
          // workflows authenticate with BREV_API_KEY + BREV_ORG_ID before
          // invoking Vitest.
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "bin/**/*.js", "nemoclaw/src/**/*.ts"],
      exclude: ["**/*.test.ts", "dist/**"],
      reporter: ["text-summary", "json-summary"],
    },
  },
});
