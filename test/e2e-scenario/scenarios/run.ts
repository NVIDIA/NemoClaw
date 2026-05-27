// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compileRunPlans, renderPlanText, writePlanArtifacts } from "./compiler.ts";
import { ScenarioRunner } from "./orchestrators/runner.ts";
import { listScenarios } from "./registry.ts";

interface Args {
  list: boolean;
  planOnly: boolean;
  dryRun: boolean;
  validateOnly: boolean;
  scenarios: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, planOnly: false, dryRun: false, validateOnly: false, scenarios: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--plan-only") {
      args.planOnly = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--validate-only") {
      args.validateOnly = true;
      continue;
    }
    if (arg === "--scenarios") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--scenarios requires a comma-separated value");
      }
      args.scenarios = value.split(",").map((id) => id.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printList() {
  console.log("hybrid scenario registry");
  for (const scenario of listScenarios()) {
    console.log(`- ${scenario.id}${scenario.description ? `: ${scenario.description}` : ""}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    printList();
    return;
  }

  const modeCount = [args.planOnly, args.dryRun, args.validateOnly].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("Use exactly one of --plan-only, --dry-run, or --validate-only with --scenarios <id[,id...]>");
  }
  if (args.scenarios.length === 0) {
    throw new Error("scenario execution requires --scenarios <id[,id...]>");
  }

  if (process.env.E2E_SUITE_FILTER) {
    throw new Error("E2E_SUITE_FILTER is not supported; define assertion selection in scenario builders.");
  }

  const plans = compileRunPlans(args.scenarios);
  const contextDir = process.env.E2E_CONTEXT_DIR ?? process.cwd();
  writePlanArtifacts(plans, contextDir);
  console.log(renderPlanText(plans));

  if (args.dryRun) {
    const runner = new ScenarioRunner();
    for (const plan of plans) {
      await runner.run({ contextDir, dryRun: true }, plan);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
