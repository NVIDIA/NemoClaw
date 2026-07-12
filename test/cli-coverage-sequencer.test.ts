// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";

import {
  assignWeightedShards,
  CliCoverageSequencer,
  cliTestTimingHints,
  parseCliTestTimingHints,
  shouldUseDurationAwareSharding,
  timingWeightForPath,
  type WeightedShardEntry,
} from "./helpers/cli-coverage-sequencer";

function assignmentKeys(entries: readonly WeightedShardEntry<string>[]) {
  return assignWeightedShards(entries, 4).map((shard) => shard.entries.map((entry) => entry.key));
}

function testSpecification(file: string, taskId: string): TestSpecification {
  return {
    moduleId: path.join("/repo", file),
    pool: "forks",
    project: { name: "integration" },
    taskId,
  } as unknown as TestSpecification;
}

function sequencer(index: number, count: number): CliCoverageSequencer {
  return new CliCoverageSequencer({
    config: { root: "/repo", shard: { index, count } },
  } as unknown as Vitest);
}

describe("CLI coverage duration-aware sharding", () => {
  it("assigns every file exactly once and independently of discovery order", () => {
    const entries = [
      { key: "slow-a", weightMs: 50_000, value: "slow-a" },
      { key: "slow-b", weightMs: 49_000, value: "slow-b" },
      ...Array.from({ length: 14 }, (_, index) => ({
        key: `regular-${String(index).padStart(2, "0")}`,
        weightMs: 5_000,
        value: `regular-${index}`,
      })),
    ];

    const forward = assignmentKeys(entries);
    const reversed = assignmentKeys([...entries].reverse());
    expect(reversed).toEqual(forward);
    expect(forward.flat().sort()).toEqual(entries.map((entry) => entry.key).sort());
  });

  it("separates slow outliers and keeps estimated shard weights close", () => {
    const entries = [
      { key: "slow-a", weightMs: 50_000, value: "slow-a" },
      { key: "slow-b", weightMs: 49_000, value: "slow-b" },
      { key: "warm-a", weightMs: 15_000, value: "warm-a" },
      { key: "warm-b", weightMs: 14_000, value: "warm-b" },
      ...Array.from({ length: 12 }, (_, index) => ({
        key: `regular-${String(index).padStart(2, "0")}`,
        weightMs: 5_000,
        value: `regular-${index}`,
      })),
    ];
    const shards = assignWeightedShards(entries, 4);
    const owners = new Map(
      shards.flatMap((shard) => shard.entries.map((entry) => [entry.key, shard.index] as const)),
    );
    const weights = shards.map((shard) => shard.totalWeightMs);

    expect(owners.get("slow-a")).not.toBe(owners.get("slow-b"));
    expect(Math.max(...weights)).toBeLessThanOrEqual(50_000);
    expect(Math.min(...weights)).toBeGreaterThanOrEqual(44_000);
  });

  it("uses duration-aware scheduling only for CLI coverage projects", () => {
    expect(shouldUseDurationAwareSharding(["cli", "integration"])).toBe(true);
    expect(shouldUseDurationAwareSharding(["integration"])).toBe(true);
    expect(shouldUseDurationAwareSharding(["plugin"])).toBe(false);
    expect(shouldUseDurationAwareSharding([])).toBe(false);
  });

  it("wires the measured hints into the Vitest sequencer", async () => {
    const specifications = [
      testSpecification("test/local-credential-helper-fields.test.ts", "local-credentials"),
      testSpecification("test/hermes-restart-config-seal-write-lock.test.ts", "hermes-config"),
      ...Array.from({ length: 8 }, (_, index) =>
        testSpecification(`test/regular-${index}.test.ts`, `regular-${index}`),
      ),
    ];
    const first = await sequencer(1, 2).shard(specifications);
    const second = await sequencer(2, 2).shard(specifications);
    const owners = new Map(
      [first, second].flatMap((shard, index) =>
        shard.map((specification) => [specification.taskId, index + 1] as const),
      ),
    );

    expect([...first, ...second].map((specification) => specification.taskId).sort()).toEqual(
      specifications.map((specification) => specification.taskId).sort(),
    );
    expect(owners.get("local-credentials")).not.toBe(owners.get("hermes-config"));
  });

  it("validates the checked-in timing hints and provides a conservative fallback", () => {
    const files = Object.keys(cliTestTimingHints.files);

    expect(cliTestTimingHints.defaultDurationMs).toBe(5_000);
    expect(files).toEqual([...files].sort());
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      expect(existsSync(path.resolve(file)), file).toBe(true);
      expect(cliTestTimingHints.files[file]).toBeGreaterThan(cliTestTimingHints.defaultDurationMs);
    }
    expect(timingWeightForPath("test/new-unprofiled-test.test.ts")).toBe(5_000);
  });

  it("rejects malformed timing hint manifests", () => {
    expect(() => parseCliTestTimingHints({ schemaVersion: 2 })).toThrow(/schemaVersion 1/u);
    expect(() =>
      parseCliTestTimingHints({
        ...cliTestTimingHints,
        files: { "../outside.test.ts": 6_000 },
      }),
    ).toThrow(/Invalid CLI test timing hint/u);
  });
});
