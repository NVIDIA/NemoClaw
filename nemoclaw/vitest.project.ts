// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const canonicalBannerBoundary = path.resolve(import.meta.dirname, "src/shared/banner-boundary.cts");
const canonicalCredentialFilterBoundary = path.resolve(
  import.meta.dirname,
  "src/shared/credential-filter-boundary.cts",
);
const canonicalOpenShellExternalTargetBoundary = path.resolve(
  import.meta.dirname,
  "src/shared/openshell-external-target-boundary.cts",
);
const canonicalOpenShellPolicyBoundary = path.resolve(
  import.meta.dirname,
  "src/shared/openshell-policy-boundary.cts",
);
const canonicalPrivateNetworksBoundary = path.resolve(
  import.meta.dirname,
  "src/shared/private-networks-boundary.cts",
);
const canonicalSandboxName = path.resolve(import.meta.dirname, "src/shared/sandbox-name.cts");
const canonicalSnapshotSanitizerBoundary = path.resolve(
  import.meta.dirname,
  "src/shared/snapshot-sanitizer-boundary.cts",
);

type PluginVitestProjectOptions = {
  root: string;
  oxc: { include: RegExp };
  test: {
    name: "plugin";
    alias: Array<{ find: RegExp; replacement: string }>;
    env: Record<string, string>;
    environment: "node";
    expect: { requireAssertions: true };
    clearMocks: true;
    restoreMocks: true;
    unstubEnvs: true;
    unstubGlobals: true;
    setupFiles: string[];
    include: string[];
  };
};

const pluginVitestProjectOptions = {
  root: repositoryRoot,
  oxc: {
    include: /\.(?:[cm]?ts|[jt]sx)$/,
  },
  test: {
    name: "plugin",
    // Map the generated shared .cjs specifiers back to their .cts source so
    // plugin tests exercise the single source of truth rather than a
    // possibly-stale build artifact.
    alias: [
      {
        find: /^.*banner-boundary\.cjs$/,
        replacement: canonicalBannerBoundary,
      },
      {
        find: /^.*credential-filter-boundary\.cjs$/,
        replacement: canonicalCredentialFilterBoundary,
      },
      {
        find: /^.*openshell-external-target-boundary\.cjs$/,
        replacement: canonicalOpenShellExternalTargetBoundary,
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
    ],
    env: {
      NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
    },
    environment: "node",
    // Plugin tests use Vitest expect throughout. Keep assertion presence scoped
    // here so root projects that intentionally use Node assert remain valid.
    expect: { requireAssertions: true },
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: ["test/helpers/normalize-fixture-umask.ts"],
    include: ["nemoclaw/src/**/*.test.ts"],
  },
} satisfies PluginVitestProjectOptions;

export default pluginVitestProjectOptions;
