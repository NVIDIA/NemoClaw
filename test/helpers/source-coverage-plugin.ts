// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from "vite";

export function sourceCoveragePlugin(): Plugin {
  return {
    name: "nemoclaw-source-coverage",
    enforce: "pre",
    config(config) {
      // Blob replay installs placeholder transforms for recorded modules.
      // Report merging executes no tests and can load the provider natively.
      const merging =
        config.test?.mergeReports ||
        process.argv.some((argument) =>
          /^(?:--mergeReports|--merge-reports)(?:=|$)/.test(argument),
        );
      if (merging) return { test: { experimental: { viteModuleRunner: false } } };
    },
    transform(source, id) {
      // The provider publishes the collector shared with the native loader.
      const state = Reflect.get(globalThis, Symbol.for("nemoclaw.source-coverage.state"));
      return state?.instrument(source, id);
    },
  };
}
