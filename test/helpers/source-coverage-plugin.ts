// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from "vite";

export const sourceCoverageExternal = /[/\\]test[/\\]helpers[/\\]source-coverage\.cts$/;

export function sourceCoveragePlugin(): Plugin {
  return {
    name: "nemoclaw-source-coverage",
    enforce: "pre",
    config(config) {
      // Blob replay installs placeholder transforms for recorded modules.
      // Report merging executes no tests and can load the provider natively.
      const merging =
        Reflect.get(config.test ?? {}, "mergeReports") ||
        process.argv.some((argument) =>
          /^(?:--mergeReports|--merge-reports)(?:=|$)/.test(argument),
        );
      return {
        test: {
          // The shared CommonJS collector is typed, but Vite parses .cts as
          // JavaScript. Node strips its types and preserves the native cache.
          server: { deps: { external: [sourceCoverageExternal] } },
          ...(merging ? { experimental: { viteModuleRunner: false } } : {}),
        },
      };
    },
    transform(source, id) {
      // The provider publishes the collector shared with the native loader.
      const state = Reflect.get(globalThis, Symbol.for("nemoclaw.source-coverage.state"));
      return state?.instrument(source, id);
    },
  };
}
