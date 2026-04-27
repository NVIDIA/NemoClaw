// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

const runInstallerIntegration =
  process.env.CI === "true" ||
  process.env.CI === "1" ||
  process.env.NEMOCLAW_RUN_INSTALLER_TESTS === "1";
const runBrevE2e =
  !!process.env.BREV_API_TOKEN &&
  (process.env.CI === "true" ||
    process.env.CI === "1" ||
    process.env.NEMOCLAW_RUN_BREV_E2E === "1");

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
      // Installer integration tests spawn real install scripts and may clone from GitHub.
      // Keep them out of the default local suite unless CI or an explicit env opt-in asks for them.
      ...(runInstallerIntegration
        ? [
            {
              test: {
                name: "installer-integration",
                include: [
                  "test/install-preflight.test.ts",
                  "test/install-openshell-version-check.test.ts",
                ],
              },
            },
          ]
        : []),
      {
        test: {
          name: "plugin",
          include: ["nemoclaw/src/**/*.test.ts"],
        },
      },
      // Brev E2E provisions cloud instances, so it also requires an explicit opt-in.
      ...(runBrevE2e
        ? [
            {
              test: {
                name: "e2e-brev",
                include: ["test/e2e/brev-e2e.test.ts"],
              },
            },
          ]
        : []),
    ],
    coverage: {
      provider: "v8",
      include: ["nemoclaw/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
