// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

import config from "../../../../vitest.config.ts";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    projects: config.test?.projects?.flatMap((project) => {
      if (
        typeof project !== "object" ||
        !("test" in project) ||
        project.test?.name !== "e2e-live"
      ) {
        return [];
      }
      return [
        {
          ...project,
          plugins: [
            ...(project.plugins ?? []),
            {
              name: "reject-dgx-runtime-collection",
              enforce: "pre" as const,
              load(id: string) {
                if (
                  id.endsWith("/src/lib/inference/vllm.ts") ||
                  id.endsWith("/test/e2e/support/dgx-station-express.ts")
                ) {
                  return 'throw new Error("DGX runtime loaded during collection");';
                }
              },
            },
          ],
        },
      ];
    }),
  },
});
