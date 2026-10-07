// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { collectPaginated } from "../../../tools/e2e/base-image-publication.mts";

it("collects workflow history beyond the former ten-page bound", async () => {
  const entries = Array.from({ length: 1_001 }, (_, index) => ({ id: index + 1 }));
  const requests: string[] = [];

  await expect(
    collectPaginated(
      async (requestPath) => {
        requests.push(requestPath);
        const page = Number(
          new URL(requestPath, "https://api.github.com").searchParams.get("page"),
        );
        const offset = (page - 1) * 100;
        return {
          total_count: entries.length,
          workflow_runs: entries.slice(offset, offset + 100),
        };
      },
      "/runs?per_page=100",
      "workflow_runs",
    ),
  ).resolves.toMatchObject({ total_count: 1_001, workflow_runs: entries });
  expect(requests).toHaveLength(11);
  expect(requests.at(-1)).toBe("/runs?per_page=100&page=11");
});
