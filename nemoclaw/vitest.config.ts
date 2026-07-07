// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { defineConfig } from "vitest/config";

const canonicalOpenShellPolicyBoundary = path.resolve(
  import.meta.dirname,
  "src/shared/openshell-policy-boundary.cts",
);

export default defineConfig({
  oxc: {
    include: /\.(?:[cm]?ts|[jt]sx)$/,
  },
  test: {
    alias: [
      {
        find: /^.*openshell-policy-boundary\.cjs$/,
        replacement: canonicalOpenShellPolicyBoundary,
      },
    ],
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
