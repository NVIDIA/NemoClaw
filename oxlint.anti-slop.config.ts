// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "oxlint";

import base, { antiSlopRules } from "./oxlint.config.ts";

export default defineConfig({
  extends: [base],
  rules: antiSlopRules,
});
