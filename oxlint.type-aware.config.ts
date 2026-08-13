// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

const disabledUltraciteRules = Object.fromEntries(
  Object.keys(core.rules ?? {}).map((rule) => [rule, "off"]),
);

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
  extends: [core],
  ignorePatterns: [...(core.ignorePatterns ?? []), ".claude", ".pi"],
  options: {
    typeAware: true,
  },
  rules: {
    ...disabledUltraciteRules,
    "typescript/no-floating-promises": "error",
  },
});
