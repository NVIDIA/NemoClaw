// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";

import {
  discoverVitestCandidates,
  expectedProjectForTestPath,
} from "../../scripts/checks/vitest-project-overlap.mts";
import {
  assignStableShards,
  CliCoverageSequencer,
  cliTestTimingHints,
  parseCliTestTimingHints,
  shouldUseCliCoverageSharding,
  timingWeightForPath,
  type WeightedShardEntry,
} from "../helpers/cli-coverage-sequencer";

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

function currentCliCoverageEntries(): WeightedShardEntry<string>[] {
  const coverageProjects = new Set(["cli", "integration", "e2e-support"]);
  return [...discoverVitestCandidates()].flatMap((file) => {
    const projectName = expectedProjectForTestPath(file);
    return projectName && coverageProjects.has(projectName)
      ? [
          {
            key: `${projectName}:${file}`,
            weightMs: timingWeightForPath(file),
            value: file,
          },
        ]
      : [];
  });
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

    expect(entries.every((entry) =>
        Object.is(withAddition.get(entry.key), baseline.get(entry.key)))).toBe(true);
    expect(entries.slice(1).every((entry) =>
        Object.is(withRemoval.get(entry.key), baseline.get(entry.key)))).toBe(true);
  });

  it("keeps recorded project and path keys on their stable shards", () => {
    const keys = [
      "integration:test/credentials/local-credential-helper-fields.test.ts",
      "integration:test/agents/hermes/hermes-restart-config-seal-write-lock.test.ts",
      "integration:test/regular-0.test.ts",
      "cli:src/lib/example.test.ts",
      "e2e-support:test/e2e/support/example.test.ts",
    ];
    const owners = assignmentOwners(
      keys.map((key) => ({ key, weightMs: 5_000, value: key })),
      8,
    );

    expect(Object.fromEntries(owners)).toEqual({
      "cli:src/lib/example.test.ts": 1,
      "e2e-support:test/e2e/support/example.test.ts": 8,
      "integration:test/agents/hermes/hermes-restart-config-seal-write-lock.test.ts": 2,
      "integration:test/credentials/local-credential-helper-fields.test.ts": 6,
      "integration:test/regular-0.test.ts": 6,
    });
  });

  it("keeps the current test roster balanced across the ten CI shards (#6237)", () => {
    const shards = assignStableShards(currentCliCoverageEntries(), 10);
    const weights = shards.map((shard) => shard.totalWeightMs);
    const averageWeight = weights.reduce((total, weight) => total + weight, 0) / weights.length;

    expect(Math.max(...weights)).toBeLessThanOrEqual(averageWeight * 1.06);
  });

  it("balances the serialized integration lane across the ten CI shards (#6237)", () => {
    const integrationEntries = currentCliCoverageEntries().filter((entry) =>
      entry.key.startsWith("integration:"),
    );
    expect(integrationEntries.length).toBeGreaterThan(0);

    const weights = assignStableShards(integrationEntries, 10).map(
      (shard) => shard.totalWeightMs,
    );
    const averageWeight = weights.reduce((total, weight) => total + weight, 0) / weights.length;

    expect(Math.max(...weights)).toBeLessThanOrEqual(averageWeight * 1.1);
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
      testSpecification("test/credentials/local-credential-helper-fields.test.ts", "local-credentials"),
      testSpecification("test/agents/hermes/hermes-restart-config-seal-write-lock.test.ts", "hermes-config"),
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
    expect(owners.get("local-credentials")).toBeDefined();
    expect(owners.get("hermes-config")).toBeDefined();
  });

  it("validates the checked-in timing hints and provides a conservative fallback", () => {
    const files = Object.keys(cliTestTimingHints.files);

    expect(cliTestTimingHints.defaultDurationMs).toBe(5_000);
    expect(cliTestTimingHints.sources).toEqual([
      {
        runId: 33895428444,
        artifactId: 9946097324,
        headSha: "58732cfd84267842e6d8caa08ee9c7eeb01bf41a",
        recordedAt: "2026-09-04T16:46:06Z",
      },
      {
        runId: 33898651121,
        artifactId: 9947254151,
        headSha: "d99d1dc579b26be7b240cf50d26b210b7a8d1b1d",
        recordedAt: "2026-09-04T17:20:15Z",
      },
      {
        runId: 33917968257,
        artifactId: 9954274692,
        headSha: "37cedc99007a776d4ea4591fcc74eb14bdcc0ef9",
        recordedAt: "2026-09-04T21:00:44Z",
      },
      {
        runId: 33921927346,
        artifactId: 9955756307,
        headSha: "94bb868ea0f3e98533b06196def74b7559a1d1d4",
        recordedAt: "2026-09-04T21:52:12Z",
      },
      {
        runId: 33930230351,
        artifactId: 9958570313,
        headSha: "5b74336486a8492ad87dd7eaba3d1bc06abbadf6",
        recordedAt: "2026-09-04T23:53:49Z",
      },
    ]);
    expect(files).toEqual([...files].sort());
    expect(files.length).toBeGreaterThan(50);
    files.forEach((file) => {
      expect(existsSync(path.resolve(file)), file).toBe(true);
      expect(cliTestTimingHints.files[file]).toBeGreaterThan(cliTestTimingHints.defaultDurationMs);
    });
    expect(timingWeightForPath("test/new-unprofiled-test.test.ts")).toBe(5_000);
  });

  it("rejects malformed timing hint manifests", () => {
    expect(() => parseCliTestTimingHints({ schemaVersion: 1 })).toThrow(/schemaVersion 2/u);
    expect(() =>
      parseCliTestTimingHints({
        ...cliTestTimingHints,
        files: { "../../outside.test.ts": 6_000 },
      }),
    ).toThrow(/Invalid CLI test timing hint/u);
  });

  it.each([
    { name: "no sources", sources: [] },
    {
      name: "a source without an artifact ID",
      sources: [
        {
          runId: 32538808045,
          headSha: "9577b175338d6cf1ead335452ade76470f1593a9",
          recordedAt: "2026-08-22T00:40:44Z",
        },
      ],
    },
    {
      name: "a non-positive artifact ID",
      sources: [{ ...cliTestTimingHints.sources[0], artifactId: 0 }],
    },
    {
      name: "a non-integer artifact ID",
      sources: [{ ...cliTestTimingHints.sources[0], artifactId: 1.5 }],
    },
  ])("rejects timing hint manifests with $name", ({ sources }) => {
    expect(() => parseCliTestTimingHints({ ...cliTestTimingHints, sources })).toThrow(
      /timing hints? (?:require source metadata|source)/u,
    );
  });
});
