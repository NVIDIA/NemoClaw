// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const LOCAL_INTEGRATION_WORKER_CAP = 4;
const CLI_COVERAGE_SHARD_WORKER_CAP = 1;

interface IntegrationProjectSchedulingContext {
  isCi: boolean;
  npmLifecycleEvent: string | undefined;
  argv: readonly string[];
  availableParallelism?: number;
}

interface CliCoverageShardSchedulingContext {
  isCi: boolean;
  cliShard: string | undefined;
  cliShardCount: string | undefined;
}

function parsePositiveInteger(rawValue: string | undefined): number | null {
  if (!rawValue || !/^\d+$/u.test(rawValue)) return null;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function resolveCliCoverageShardScheduling({
  isCi,
  cliShard,
  cliShardCount,
}: CliCoverageShardSchedulingContext) {
  const shard = parsePositiveInteger(cliShard);
  const shardCount = parsePositiveInteger(cliShardCount);
  return isCi && shard !== null && shardCount !== null && shard <= shardCount
    ? { maxWorkers: CLI_COVERAGE_SHARD_WORKER_CAP }
    : {};
}

function parseWorkerCount(rawValue: string, availableWorkers: number): number {
  if (/^\d+$/.test(rawValue)) {
    const parsed = Number(rawValue);
    if (parsed >= 1 && Number.isSafeInteger(parsed)) return parsed;
  } else if (/^\d+%$/.test(rawValue)) {
    const percentage = Number(rawValue.slice(0, -1));
    if (percentage >= 1 && Number.isSafeInteger(percentage)) {
      return Math.max(1, Math.round((percentage / 100) * availableWorkers));
    }
  }
  throw new Error(`Invalid --maxWorkers value: "${rawValue}"`);
}

function resolveWorkerCap(argv: readonly string[], availableWorkers: number): number {
  const availableWorkerCap = Math.max(1, Math.floor(availableWorkers));
  let requested: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    let rawValue: string | undefined;
    if (argument.startsWith("--maxWorkers=")) {
      rawValue = argument.slice("--maxWorkers=".length);
    } else if (argument === "--maxWorkers") {
      rawValue = argv[index + 1];
      index += 1;
    } else {
      continue;
    }
    if (rawValue === undefined) throw new Error("--maxWorkers requires a number or percentage");
    requested = parseWorkerCount(rawValue, availableWorkerCap);
  }
  return Math.min(
    requested ?? LOCAL_INTEGRATION_WORKER_CAP,
    LOCAL_INTEGRATION_WORKER_CAP,
    availableWorkerCap,
  );
}

export function resolveIntegrationProjectScheduling({
  isCi,
  npmLifecycleEvent,
  argv,
  availableParallelism = LOCAL_INTEGRATION_WORKER_CAP,
}: IntegrationProjectSchedulingContext) {
  const parallelize =
    !isCi &&
    npmLifecycleEvent === "test" &&
    !argv.some((argument) => argument.startsWith("--coverage"));

  return parallelize
    ? {
        fileParallelism: true,
        maxWorkers: resolveWorkerCap(argv, availableParallelism),
        sequence: { groupOrder: 1 },
      }
    : { fileParallelism: false, sequence: { groupOrder: 1 } };
}
