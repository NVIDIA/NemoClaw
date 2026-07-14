// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";

import {
  assignStableShards,
  CliCoverageSequencer,
  cliTestTimingHints,
  parseCliTestTimingHints,
  shouldUseCliCoverageSharding,
  timingWeightForPath,
  type WeightedShardEntry,
} from "./helpers/cli-coverage-sequencer";

function assignmentKeys(entries: readonly WeightedShardEntry<string>[]) {
  return assignStableShards(entries, 4).map((shard) => shard.entries.map((entry) => entry.key));
}

function assignmentOwners(entries: readonly WeightedShardEntry<string>[], shardCount = 4) {
  return new Map(
    assignStableShards(entries, shardCount).flatMap((shard) =>
      shard.entries.map((entry) => [entry.key, shard.index] as const),
    ),
  );
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

function representativeCliCoverageEntries(): WeightedShardEntry<string>[] {
  const measured = Object.entries(cliTestTimingHints.files).map(([file, weightMs]) => {
    const projectName = file.startsWith("src/")
      ? "cli"
      : file.startsWith("test/e2e/support/")
        ? "e2e-support"
        : "integration";
    return { key: `${projectName}:${file}`, weightMs, value: file };
  });
  const projectSizes = { cli: 832, integration: 512, "e2e-support": 116 } as const;
  const ordinary = (Object.keys(projectSizes) as (keyof typeof projectSizes)[]).flatMap(
    (projectName) => {
      const measuredCount = measured.filter((entry) =>
        entry.key.startsWith(`${projectName}:`),
      ).length;
      return Array.from({ length: projectSizes[projectName] - measuredCount }, (_, index) => {
        const file =
          projectName === "cli"
            ? `src/lib/fixture-${index}.test.ts`
            : projectName === "e2e-support"
              ? `test/e2e/support/fixture-${index}.test.ts`
              : `test/fixture-${index}.test.ts`;
        return {
          key: `${projectName}:${file}`,
          weightMs: cliTestTimingHints.defaultDurationMs,
          value: file,
        };
      });
    },
  );

  return [...measured, ...ordinary];
}

describe("stable CLI coverage sharding", () => {
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

  it("keeps existing files on the same shards when the test roster changes", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      key: `regular-${String(index + 1).padStart(2, "0")}`,
      weightMs: 5_000,
      value: `regular-${index + 1}`,
    }));
    const baseline = assignmentOwners(entries);
    const withAddition = assignmentOwners([
      { key: "regular-00", weightMs: 5_000, value: "regular-0" },
      ...entries,
    ]);
    const withRemoval = assignmentOwners(entries.slice(1));

    for (const entry of entries) {
      expect(withAddition.get(entry.key), entry.key).toBe(baseline.get(entry.key));
    }
    for (const entry of entries.slice(1)) {
      expect(withRemoval.get(entry.key), entry.key).toBe(baseline.get(entry.key));
    }
  });

  it("keeps recorded project and path keys on their stable shards", () => {
    const keys = [
      "integration:test/local-credential-helper-fields.test.ts",
      "integration:test/hermes-restart-config-seal-write-lock.test.ts",
      "integration:test/regular-0.test.ts",
      "cli:src/lib/example.test.ts",
      "e2e-support:test/e2e/support/example.test.ts",
    ];
    const owners = assignmentOwners(
      keys.map((key) => ({ key, weightMs: 5_000, value: key })),
      8,
    );

    expect(Object.fromEntries(owners)).toEqual({
      "cli:src/lib/example.test.ts": 7,
      "e2e-support:test/e2e/support/example.test.ts": 3,
      "integration:test/hermes-restart-config-seal-write-lock.test.ts": 2,
      "integration:test/local-credential-helper-fields.test.ts": 1,
      "integration:test/regular-0.test.ts": 3,
    });
  });

  it("keeps a representative test roster balanced across the eight CI shards", () => {
    const shards = assignStableShards(representativeCliCoverageEntries(), 8);
    const weights = shards.map((shard) => shard.totalWeightMs);
    const averageWeight = weights.reduce((total, weight) => total + weight, 0) / weights.length;

    expect(Math.max(...weights)).toBeLessThanOrEqual(averageWeight * 1.05);
  });

  it("uses stable sharding only for projects owned by the CLI coverage matrix", () => {
    expect(shouldUseCliCoverageSharding(["cli", "integration", "e2e-support"])).toBe(true);
    expect(shouldUseCliCoverageSharding(["integration"])).toBe(true);
    expect(shouldUseCliCoverageSharding(["e2e-support"])).toBe(true);
    expect(shouldUseCliCoverageSharding(["plugin"])).toBe(false);
    expect(shouldUseCliCoverageSharding([])).toBe(false);
  });

  it("wires stable project and path ownership into the Vitest sequencer", async () => {
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
