// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "oxfmt";

import { oxcIgnorePatterns } from "./oxc.ignore-patterns.ts";

export default defineConfig({
  arrowParens: "always",
  bracketSameLine: false,
  bracketSpacing: true,
  endOfLine: "lf",
  ignorePatterns: oxcIgnorePatterns,
  jsxSingleQuote: false,
  printWidth: 100,
  proseWrap: "never",
  quoteProps: "as-needed",
  semi: true,
  singleQuote: false,
  sortImports: false,
  sortPackageJson: false,
  sortTailwindcss: {
    functions: ["clsx", "cva", "tw", "twMerge", "cn", "twJoin", "tv"],
  },
  tabWidth: 2,
  trailingComma: "all",
  useTabs: false,
});
