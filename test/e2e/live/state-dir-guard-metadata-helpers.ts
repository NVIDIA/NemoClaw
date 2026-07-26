// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export interface TreeMeasurement {
  entries: number;
  directories: number;
  files: number;
  logicalBytes: number;
  allocatedBytes: number;
  copiedBytes: number;
  maxDepth: number;
}

export function requireEnvironment(
  condition: boolean,
  reason: string,
  skip: (reason: string) => never,
): void {
  if (condition) return;
  if (process.env.GITHUB_ACTIONS === "true") throw new Error(reason);
  skip(reason);
}

export function measureTree(fixtureRoot: string): TreeMeasurement {
  const measurement: TreeMeasurement = {
    entries: 0,
    directories: 0,
    files: 0,
    logicalBytes: 0,
    allocatedBytes: 0,
    copiedBytes: 0,
    maxDepth: 0,
  };
  const visit = (directory: string, depth: number): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = fs.lstatSync(candidate);
      measurement.entries += 1;
      measurement.maxDepth = Math.max(measurement.maxDepth, depth);
      if (entry.isDirectory()) {
        measurement.directories += 1;
        visit(candidate, depth + 1);
      } else if (entry.isFile()) {
        measurement.files += 1;
        measurement.logicalBytes += stat.size;
        measurement.allocatedBytes += stat.blocks * 512;
        measurement.copiedBytes += stat.size;
      }
    }
  };
  visit(fixtureRoot, 1);
  return measurement;
}

export function treeDirectories(fixtureRoot: string): string[] {
  const directories = [fixtureRoot];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      directories.push(candidate);
      visit(candidate);
    }
  };
  visit(fixtureRoot);
  return directories;
}
