// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { availableParallelism } from "node:os";
import path from "node:path";

import { defineConfig, defineProject } from "vitest/config";

import pluginVitestProjectOptions from "./nemoclaw/vitest.project";
import { shouldRunLiveE2E } from "./test/e2e/fixtures/live-project-gate.ts";
import { CliCoverageSequencer } from "./test/helpers/cli-coverage-sequencer";
import {
  resolveCliCoverageShardScheduling,
  resolveIntegrationProjectScheduling,
} from "./test/helpers/integration-project-scheduling";
import { sourceLoaderNodeOptions } from "./test/helpers/source-loader-options";
import { testTimeout } from "./test/helpers/timeouts";
import { resolveVitestCoverageThresholds } from "./test/helpers/vitest-coverage-thresholds";
import { resolveVitestFeedback } from "./test/helpers/vitest-feedback";
import { vitestStateIsolation } from "./test/helpers/vitest-state-isolation";
import { vitestWatchTriggerPatterns } from "./test/helpers/vitest-watch-triggers";

const { isCi, silent } = resolveVitestFeedback();
const LIVE_E2E_PROJECT_TIMEOUT_MS = 30 * 60 * 1000;
const runLiveE2E = shouldRunLiveE2E();
const canonicalBannerBoundary = path.resolve("nemoclaw/src/shared/banner-boundary.cts");
const canonicalCredentialFilterBoundary = path.resolve(
  "nemoclaw/src/shared/credential-filter-boundary.cts",
);
const canonicalOpenShellPolicyBoundary = path.resolve(
  "nemoclaw/src/shared/openshell-policy-boundary.cts",
);
const canonicalPrivateNetworksBoundary = path.resolve(
  "nemoclaw/src/shared/private-networks-boundary.cts",
);
const canonicalSandboxName = path.resolve("nemoclaw/src/shared/sandbox-name.cts");
const canonicalSnapshotSanitizerBoundary = path.resolve(
  "nemoclaw/src/shared/snapshot-sanitizer-boundary.cts",
);
// Map the generated shared .cjs specifiers back to their .cts source so
// source-mode test projects exercise the single source of truth rather than a
// possibly-stale build artifact.
const canonicalSourceAliases = [
  {
    find: /^.*banner-boundary\.cjs$/,
    replacement: canonicalBannerBoundary,
  },
  {
    find: /^.*credential-filter-boundary\.cjs$/,
    replacement: canonicalCredentialFilterBoundary,
  },
  {
    find: /^.*openshell-policy-boundary\.cjs$/,
    replacement: canonicalOpenShellPolicyBoundary,
  },
  {
    find: /^.*private-networks-boundary\.cjs$/,
    replacement: canonicalPrivateNetworksBoundary,
  },
  {
    find: /^.*sandbox-name\.cjs$/,
    replacement: canonicalSandboxName,
  },
  {
    find: /^.*snapshot-sanitizer-boundary\.cjs$/,
    replacement: canonicalSnapshotSanitizerBoundary,
  },
];
const e2ePhaseCollectionAlias =
  process.env.NEMOCLAW_E2E_PHASE_COLLECTION === "1"
    ? [
        {
          find: "../../../dist/lib/onboard/docker-driver-gateway-launch",
          replacement: path.resolve("src/lib/onboard/docker-driver-gateway-launch.ts"),
        },
        {
          find: "../../../dist/lib/onboard/docker-driver-gateway-local-tls",
          replacement: path.resolve("src/lib/onboard/docker-driver-gateway-local-tls.ts"),
        },
      ]
    : [];
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
const isolatedTestStateSetup = "test/helpers/isolate-test-state.ts";
const pluginVitestProject = defineProject(pluginVitestProjectOptions);
// Pull-request jobs execute the base branch's trusted composite action, so an
// action change in a PR cannot constrain that PR's own Vitest workers. Apply a
// bounded cap from the validated shard environment instead; this is shared by the
// trusted PR action and the main-branch action.
const cliCoverageShardScheduling = resolveCliCoverageShardScheduling({
  isCi,
  cliShard: process.env.CLI_SHARD,
  cliShardCount: process.env.CLI_SHARD_COUNT,
});
const integrationProjectScheduling = resolveIntegrationProjectScheduling({
  isCi,
  npmLifecycleEvent: process.env.npm_lifecycle_event,
  argv: process.argv.slice(2),
  availableParallelism: availableParallelism(),
});

export default defineConfig({
  test: {
    ...cliCoverageShardScheduling,
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
          alias: canonicalSourceAliases,
          env: controlledNonLiveEnv,
          testTimeout: testTimeout(),
          setupFiles: [
            fixtureUmaskSetup,
            isolatedTestStateSetup,
            "test/helpers/onboard-script-mocks.cjs",
          ],
          include: ["src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/.claude/**"],
        },
      },
      {
        ...typedSourceTransform,
        test: {
          ...vitestStateIsolation,
          name: "integration",
          alias: canonicalSourceAliases,
          // Source-backed process fixtures can exceed the unit-test budget
          // when several coverage shards transpile and spawn them concurrently.
          testTimeout: testTimeout(15_000),
          setupFiles: [
            fixtureUmaskSetup,
            isolatedTestStateSetup,
            "test/helpers/onboard-script-mocks.cjs",
          ],
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
            NEMOCLAW_SANDBOX_BASE_IMAGE_REF:
              "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          include: ["test/**/*.test.{js,ts}"],
          exclude: [
            "**/node_modules/**",
            "**/.claude/**",
            "test/e2e/**",
            "test/e2e/live/**",
            "test/e2e/support/**",
            "test/package-contract/**",
            "test/installer-integration/**",
          ],
        },
      },
      {
        ...typedSourceTransform,
        test: {
          ...vitestStateIsolation,
          name: "installer-integration",
          alias: canonicalSourceAliases,
          // Installer fixtures spawn nested shell, Node, Python, and SSH
          // processes. Use the same bounded scheduling as the other process
          // fixtures so CI cannot turn a transient spawn failure into a
          // fail-closed single-host result.
          ...integrationProjectScheduling,
          env: controlledNonLiveEnv,
          setupFiles: [fixtureUmaskSetup, isolatedTestStateSetup],
          include: ["test/installer-integration/**/*.test.ts"],
          // Slow tests that spawn real bash install.sh processes. Explicit
          // project selection keeps them out of the fast source-test command.
        },
      },
      {
        ...typedSourceTransform,
        test: {
          ...vitestStateIsolation,
          name: "package-contract",
          alias: canonicalSourceAliases,
          env: controlledNonLiveEnv,
          setupFiles: [fixtureUmaskSetup, isolatedTestStateSetup],
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
          alias: canonicalSourceAliases,
          env: controlledNonLiveEnv,
          testTimeout: testTimeout(),
          setupFiles: [
            fixtureUmaskSetup,
            isolatedTestStateSetup,
            "test/helpers/onboard-script-mocks.cjs",
          ],
          include: ["test/e2e/support/**/*.test.ts"],
        },
      },
      {
        ...typedSourceTransform,
        test: {
          name: "e2e-live",
          alias: [...canonicalSourceAliases, ...e2ePhaseCollectionAlias],
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
