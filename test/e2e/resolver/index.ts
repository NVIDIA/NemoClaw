// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI entrypoint for the E2E scenario resolver.
 *
 * Usage:
 *   tsx test/e2e/resolver/index.ts plan <scenario-id> [--context-dir <path>]
 *
 * Writes `plan.json` under the context dir (default `.e2e/`) and prints a
 * human-readable plan to stdout. Exits non-zero on any resolution error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadMetadataFromDir } from "./load.ts";
import { resolveScenario, formatPlan } from "./plan.ts";
import {
  validateExpectedState,
  formatReport,
  type ProbeResults,
  type ProbeValue,
} from "./validator.ts";
import { renderCoverageReport } from "./coverage.ts";

function parseArgs(argv: string[]): {
  command: string;
  scenarioId?: string;
  contextDir: string;
  metadataDir: string;
} {
  const args = argv.slice(2);
  const command = args.shift() ?? "";
  let scenarioId: string | undefined;
  let contextDir = process.env.E2E_CONTEXT_DIR ?? ".e2e";
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // resolver/ lives under test/e2e/, so metadata dir is one level up.
  let metadataDir = path.resolve(scriptDir, "..");
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--context-dir") {
      const v = args.shift();
      if (!v) throw new Error("--context-dir requires a value");
      contextDir = v;
    } else if (a === "--metadata-dir") {
      const v = args.shift();
      if (!v) throw new Error("--metadata-dir requires a value");
      metadataDir = v;
    } else if (a && !a.startsWith("--") && !scenarioId) {
      scenarioId = a;
    } else if (a === "--help" || a === "-h") {
      // ignore; help handled by caller
    } else if (a) {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return { command, scenarioId, contextDir, metadataDir };
}

function main(): number {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`resolver: ${(err as Error).message}\n`);
    return 2;
  }
  const { command, scenarioId, contextDir, metadataDir } = parsed;
  if (command === "coverage") {
    try {
      const meta = loadMetadataFromDir(metadataDir);
      const md = renderCoverageReport(meta);
      process.stdout.write(`${md}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`resolver: ${(err as Error).message}\n`);
      return 1;
    }
  }
  if (!scenarioId) {
    process.stderr.write("resolver: missing scenario id\n");
    return 2;
  }
  try {
    const meta = loadMetadataFromDir(metadataDir);
    const plan = resolveScenario(scenarioId, meta);
    if (command === "plan") {
      fs.mkdirSync(contextDir, { recursive: true });
      const planJsonPath = path.join(contextDir, "plan.json");
      fs.writeFileSync(planJsonPath, `${JSON.stringify(plan, null, 2)}\n`);
      process.stdout.write(`${formatPlan(plan)}\n`);
      process.stdout.write(`plan.json: ${planJsonPath}\n`);
      return 0;
    }
    if (command === "validate-state") {
      const probes = probesFromEnvAndState(plan.expected_state.config);
      const report = validateExpectedState({
        stateId: plan.expected_state.id,
        state: plan.expected_state.config,
        probes,
        suites: plan.suites,
      });
      fs.mkdirSync(contextDir, { recursive: true });
      const reportPath = path.join(contextDir, "expected-state-report.json");
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`${formatReport(report)}\n`);
      process.stdout.write(`expected-state-report: ${reportPath}\n`);
      return report.ok ? 0 : 3;
    }
    process.stderr.write(
      `resolver: unknown command '${command}' (expected: plan|validate-state <scenario-id>)\n`,
    );
    return 2;
  } catch (err) {
    process.stderr.write(`resolver: ${(err as Error).message}\n`);
    return 1;
  }
}

function flattenState(
  obj: unknown,
  prefix: string,
  out: Record<string, ProbeValue>,
): void {
  if (obj === null || typeof obj !== "object") {
    out[prefix] = obj as ProbeValue;
    return;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flattenState(v, next, out);
    } else {
      out[next] = v as ProbeValue;
    }
  }
}

/**
 * Build a probe results map.
 *
 * In dry-run mode we do not probe real services; instead we default every
 * expected-state leaf to its declared value so the validator passes, and
 * then allow targeted overrides via E2E_PROBE_OVERRIDE_<KEY>=value. This
 * lets tests simulate specific failure modes without spinning up a real
 * gateway or sandbox.
 */
function probesFromEnvAndState(state: unknown): ProbeResults {
  const probes: ProbeResults = {};
  flattenState(state, "", probes);
  const prefix = "E2E_PROBE_OVERRIDE_";
  for (const [envKey, value] of Object.entries(process.env)) {
    if (!envKey.startsWith(prefix) || value === undefined) continue;
    const key = envKey
      .slice(prefix.length)
      .toLowerCase()
      .replace(/_/g, ".");
    probes[key] = coerceProbeValue(value);
  }
  return probes;
}

function coerceProbeValue(v: string): ProbeValue {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

process.exit(main());
