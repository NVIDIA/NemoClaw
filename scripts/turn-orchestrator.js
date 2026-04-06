#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("path");
const { parseArgs } = require("util");

const {
  TurnOrchestrationError,
  loadPlan,
  orchestrateTurns,
  writeTurnReport,
} = require("./lib/turn-orchestrator");

function printUsage() {
  console.log(`Usage: node scripts/turn-orchestrator.js --plan <file> [--output <file>] [--sandbox <name>] [--provider <id>] [--session-prefix <prefix>] [--timeout-seconds <n>] [--keep-route] [--skip-route-verification]\n\nPlan JSON fields:\n  sandbox                 Sandbox name to orchestrate\n  task                    Shared task description for all turns\n  provider                Optional default route provider, e.g. ollama-local\n  sharedInstructions      Optional shared rules added to every prompt\n  skipRouteVerification   Optional boolean to pass --no-verify when switching routes\n  turns[]                 Sequence of {agent, model, instructions|message, routeModel?}\n\nExample:\n  node scripts/turn-orchestrator.js --plan ./run/the-crucible-turns.json --skip-route-verification`);
}

async function main() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      "keep-route": { type: "boolean" },
      output: { type: "string", short: "o" },
      plan: { type: "string", short: "p" },
      provider: { type: "string" },
      sandbox: { type: "string", short: "s" },
      "session-prefix": { type: "string" },
      "skip-route-verification": { type: "boolean" },
      "timeout-seconds": { type: "string" },
    },
    strict: true,
  });

  if (values.help || !values.plan) {
    printUsage();
    process.exit(values.help ? 0 : 1);
  }

  const plan = loadPlan(values.plan);
  if (values.sandbox) plan.sandbox = values.sandbox;
  if (values.provider) plan.provider = values.provider;
  if (values["keep-route"]) plan.keepRoute = true;
  if (values["skip-route-verification"]) plan.skipRouteVerification = true;

  const outputPath = values.output || path.join(
    process.cwd(),
    "run",
    `turn-orchestration-${new Date().toISOString().replaceAll(":", "-")}.json`
  );

  try {
    const result = await orchestrateTurns(plan, {
      keepRoute: values["keep-route"],
      log: (line) => process.stderr.write(`${line}\n`),
      sessionPrefix: values["session-prefix"] || "turn",
      skipRouteVerification: plan.skipRouteVerification,
      timeoutSeconds: values["timeout-seconds"] || 180,
    });
    writeTurnReport(outputPath, result);
    process.stdout.write(JSON.stringify({ outputPath, turns: result.turns.length }, null, 2) + "\n");
  } catch (error) {
    if (error instanceof TurnOrchestrationError && error.result) {
      writeTurnReport(outputPath, error.result);
      process.stderr.write(`${error.message}\nSaved partial report to ${outputPath}\n`);
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
