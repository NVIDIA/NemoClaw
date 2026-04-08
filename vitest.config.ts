// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "cli",
          include: ["test/**/*.test.{js,ts}", "src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/.claude/**", "test/e2e/**"],
          // Match the bumped `runWithEnv` execSync timeout in test/cli.test.js.
          // Vitest's default `testTimeout` is 5000ms, which would abort tests
          // long before the 30s execSync ceiling — making the bumped child
          // timeout useless on slow CI hosts.
          testTimeout: 30_000,
          hookTimeout: 30_000,
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
          name: "e2e-brev",
          include: ["test/e2e/brev-e2e.test.js"],
          // Only run when explicitly targeted: npx vitest run --project e2e-brev
          enabled: !!process.env.BREV_API_TOKEN,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["nemoclaw/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
