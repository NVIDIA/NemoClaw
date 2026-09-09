// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BaseSequencer, type TestSpecification } from "vitest/node";
import { parseCliTestTimingHints } from "../../scripts/checks/cli-test-timing-hints.mts";

export interface WeightedShardEntry<T> {
  key: string;
  weightMs: number;
  value: T;
}

export interface WeightedShard<T> {
  index: number;
  totalWeightMs: number;
  entries: WeightedShardEntry<T>[];
}

// E2E-support is hermetic and shares the same installed dependencies and CLI
// build as the CLI coverage projects, so the coverage matrix owns it too.
const cliCoverageProjects = new Set(["cli", "integration", "e2e-support"]);
// Changing a salt intentionally remaps that lane's tests. These values are
// calibrated against the timing-hint source profile, then kept fixed so
// ordinary roster changes preserve ownership between profile refreshes.
// Integration coverage is serialized, so it needs an independent salt instead
// of relying on combined weight from the parallel CLI and E2E-support lanes.
const stableShardSalt = "45603";
const integrationShardSalt = "7876";
const e2eSupportShardSalt = "96995";
// Only measured outliers are stored; new and ordinary files share the
// conservative fallback used to estimate each stable shard's load.
const timingHintsUrl = new URL("../../ci/cli-test-timing-hints.json", import.meta.url);

export const cliTestTimingHints = parseCliTestTimingHints(
  JSON.parse(readFileSync(timingHintsUrl, "utf8")),
);

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assignStableShards<T>(
  entries: readonly WeightedShardEntry<T>[],
  shardCount: number,
): WeightedShard<T>[] {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`Invalid shard count: ${shardCount}`);
  }

  const seenKeys = new Set<string>();
  for (const entry of entries) {
    if (
      entry.key.length === 0 ||
      seenKeys.has(entry.key) ||
      !Number.isFinite(entry.weightMs) ||
      entry.weightMs <= 0
    ) {
      throw new Error(`Invalid weighted shard entry: ${entry.key}`);
    }
    seenKeys.add(entry.key);
  }

  const ranked = [...entries].sort((left, right) => compareKeys(left.key, right.key));
  const shards: WeightedShard<T>[] = Array.from({ length: shardCount }, (_, index) => ({
    index: index + 1,
    totalWeightMs: 0,
    entries: [],
  }));

  // Membership depends only on a file's durable project/path key. Adding,
  // removing, or renaming another test cannot move existing files between the
  // long-lived coverage shards and change which source maps are merged together.
  for (const entry of ranked) {
    const salt = entry.key.startsWith("integration:")
      ? integrationShardSalt
      : entry.key.startsWith("e2e-support:")
        ? e2eSupportShardSalt
        : stableShardSalt;
    const digest = createHash("sha256").update(`${salt}:${entry.key}`).digest();
    const target = shards[digest.readUInt32BE(0) % shardCount];
    if (!target) throw new Error("Stable shard allocation requires at least one shard");
    target.entries.push(entry);
    target.totalWeightMs += entry.weightMs;
  }

  return shards;
}

export function shouldUseCliCoverageSharding(projectNames: readonly string[]): boolean {
  return (
    projectNames.length > 0 &&
    projectNames.every((projectName) => cliCoverageProjects.has(projectName))
  );
}

export function timingWeightForPath(file: string): number {
  return cliTestTimingHints.files[file] ?? cliTestTimingHints.defaultDurationMs;
}

function relativeTestPath(root: string, moduleId: string): string {
  return path.relative(root, moduleId).split(path.sep).join("/");
}

export class CliCoverageSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    if (!shouldUseCliCoverageSharding(files.map((file) => file.project.name))) {
      return super.shard(files);
    }

    const shard = this.ctx.config.shard;
    if (!shard) return files;

    const assignments = assignStableShards(
      files.map((file) => {
        const filePath = relativeTestPath(this.ctx.config.root, file.moduleId);
        return {
          key: `${file.project.name}:${filePath}`,
          weightMs: timingWeightForPath(filePath),
          value: file,
        };
      }),
      shard.count,
    );

    return assignments[shard.index - 1]?.entries.map((entry) => entry.value) ?? [];
  }
}
