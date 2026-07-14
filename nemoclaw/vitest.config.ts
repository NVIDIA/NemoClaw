// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { defineConfig, defineProject } from "vitest/config";

import pluginVitestProjectOptions from "./vitest.project.js";

const pluginVitestProject = defineProject(pluginVitestProjectOptions);

export default defineConfig({
  ...pluginVitestProject,
  test: {
    ...pluginVitestProject.test,
    globalSetup: path.resolve(import.meta.dirname, "../test/helpers/vitest-temp-root.ts"),
  },
});
