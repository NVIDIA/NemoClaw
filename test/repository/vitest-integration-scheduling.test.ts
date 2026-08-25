// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  resolveCliCoverageShardScheduling,
  resolveIntegrationProjectScheduling,
} from "../helpers/integration-project-scheduling";

describe("CLI coverage shard scheduling", () => {
  it("uses two workers for a validated CI shard (#6237)", () => {
    expect(
      resolveCliCoverageShardScheduling({
        isCi: true,
        cliShard: "2",
        cliShardCount: "12",
      }),
    ).toEqual({ maxWorkers: 2 });
  });

  it.each([
    ["local shard", false, "1", "12"],
    ["missing shard", true, undefined, "12"],
    ["missing shard count", true, "1", undefined],
    ["invalid shard", true, "x", "12"],
    ["invalid shard count", true, "1", "0"],
    ["out-of-range shard", true, "13", "12"],
  ])("does not constrain $0", (_name, isCi, cliShard, cliShardCount) => {
    expect(
      resolveCliCoverageShardScheduling({ isCi, cliShard, cliShardCount }),
    ).toEqual({});
  });
});

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
    [["--maxWorkers=1"], 1, 8],
    [["--maxWorkers", "2"], 2, 8],
    [["--maxWorkers=10%"], 2, 20],
    [["--maxWorkers=8"], 4, 8],
  ])("honors the explicit local worker cap in %j (#6245)", (argv, maxWorkers, workers) => {
    expect(
      resolveIntegrationProjectScheduling({
        isCi: false,
        npmLifecycleEvent: "test",
        argv,
        availableParallelism: workers,
      }),
    ).toEqual({
      fileParallelism: true,
      maxWorkers,
      sequence: { groupOrder: 1 },
    });
  });

  it.each([
    "--maxWorkers=invalid",
    "--maxWorkers",
  ])("rejects the invalid local worker cap %s (#6245)", (argument) => {
    expect(() =>
      resolveIntegrationProjectScheduling({
        isCi: false,
        npmLifecycleEvent: "test",
        argv: [argument],
      }),
    ).toThrow(/--maxWorkers/);
  });

  it.each([
    ["CI full suite", { isCi: true, npmLifecycleEvent: "test", argv: [] }],
    ["coverage shorthand", { isCi: false, npmLifecycleEvent: "test", argv: ["--coverage"] }],
    [
      "coverage property",
      { isCi: false, npmLifecycleEvent: "test", argv: ["--coverage.enabled=true"] },
    ],
    [
      "coverage sub-option",
      { isCi: false, npmLifecycleEvent: "test", argv: ["--coverage.provider=v8"] },
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
