// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI entrypoint for the E2E scenario resolver.
 *
 * Usage:
 *   tsx test/e2e/runtime/resolver/index.ts plan <scenario-id> [--context-dir <path>]
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
  probesFromState: boolean;
} {
  const args = argv.slice(2);
  const command = args.shift() ?? "";
  let scenarioId: string | undefined;
  let contextDir = process.env.E2E_CONTEXT_DIR ?? ".e2e";
  let probesFromState = false;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // resolver/ lives under test/e2e/runtime/, so the E2E metadata root
  // (which loadMetadataFromDir resolves further into nemoclaw_scenarios/
  // and validation_suites/) is two levels up.
  let metadataDir = path.resolve(scriptDir, "..", "..");
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
    } else if (a === "--probes-from-state") {
      // Dry-run affordance: seed probes from the expected state itself so
      // the validator can exercise its logic without real probe values.
      // Non-dry-run callers MUST NOT pass this flag (CodeRabbit review
      // item #9); the resolver will fail closed when required probe keys
      // are missing without this flag.
      probesFromState = true;
    } else if (a && !a.startsWith("--") && !scenarioId) {
      scenarioId = a;
    } else if (a === "--help" || a === "-h") {
      // ignore; help handled by caller
    } else if (a) {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return { command, scenarioId, contextDir, metadataDir, probesFromState };
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
      // CodeRabbit review item #9: only self-seed probes when the caller
      // explicitly opts in (dry-run / test contexts). Non-dry-run callers
      // without real probes wired should fail, not quietly self-validate.
      const probes = parsed.probesFromState
        ? probesFromEnvAndState(plan.expected_state.config)
        : probesFromEnvOnly();
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
 * Read probe overrides from the environment without seeding from state.
 *
 * Used in non-dry-run mode: the validator then reports a concrete failure
 * for any expected-state key that has no corresponding probe value.
 */
function probesFromEnvOnly(): ProbeResults {
  const probes: ProbeResults = {};
  // 1. Prefix-based overrides: E2E_PROBE_OVERRIDE_<KEY>=<value> where <KEY>
  //    maps underscores to dots (e.g. GATEWAY_HEALTH -> gateway.health).
  //    This works for simple keys but cannot express underscores inside a
  //    single segment.
  const prefix = "E2E_PROBE_OVERRIDE_";
  for (const [envKey, value] of Object.entries(process.env)) {
    if (!envKey.startsWith(prefix) || value === undefined) continue;
    const key = envKey.slice(prefix.length).toLowerCase().replace(/_/g, ".");
    probes[key] = coerceProbeValue(value);
  }
  // 2. JSON escape hatch for keys with embedded underscores (e.g.
  //    `security.policy_engine`). Later overrides win over (1).
  const overridesJson = process.env.E2E_PROBE_OVERRIDES_JSON;
  if (overridesJson) {
    try {
      const parsed = JSON.parse(overridesJson);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          probes[k] = typeof v === "string" ? coerceProbeValue(v) : (v as ProbeValue);
        }
      }
    } catch (err) {
      process.stderr.write(
        `resolver: E2E_PROBE_OVERRIDES_JSON parse error: ${(err as Error).message}\n`,
      );
    }
  }
  return probes;
}

/**
 * Build a probe results map.
 *
 * In dry-run / test mode we do not probe real services; instead we default
 * every expected-state leaf to its declared value so the validator passes,
 * and then allow targeted overrides via E2E_PROBE_OVERRIDE_<KEY>=value.
 * This lets tests simulate specific failure modes without spinning up a
 * real gateway or sandbox.
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
