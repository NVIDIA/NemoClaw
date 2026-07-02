// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { defineConfig } from "vitest/config";

import {
  shouldRunBranchValidationE2E,
  shouldRunLiveE2E,
} from "./test/e2e/fixtures/live-project-gate.ts";
import { resolveE2ERetryCount } from "./test/helpers/e2e-retries";
import { testTimeout } from "./test/helpers/timeouts";

const isGithubActions = process.env.GITHUB_ACTIONS === "true";
const isCi = isGithubActions || process.env.CI === "true" || process.env.CI === "1";
const LIVE_E2E_PROJECT_TIMEOUT_MS = 30 * 60 * 1000;
const runLiveE2E = shouldRunLiveE2E();
const runBranchValidationE2E = shouldRunBranchValidationE2E();
const e2eRetryCount = resolveE2ERetryCount();
const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
const sourceNodeOptions = [process.env.NODE_OPTIONS, `--require=${sourceRequireHook}`]
  .filter(Boolean)
  .join(" ");

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
          setupFiles: ["test/helpers/onboard-script-mocks.cjs"],
          include: ["src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/.claude/**"],
        },
      },
      {
        test: {
          name: "integration",
          // Source-backed process fixtures can exceed the unit-test budget
          // when several coverage shards transpile and spawn them concurrently.
          testTimeout: testTimeout(15_000),
          setupFiles: ["test/helpers/onboard-script-mocks.cjs"],
          // Integration fixtures often spawn short Node programs. Keep those
          // programs on the same source graph as their parent test process.
          // The integration suite shells out heavily, and stacking multiple
          // forks of the require-hook transpile cache on the 7 GiB ubuntu
          // runner reliably exhausts physical RAM when coverage is on.
          // Disable file parallelism for the integration project so the test
          // files run serially against a single worker (vitest 4 dropped
          // poolOptions.forks.singleFork; fileParallelism: false is the
          // documented replacement).
          fileParallelism: false,
          env: { NODE_OPTIONS: sourceNodeOptions },
          include: ["test/**/*.test.{js,ts}"],
          exclude: [
            "**/node_modules/**",
            "**/.claude/**",
            "test/e2e/**",
            "test/e2e/live/**",
            "test/e2e/support/**",
            "test/package-contract/**",
            "test/install-express-prompt.test.ts",
            "test/install-preflight.test.ts",
            "test/install-preflight-docker-bootstrap.test.ts",
            "test/install-openshell-version-check.test.ts",
          ],
        },
      },
      {
        test: {
          name: "installer-integration",
          include: [
            "test/install-express-prompt.test.ts",
            "test/install-preflight.test.ts",
            "test/install-preflight-docker-bootstrap.test.ts",
            "test/install-openshell-version-check.test.ts",
          ],
          // Slow tests that spawn real bash install.sh processes. Explicit
          // project selection keeps them out of the fast source-test command.
        },
      },
      {
        test: {
          name: "package-contract",
          include: ["test/package-contract/**/*.test.ts"],
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
          // Fast tests for the E2E fixture/support layer. Vitest remains the
          // only harness; this project does not define a separate runner.
          name: "e2e-support",
          testTimeout: testTimeout(),
          include: ["test/e2e/support/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "e2e-live",
          testTimeout: testTimeout(LIVE_E2E_PROJECT_TIMEOUT_MS),
          // Vitest counts retries after the initial failure. In CI the default
          // value of 2 gives live E2Es up to three total attempts while keeping
          // local opt-in runs single-shot unless NEMOCLAW_E2E_RETRIES is set.
          retry: e2eRetryCount,
          include: runLiveE2E ? ["test/e2e/live/**/*.test.ts"] : [],
          // Live E2E tests are opt-in because they install, onboard, and
          // mutate real NemoClaw/OpenShell state. Run explicitly with:
          //   NEMOCLAW_RUN_LIVE_E2E=1 npx vitest run --project e2e-live
        },
      },
      {
        test: {
          name: "e2e-branch-validation",
          retry: e2eRetryCount,
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
