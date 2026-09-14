// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "oxfmt";

import { oxcIgnorePatterns } from "./oxc.ignore-patterns.ts";

export default defineConfig({
  ignorePatterns: oxcIgnorePatterns,
});
