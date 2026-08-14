// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "oxlint";

import { oxcIgnorePatterns } from "./oxc.ignore-patterns.ts";

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
  ignorePatterns: oxcIgnorePatterns,
  options: {
    typeAware: true,
  },
  plugins: ["typescript"],
  rules: {
    "typescript/no-floating-promises": "error",
  },
});
