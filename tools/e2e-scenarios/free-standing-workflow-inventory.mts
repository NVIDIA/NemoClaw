// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  formatFreeStandingJobsInventoryForShell,
  readFreeStandingJobsInventory,
} from "./workflow-boundary.mts";

function usage(): string {
  return [
    "Usage: npx tsx tools/e2e-scenarios/free-standing-workflow-inventory.mts [--shell] [--workflow PATH]",
    "",
    "Derives free-standing E2E Vitest selector mappings from workflow job metadata.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): {
  shell: boolean;
  workflowPath?: string;
} {
  const parsed: { shell: boolean; workflowPath?: string } = { shell: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--shell") {
      parsed.shell = true;
      continue;
    }
    if (arg === "--workflow") {
      const workflowPath = argv[index + 1];
      if (!workflowPath) throw new Error("--workflow requires a path");
      parsed.workflowPath = workflowPath;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const inventory = readFreeStandingJobsInventory(options.workflowPath);
  if (options.shell) {
    process.stdout.write(formatFreeStandingJobsInventoryForShell(inventory));
  } else {
    process.stdout.write(
      `${JSON.stringify(
        {
          allowedJobs: inventory.allowedJobs,
          freeStandingScenarios: inventory.freeStandingScenarios,
          scenarioJobs: Object.fromEntries(inventory.scenarioToJob),
        },
        null,
        2,
      )}\n`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  for (const line of message.split("\n")) {
    console.error(`::error::${line}`);
  }
  process.exitCode = 1;
}
