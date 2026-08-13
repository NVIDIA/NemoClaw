// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export const antiSlopRules = {
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-conditional-empty-object-spread": "error",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-runtime-typeof": "error",
  "anti-slop/no-shape-in-symbol-names": "error",
  "anti-slop/no-unknown-parameters": "error",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "error",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "error",
} as const;

const disabledUltraciteRules = Object.fromEntries(
  Object.keys(core.rules ?? {}).map((rule) => [rule, "off"]),
);

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
  extends: [core],
  ignorePatterns: [...(core.ignorePatterns ?? []), ".claude", ".pi", "tools/oxlint/anti-slop"],
  jsPlugins: [
    {
      name: "anti-slop",
      specifier: fileURLToPath(new URL("./tools/oxlint/anti-slop/index.ts", import.meta.url)),
    },
    {
      name: "sonarjs",
      specifier: "eslint-plugin-sonarjs",
    },
  ],
  rules: {
    ...disabledUltraciteRules,
    "sonarjs/cognitive-complexity": ["error", 149],
    "no-undef": "error",
  },
  overrides: [
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
    // Pin current SonarJS scores for existing hotspots so the migration rejects further growth.

    {
      files: ["src/lib/onboard/machine/handlers/provider-inference.ts"],
      rules: {
        "sonarjs/cognitive-complexity": ["error", 170],
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
