// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const canonicalOpenShellPolicyBoundary = path.resolve(
  import.meta.dirname,
  "src/shared/openshell-policy-boundary.cts",
);
const canonicalSandboxName = path.resolve(import.meta.dirname, "src/shared/sandbox-name.cts");

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
        find: /^.*openshell-policy-boundary\.cjs$/,
        replacement: canonicalOpenShellPolicyBoundary,
      },
      {
        find: /^.*sandbox-name\.cjs$/,
        replacement: canonicalSandboxName,
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
