// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveIntegrationProjectScheduling } from "./helpers/integration-project-scheduling";

describe("integration project scheduling", () => {
  it("parallelizes the canonical local full-suite run (#6245)", () => {
    expect(
      resolveIntegrationProjectScheduling({
        isCi: false,
        npmLifecycleEvent: "test",
        argv: [],
      }),
    ).toEqual({
      fileParallelism: true,
      maxWorkers: 4,
      sequence: { groupOrder: 1 },
    });
  });

  it.each([
    [["--maxWorkers=1"], 1],
    [["--maxWorkers", "2"], 2],
    [["--maxWorkers=8"], 4],
  ])("honors the explicit local worker cap in %j (#6245)", (argv, maxWorkers) => {
    expect(
      resolveIntegrationProjectScheduling({
        isCi: false,
        npmLifecycleEvent: "test",
        argv,
      }),
    ).toEqual({
      fileParallelism: true,
      maxWorkers,
      sequence: { groupOrder: 1 },
    });
  });

  it.each([
    ["CI full suite", { isCi: true, npmLifecycleEvent: "test", argv: [] }],
    ["coverage shorthand", { isCi: false, npmLifecycleEvent: "test", argv: ["--coverage"] }],
    [
      "coverage property",
      { isCi: false, npmLifecycleEvent: "test", argv: ["--coverage.enabled=true"] },
    ],
    ["coverage script", { isCi: false, npmLifecycleEvent: "test:coverage:cli", argv: [] }],
    [
      "focused integration script",
      { isCi: false, npmLifecycleEvent: "test:integration", argv: [] },
    ],
    ["direct Vitest", { isCi: false, npmLifecycleEvent: undefined, argv: [] }],
  ])("keeps $0 serialized (#6245)", (_name, context) => {
    expect(resolveIntegrationProjectScheduling(context)).toEqual({ fileParallelism: false });
  });
});
