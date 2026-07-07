// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const COVERAGE_ENABLE_ARGUMENTS = new Set([
  "--coverage",
  "--coverage=true",
  "--coverage.enabled",
  "--coverage.enabled=true",
]);
const LOCAL_INTEGRATION_WORKER_CAP = 4;

interface IntegrationProjectSchedulingContext {
  isCi: boolean;
  npmLifecycleEvent: string | undefined;
  argv: readonly string[];
}

function resolveWorkerCap(argv: readonly string[]): number {
  let requested: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    const rawValue = argument.startsWith("--maxWorkers=")
      ? argument.slice("--maxWorkers=".length)
      : argument === "--maxWorkers"
        ? argv[index + 1]
        : undefined;
    if (rawValue === undefined || !/^\d+$/.test(rawValue)) continue;
    const parsed = Number(rawValue);
    if (parsed >= 1 && Number.isSafeInteger(parsed)) requested = parsed;
  }
  return Math.min(requested ?? LOCAL_INTEGRATION_WORKER_CAP, LOCAL_INTEGRATION_WORKER_CAP);
}

export function resolveIntegrationProjectScheduling({
  isCi,
  npmLifecycleEvent,
  argv,
}: IntegrationProjectSchedulingContext) {
  const parallelize =
    !isCi &&
    npmLifecycleEvent === "test" &&
    !argv.some((argument) => COVERAGE_ENABLE_ARGUMENTS.has(argument));

  return parallelize
    ? {
        fileParallelism: true,
        maxWorkers: resolveWorkerCap(argv),
        sequence: { groupOrder: 1 },
      }
    : { fileParallelism: false };
}
