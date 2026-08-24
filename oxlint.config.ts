// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "oxlint";

import { oxcIgnorePatterns } from "./oxc.ignore-patterns.ts";

const strictComplexityFiles = [
  "src/lib/actions/sandbox/status.ts",
  "src/lib/actions/sandbox/status-text.ts",
  "src/lib/actions/sandbox/doctor.ts",
  "src/lib/actions/sandbox/doctor-messaging.ts",
  "src/lib/actions/sandbox/doctor-report.ts",
  "src/lib/actions/sandbox/doctor-system-checks.ts",
  "src/lib/onboard/machine/handlers/sandbox.ts",
  "src/lib/onboard/machine/handlers/sandbox-messaging.ts",
  "src/lib/onboard/machine/handlers/sandbox-resume.ts",
  "src/commands/onboard.ts",
  "src/commands/setup.ts",
  "src/commands/setup-spark.ts",
  "src/lib/actions/onboard.ts",
  "src/lib/onboard/command.ts",
  "src/lib/onboard/command-support.ts",
];

export default defineConfig({
  categories: {
    correctness: "off",
    nursery: "off",
    pedantic: "off",
    perf: "off",
    restriction: "off",
    style: "off",
    suspicious: "off",
  },
  env: {
    browser: true,
    node: true,
  },
  ignorePatterns: oxcIgnorePatterns,
  jsPlugins: [
    {
      name: "sonarjs",
      specifier: "eslint-plugin-sonarjs",
    },
  ],
  plugins: ["import", "typescript"],
  rules: {
    "sonarjs/cognitive-complexity": ["error", 149],
    "no-undef": "error",
  },
  overrides: [
    {
      files: [".dsh/tools/*/index.ts"],
      globals: {
        tools: "readonly",
      },
    },
    {
      files: [
        "bin/**/*.js",
        "commitlint.config.js",
        "scripts/**/*.js",
        "scripts/**/*.mjs",
        "test/**/*.js",
        "test/credentials-shim.test.ts",
        "test/runner-basic.test.ts",
      ],
      rules: {
        "no-unused-vars": "error",
      },
    },
    {
      files: strictComplexityFiles,
      rules: {
        "sonarjs/cognitive-complexity": ["error", 10],
      },
    },
    // Pin the migration-baseline SonarJS scores for existing hotspots so later changes cannot increase them.

    {
      files: ["src/lib/onboard/machine/handlers/provider-inference.ts"],
      rules: {
        "sonarjs/cognitive-complexity": ["error", 171],
      },
    },
    {
      files: ["src/lib/actions/uninstall/run-plan.ts"],
      rules: {
        "sonarjs/cognitive-complexity": ["error", 202],
      },
    },
    {
      files: ["src/lib/actions/sandbox/process-recovery.ts"],
      rules: {
        "sonarjs/cognitive-complexity": ["error", 297],
      },
    },
    {
      files: ["src/lib/onboard.ts"],
      rules: {
        "sonarjs/cognitive-complexity": ["error", 159],
      },
    },
    {
      files: ["src/lib/onboard/setup-nim-flow.ts"],
      rules: {
        "sonarjs/cognitive-complexity": ["error", 161],
      },
    },
    {
      files: ["src/lib/actions/sandbox/status.ts"],
      rules: {
        "sonarjs/cognitive-complexity": ["error", 11],
      },
    },
    // Oxlint parses this import-only E2E shim as a script and reports await as a global.

    {
      files: ["test/e2e/live/bootstrap-install-smoke.test.ts"],
      rules: {
        "no-undef": "off",
      },
    },
    {
      files: ["nemoclaw/src/**/*.ts"],
      rules: {
        "import/no-commonjs": "error",
        "no-unused-vars": "error",
        "typescript/consistent-type-exports": "error",
        "typescript/consistent-type-imports": [
          "error",
          {
            disallowTypeAnnotations: false,
            fixStyle: "separate-type-imports",
            prefer: "type-imports",
          },
        ],
        "typescript/no-explicit-any": "error",
        "typescript/prefer-nullish-coalescing": "error",
        "typescript/prefer-optional-chain": "error",
        "typescript/switch-exhaustiveness-check": "error",
      },
    },
  ],
});
