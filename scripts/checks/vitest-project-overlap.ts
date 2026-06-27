// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VITEST = path.join(
  REPO_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vitest.cmd" : "vitest",
);

const result = spawnSync(VITEST, ["list", "--filesOnly"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  env: {
    ...process.env,
    NEMOCLAW_RUN_BRANCH_VALIDATION_E2E: "1",
    NEMOCLAW_RUN_E2E_SCENARIOS: "1",
  },
});

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const projectsByFile = new Map<string, Set<string>>();
const projects = new Set<string>();
for (const line of result.stdout.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const match = line.match(/^\[([^\]]+)\]\s+(.+)$/);
  if (!match) throw new Error(`Could not parse Vitest project listing line: ${line}`);
  const [, project, file] = match;
  projects.add(project);
  const memberships = projectsByFile.get(file) ?? new Set<string>();
  memberships.add(project);
  projectsByFile.set(file, memberships);
}

const overlaps = [...projectsByFile]
  .filter(([, memberships]) => memberships.size > 1)
  .sort(([left], [right]) => left.localeCompare(right));

if (overlaps.length > 0) {
  console.error("Vitest files must belong to exactly one project:");
  for (const [file, memberships] of overlaps) {
    console.error(`  ${file}: ${[...memberships].sort().join(", ")}`);
  }
  process.exit(1);
}

console.log(
  `Vitest project membership is disjoint (${projectsByFile.size} files across ${projects.size} projects).`,
);
