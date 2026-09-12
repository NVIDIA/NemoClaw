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

const configExportFiles = [
  "src/commands/config/**/*.ts",
  "src/lib/actions/config/**/*.ts",
  "src/lib/adapters/config/**/*.ts",
  "src/lib/domain/config/**/*.ts",
  "src/lib/config/**/*.ts",
  "src/lib/core/endpoint-url-safety.ts",
  "src/lib/cli/config-export-*.ts",
  "src/lib/adapters/fs/config-export-*.ts",
  "src/lib/adapters/openshell/{providers,sandboxes,sandbox-config,sdk-read,sdk-read-schema}.ts",
];

// Ratchet existing hotspots to their measured scores without raising the default ceiling.
const legacyComplexityLimits = {
  "src/lib/onboard/machine/handlers/provider-inference.ts": 171,
  "src/lib/actions/uninstall/run-plan.ts": 186,
  "src/lib/actions/sandbox/process-recovery.ts": 166,
  "src/lib/onboard.ts": 119,
  "src/lib/onboard/setup-nim-flow.ts": 150,
  "src/lib/actions/sandbox/status.ts": 11,
};

export default defineConfig({
  categories: {
    correctness: "error",
  },
  env: {
    node: true,
  },
  ignorePatterns: oxcIgnorePatterns,
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: "deny",
  },
  jsPlugins: ["eslint-plugin-sonarjs"],
  plugins: ["import", "typescript"],
  rules: {
    "sonarjs/cognitive-complexity": ["error", 149],
    "no-undef": "error",
    // Sanitizers deliberately match control characters; Vitest fixtures require empty parameters.
    "no-control-regex": "off",
    "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
    // Preserve the current scoped checks until each remaining rule family is migrated.
    "no-unused-vars": "off",
    "no-unused-expressions": "off",
    "no-useless-catch": "off",
    "no-unsafe-optional-chaining": "off",
    "no-unsafe-finally": "off",
    "import/namespace": "off",
  },
  overrides: [
    {
      files: ["docs/_components/**/*.{ts,tsx}", "fern/components/**/*.{ts,tsx}"],
      env: { browser: true },
    },
    {
      files: ["**/*.test.ts"],
      // Mock assertions pass method references without invoking their receivers.
      rules: { "typescript/unbound-method": "off" },
    },
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
        "test/package-contract/credentials-shim.test.ts",
        "test/e2e-runtime/runner-basic.test.ts",
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
    {
      files: configExportFiles,
      excludeFiles: ["**/*.test.ts"],
      rules: {
        "sonarjs/cognitive-complexity": ["error", 10],
        complexity: ["error", 10],
        "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
        "no-nested-ternary": "error",
      },
    },
    {
      files: ["src/lib/extra-agents-validation.ts"],
      rules: {
        "no-unused-vars": "error",
        "typescript/no-explicit-any": "error",
        "typescript/consistent-type-exports": "error",
        "typescript/consistent-type-imports": ["error", { disallowTypeAnnotations: false }],
      },
    },
    {
      files: ["src/lib/adapters/**/*.{cts,mts,ts,tsx}", "nemoclaw/src/**/*.{cts,mts,ts,tsx}"],
      rules: {
        "no-unused-vars": "error",
        "typescript/no-explicit-any": "error",
        "typescript/consistent-type-exports": "error",
        "typescript/consistent-type-imports": ["error", { disallowTypeAnnotations: false }],
        "typescript/no-floating-promises": "error",
        "typescript/switch-exhaustiveness-check": "error",
      },
    },
    {
      files: ["src/lib/adapters/**/*.ts"],
      rules: {
        eqeqeq: "error",
        "typescript/no-misused-promises": "error",
        "typescript/await-thenable": "error",
      },
    },
    {
      files: ["src/lib/adapters/**/*.ts"],
      excludeFiles: ["**/*.test.ts"],
      rules: {
        "no-nested-ternary": "error",
        "typescript/no-non-null-assertion": "error",
      },
    },
    ...Object.entries(legacyComplexityLimits).map(([file, limit]) => ({
      files: [file],
      rules: { "sonarjs/cognitive-complexity": ["error", limit] as ["error", number] },
    })),
    {
      files: ["nemoclaw/src/**/*.ts"],
      rules: {
        "import/no-commonjs": "error",
        "typescript/prefer-nullish-coalescing": "error",
        "typescript/prefer-optional-chain": "error",
      },
    },
  ],
});
