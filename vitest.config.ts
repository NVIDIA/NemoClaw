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
          include: [
            "test/install-preflight.test.ts",
            "test/install-openshell-version-check.test.ts",
          ],
          // Slow tests that spawn real bash install.sh processes.
          // Run in CI or explicitly: npx vitest run --project installer-integration
          // Excluded from pre-commit/pre-push to avoid flaky timeouts.
          enabled: process.env.CI === "true" || process.env.CI === "1" ||
            process.env.NEMOCLAW_RUN_INSTALLER_TESTS === "1",
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
          include: ["test/e2e/brev-e2e.test.ts"],
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
