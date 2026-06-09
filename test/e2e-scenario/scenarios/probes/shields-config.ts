// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProbeContext, ProbeFn, ProbeOutcome } from "./types.ts";
import { runHostCmd, runSandboxCmd, writeProbeEvidence } from "./util.ts";

/**
 * Probe: security.shields.config (`shieldsConfigProbe`).
 *
 * Mirrors test/e2e-scenario/validation_suites/lib/security_policy_credentials.sh
 * `spc_assert_shields_config_consistent`, which itself ports the
 * legacy test/e2e/test-shields-config.sh contract:
 *
 *   1. Ask the host CLI: `nemoclaw <sandbox> shields status` and
 *      classify the reported state as up | down | not-configured.
 *   2. If the scenario declares an expected state via
 *      `E2E_SHIELDS_EXPECTED_STATE` (or the legacy
 *      `E2E_SHIELDS_EXPECTED`), assert observed === expected.
 *   3. Verify the in-sandbox config file permissions match the
 *      observed state:
 *        - up                  -> root:root + restrictive 4xx mode
 *                                 (read-only for owner+group, no write
 *                                  for sandbox user)
 *        - down|not-configured -> sandbox:sandbox (writable by the
 *                                  sandbox user, since shields are
 *                                  not locking the file)
 *
 * Config path depends on the agent the scenario onboarded:
 *   - openclaw -> /sandbox/.openclaw/openclaw.json
 *   - hermes   -> /sandbox/.hermes/.env
 *
 * Evidence: a JSON document at ProbeContext.evidencePath summarizing
 * status output, observed state, expected state (if declared), and
 * config-permission stat output.
 */

const SHIELDS_STATUS_TIMEOUT_MS = 30_000;
const SANDBOX_STAT_PER_CALL_SECONDS = 25;

type ShieldsState = "up" | "down" | "not-configured";

interface ShieldsEvidence {
  observed: ShieldsState | null;
  expected: ShieldsState | null;
  statusExitCode: number | null;
  statusStdoutTail: string;
  configPath: string | null;
  permissionsLine: string | null;
  mode: string | null;
  owner: string | null;
}

function classifyStatus(stdout: string): ShieldsState | null {
  if (stdout.includes("Shields: UP")) return "up";
  if (stdout.includes("Shields: DOWN")) return "down";
  if (stdout.includes("Shields: NOT CONFIGURED")) return "not-configured";
  return null;
}

function configPathFor(agent: string | undefined): string | null {
  switch (agent) {
    case "openclaw":
    case undefined:
    case "":
      return "/sandbox/.openclaw/openclaw.json";
    case "hermes":
      return "/sandbox/.hermes/.env";
    default:
      return null;
  }
}

function permissionsOk(observed: ShieldsState, mode: string, owner: string): boolean {
  if (observed === "up") {
    // Locked: owner must be root, mode must be 4xx (no group/world
    // writes; legacy lib accepts 4[0-4][0-4]).
    return /^4[0-4][0-4]$/.test(mode) && owner === "root:root";
  }
  // down | not-configured: sandbox user owns the file so they can
  // edit when shields are dropped.
  return owner === "sandbox:sandbox";
}

function expectedStateFromContext(env: Readonly<Record<string, string>>): ShieldsState | null {
  const raw = (env.E2E_SHIELDS_EXPECTED_STATE || env.E2E_SHIELDS_EXPECTED || "").trim();
  if (!raw) return null;
  const norm = raw.replace(/_/g, "-").toLowerCase();
  if (norm === "up" || norm === "down" || norm === "not-configured") return norm;
  return null;
}

export const shieldsConfigProbe: ProbeFn = async (ctx: ProbeContext): Promise<ProbeOutcome> => {
  if (!ctx.sandboxName) {
    return {
      status: "failed",
      message: "shieldsConfigProbe: E2E_SANDBOX_NAME missing in context.env",
    };
  }

  const evidence: ShieldsEvidence = {
    observed: null,
    expected: expectedStateFromContext(ctx.contextEnv),
    statusExitCode: null,
    statusStdoutTail: "",
    configPath: null,
    permissionsLine: null,
    mode: null,
    owner: null,
  };

  // --- Step 1: nemoclaw <sandbox> shields status ---
  const statusResult = await runHostCmd("nemoclaw", [ctx.sandboxName, "shields", "status"], {
    timeoutMs: SHIELDS_STATUS_TIMEOUT_MS,
  });
  evidence.statusExitCode = statusResult.exitCode;
  evidence.statusStdoutTail = statusResult.stdout;
  if (statusResult.signal === "SIGTERM") {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      classifier: "runner-infra",
      message: `shieldsConfigProbe: 'nemoclaw shields status' timed out after ${SHIELDS_STATUS_TIMEOUT_MS}ms`,
    };
  }
  if (statusResult.exitCode !== 0) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      message: `shieldsConfigProbe: 'nemoclaw shields status' exited ${statusResult.exitCode}; stderr: ${statusResult.stderr.slice(-300)}`,
    };
  }
  const observed = classifyStatus(statusResult.stdout);
  evidence.observed = observed;
  if (!observed) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      message: `shieldsConfigProbe: status output did not report a recognized Shields state; tail: ${statusResult.stdout.slice(-200)}`,
    };
  }
  if (evidence.expected && evidence.expected !== observed) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      message: `shieldsConfigProbe: expected shields '${evidence.expected}', observed '${observed}'`,
    };
  }

  // --- Step 2: in-sandbox stat of the config file ---
  const configPath = configPathFor(ctx.contextEnv.E2E_AGENT);
  if (!configPath) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      message: `shieldsConfigProbe: unsupported E2E_AGENT '${ctx.contextEnv.E2E_AGENT}'`,
    };
  }
  evidence.configPath = configPath;
  const statResult = await runSandboxCmd(ctx, ["stat", "-c", "%a %U:%G", configPath], {
    perCallSeconds: SANDBOX_STAT_PER_CALL_SECONDS,
  });
  if (statResult.exitCode !== 0) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      classifier: statResult.signal === "SIGTERM" ? "gateway-transient" : undefined,
      message: `shieldsConfigProbe: stat of ${configPath} failed (exit ${statResult.exitCode}); stderr: ${statResult.stderr.slice(-300)}`,
    };
  }
  const permsLine = statResult.stdout.trim();
  evidence.permissionsLine = permsLine;
  const [mode, owner] = permsLine.split(/\s+/, 2);
  evidence.mode = mode ?? null;
  evidence.owner = owner ?? null;
  if (!mode || !owner) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      message: `shieldsConfigProbe: could not parse stat output: '${permsLine}'`,
    };
  }
  if (!permissionsOk(observed, mode, owner)) {
    writeProbeEvidence(ctx, evidence);
    return {
      status: "failed",
      message: `shieldsConfigProbe: shields are '${observed}' but ${configPath} permissions are '${permsLine}'`,
    };
  }

  writeProbeEvidence(ctx, evidence);
  return {
    status: "passed",
    message: `shieldsConfigProbe: shields=${observed} ${configPath}=${permsLine}`,
  };
};
