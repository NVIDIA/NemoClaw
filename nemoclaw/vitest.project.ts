// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const canonicalOpenShellPolicyBoundary = path.resolve(
  import.meta.dirname,
  "src/shared/openshell-policy-boundary.cts",
);

type PluginVitestProjectOptions = {
  root: string;
  oxc: { include: RegExp };
  test: {
    name: "plugin";
    alias: Array<{ find: RegExp; replacement: string }>;
    env: Record<string, string>;
    environment: "node";
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
    alias: [
      {
        find: /^.*openshell-policy-boundary\.cjs$/,
        replacement: canonicalOpenShellPolicyBoundary,
      },
    ],
    env: {
      NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
    },
    environment: "node",
    setupFiles: ["test/helpers/normalize-fixture-umask.ts"],
    include: ["nemoclaw/src/**/*.test.ts"],
  },
} satisfies PluginVitestProjectOptions;

export default pluginVitestProjectOptions;
