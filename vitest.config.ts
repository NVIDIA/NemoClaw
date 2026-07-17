// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { availableParallelism } from "node:os";
import path from "node:path";

import { defineConfig, defineProject } from "vitest/config";

import pluginVitestProjectOptions from "./nemoclaw/vitest.project";
import {
  shouldRunBranchValidationE2E,
  shouldRunLiveE2E,
} from "./test/e2e/fixtures/live-project-gate.ts";
import { CliCoverageSequencer } from "./test/helpers/cli-coverage-sequencer";
import { resolveIntegrationProjectScheduling } from "./test/helpers/integration-project-scheduling";
import { sourceLoaderNodeOptions } from "./test/helpers/source-loader-options";
import { testTimeout } from "./test/helpers/timeouts";
import { resolveVitestCoverageThresholds } from "./test/helpers/vitest-coverage-thresholds";
import { resolveVitestFeedback } from "./test/helpers/vitest-feedback";
import { vitestStateIsolation } from "./test/helpers/vitest-state-isolation";
import { vitestWatchTriggerPatterns } from "./test/helpers/vitest-watch-triggers";

const { isCi, silent } = resolveVitestFeedback();
const LIVE_E2E_PROJECT_TIMEOUT_MS = 30 * 60 * 1000;
const runLiveE2E = shouldRunLiveE2E();
const runBranchValidationE2E = shouldRunBranchValidationE2E();
const canonicalOpenShellPolicyBoundary = path.resolve(
  "nemoclaw/src/shared/openshell-policy-boundary.cts",
);
const canonicalOpenShellPolicyAlias = [
  {
    find: /^.*openshell-policy-boundary\.cjs$/,
    replacement: canonicalOpenShellPolicyBoundary,
  },
];
const typedSourceTransform = {
  oxc: {
    include: /\.(?:[cm]?ts|[jt]sx)$/,
  },
};
const sourceNodeOptions = sourceLoaderNodeOptions(process.env.NODE_OPTIONS);
const controlledNonLiveEnv = {
  NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
};
// Pin the file-creation umask of every non-live test worker to exactly 0o022 —
// the conventional CI baseline — so Hermes/OpenClaw guard fixtures are created
// with deterministic modes regardless of the developer's ambient umask (e.g. a
// permissive 0002 on Ubuntu 24.04 would otherwise make them group-writable and
// the guard would reject them). The live/credential-bearing E2E projects are
// intentionally excluded below and keep their own stricter umask handling. See
// test/helpers/normalize-fixture-umask.ts (#6448).
const fixtureUmaskSetup = "test/helpers/normalize-fixture-umask.ts";
const pluginVitestProject = defineProject(pluginVitestProjectOptions);
const integrationProjectScheduling = resolveIntegrationProjectScheduling({
  isCi,
  npmLifecycleEvent: process.env.npm_lifecycle_event,
  argv: process.argv.slice(2),
  availableParallelism: availableParallelism(),
});

export default defineConfig({
  test: {
    globalSetup: "test/helpers/vitest-temp-root.ts",
    tags: [
      {
        name: "e2e/credential-free",
        description: "Runs without external credentials in the shared E2E job",
      },
    ],
    // Let Vitest select its environment-aware local reporter and add GitHub
    // annotations in Actions. CI suppresses passed-test logs while replaying
    // the console output attached to failures.
    silent,
    hideSkippedTests: isCi,
    watchTriggerPatterns: vitestWatchTriggerPatterns,
    sequence: { sequencer: CliCoverageSequencer },
    projects: [
      {
        ...typedSourceTransform,
        test: {
          ...vitestStateIsolation,
          name: "cli",
          alias: canonicalOpenShellPolicyAlias,
          env: controlledNonLiveEnv,
          testTimeout: testTimeout(),
          setupFiles: [fixtureUmaskSetup, "test/helpers/onboard-script-mocks.cjs"],
          include: ["src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/.claude/**"],
        },
      },
      {
        ...typedSourceTransform,
        test: {
          ...vitestStateIsolation,
          name: "integration",
          alias: canonicalOpenShellPolicyAlias,
          // Source-backed process fixtures can exceed the unit-test budget
          // when several coverage shards transpile and spawn them concurrently.
          testTimeout: testTimeout(15_000),
          setupFiles: [fixtureUmaskSetup, "test/helpers/onboard-script-mocks.cjs"],
          // Integration fixtures often spawn short Node programs. Coverage
          // stays serial because concurrent source-loader forks exhaust the
          // 7 GiB CI runner. The canonical local full suite instead runs this
          // project as a bounded four-worker phase after the other projects.
          ...integrationProjectScheduling,
          env: {
            ...controlledNonLiveEnv,
            NODE_OPTIONS: sourceNodeOptions,
            // Integration fixtures exercise onboarding against controlled fake
            // Docker state. Keep a base-image Dockerfile change in the PR from
            // redirecting those fixtures into the real local-build guard.
            NEMOCLAW_SANDBOX_BASE_IMAGE_REF: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
          },
          include: ["test/**/*.test.{js,ts}"],
          exclude: [
            "**/node_modules/**",
            "**/.claude/**",
            "test/e2e/**",
            "test/e2e/live/**",
            "test/e2e/support/**",
            "test/package-contract/**",
            "test/install-express-prompt.test.ts",
            "test/install-build-dependency-preflight.test.ts",
            "test/install-clone-ref.test.ts",
            "test/install-preflight.test.ts",
            "test/install-preflight-docker-bootstrap.test.ts",
            "test/install-station-host-preparation.test.ts",
            "test/install-openshell-version-check.test.ts",
          ],
        },
      },
      {
        ...typedSourceTransform,
        test: {
          ...vitestStateIsolation,
          name: "installer-integration",
          alias: canonicalOpenShellPolicyAlias,
          env: controlledNonLiveEnv,
          setupFiles: [fixtureUmaskSetup],
          include: [
            "test/install-express-prompt.test.ts",
            "test/install-build-dependency-preflight.test.ts",
            "test/install-clone-ref.test.ts",
            "test/install-preflight.test.ts",
            "test/install-preflight-docker-bootstrap.test.ts",
            "test/install-station-host-preparation.test.ts",
            "test/install-openshell-version-check.test.ts",
          ],
          // Slow tests that spawn real bash install.sh processes. Explicit
          // project selection keeps them out of the fast source-test command.
        },
      },
      {
        ...typedSourceTransform,
        test: {
          ...vitestStateIsolation,
          name: "package-contract",
          alias: canonicalOpenShellPolicyAlias,
          env: controlledNonLiveEnv,
          setupFiles: [fixtureUmaskSetup],
          include: ["test/package-contract/**/*.test.ts"],
        },
      },
      pluginVitestProject,
      {
        ...typedSourceTransform,
        test: {
          ...vitestStateIsolation,
          // Fast tests for the E2E fixture/support layer. Vitest remains the
          // only harness; this project does not define a separate runner.
          name: "e2e-support",
          alias: canonicalOpenShellPolicyAlias,
          env: controlledNonLiveEnv,
          testTimeout: testTimeout(),
          setupFiles: [fixtureUmaskSetup, "test/helpers/onboard-script-mocks.cjs"],
          include: ["test/e2e/support/**/*.test.ts"],
        },
      },
      {
        ...typedSourceTransform,
        test: {
          name: "e2e-live",
          alias: canonicalOpenShellPolicyAlias,
          // Register the typed-source require hook in the worker so live suites
          // can import source modules that resolve siblings via a runtime
          // `require("../module")` (e.g. inference/ollama-runtime-context.ts).
          // Use setupFiles rather than NODE_OPTIONS so the hook stays in-process
          // and never leaks `--require` into the real CLI subprocesses under
          // test. Mirrors the `cli` project.
          //
          // Intentionally excludes the fixture-umask setup: live E2E has no
          // guard-fixture suites and handles real credentials, so it must keep
          // the caller's umask (and sets its own strict `umask 077` inline).
          setupFiles: ["test/helpers/onboard-script-mocks.cjs"],
          testTimeout: testTimeout(LIVE_E2E_PROJECT_TIMEOUT_MS),
          // Live targets mutate host, Docker, gateway, and sandbox state. A
          // whole-test retry reuses that state and can hide the first failure
          // behind stale locks or exhausted storage. Transient operations must
          // retry inside the target after proving their cleanup boundary.
          fileParallelism: false,
          retry: 0,
          include: runLiveE2E ? ["test/e2e/live/**/*.test.ts"] : [],
          // Live E2E tests are opt-in because they install, onboard, and
          // mutate real NemoClaw/OpenShell state. Run explicitly with:
          //   NEMOCLAW_RUN_LIVE_E2E=1 npx vitest run --project e2e-live
        },
      },
      {
        ...typedSourceTransform,
        test: {
          name: "e2e-branch-validation",
          alias: canonicalOpenShellPolicyAlias,
          // A branch-validation retry must provision a fresh remote instance.
          // Retrying a stateful target inside one VM can overlap a timed-out
          // installer that still legitimately owns the onboarding lock.
          retry: 0,
          include: runBranchValidationE2E ? ["test/e2e/brev-e2e.test.ts"] : [],
          // Branch validation E2E: rsyncs the branch over a Brev instance
          // provisioned from the published NemoClaw launchable image and
          // runs the selected test suites. Only run when explicitly enabled:
          //   NEMOCLAW_RUN_BRANCH_VALIDATION_E2E=1 npx vitest run --project e2e-branch-validation
          //
          // The reusable workflow passes `--silent=false --reporter=default`:
          // diagnostic output from createBrevInstance / waitForSsh /
          // waitForLaunchableReady is essential for debugging provisioning
          // timing, and the suite has no routine test chatter to suppress.
          // Gate on a workflow-owned sentinel or Brev auth env. Historically
          // this used BREV_API_TOKEN (short-lived refresh token); newer
          // workflows authenticate with BREV_API_KEY + BREV_ORG_ID before
          // invoking Vitest.
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "bin/**/*.js", "nemoclaw/src/**/*.ts", "nemoclaw/src/**/*.cts"],
      exclude: ["**/*.test.ts", "dist/**"],
      reporter: ["text-summary", "json-summary"],
      thresholds: resolveVitestCoverageThresholds(process.argv.slice(2)),
    },
  },
});
