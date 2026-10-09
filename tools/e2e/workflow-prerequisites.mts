// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import YAML from "yaml";

// Use the trusted workflow's dependency graph, not a second list of image consumers.
export function requiresManagedImages(
  selectedJobs: readonly string[],
  jobs: Record<string, { needs?: string | string[] }> = YAML.parse(
    readFileSync(new URL("../../.github/workflows/e2e.yaml", import.meta.url), "utf8"),
  ).jobs,
): boolean {
  const visit = (job: string, ancestors: readonly string[]): boolean => {
    if (!Object.hasOwn(jobs, job)) throw new Error(`Unknown E2E prerequisite: ${job}`);
    if (ancestors.includes(job)) throw new Error(`Cyclic E2E prerequisite: ${job}`);
    if (job === "base-image-publication") return true;
    const dependencies = jobs[job]!.needs ?? [];
    const needs = typeof dependencies === "string" ? [dependencies] : dependencies;
    if (!Array.isArray(needs) || needs.some((value) => typeof value !== "string")) {
      throw new Error(`Invalid E2E prerequisites: ${job}`);
    }
    return needs.map((dependency) => visit(dependency, [...ancestors, job])).some(Boolean);
  };
  return selectedJobs.map((job) => visit(job, [])).some(Boolean);
}
