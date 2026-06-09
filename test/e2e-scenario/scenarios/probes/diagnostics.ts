// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { superviseChild } from "../../framework/shell/supervisor.ts";
import { validateShellToken } from "../../framework/shell/trusted-command.ts";
import type { ProbeContext, ProbeFn, ProbeOutcome } from "./types.ts";

/**
 * Probe: diagnostics.bundle (`diagnosticsProbe`).
 *
 * Mirrors test/e2e/test-diagnostics.sh's TC-DIAG-02 case:
 *
 *   1. Run `nemoclaw debug --quick --output <tmp>/quick-debug.tar.gz`
 *      with a 30s budget.
 *   2. Assert exit 0.
 *   3. Assert the archive exists and is non-empty.
 *
 * The legacy test also asserts the archive contains no plaintext
 * credentials (TC-DIAG-01), but that lives in a separate probe
 * (a future `diagnosticsBundleSecretsProbe`) so this one stays
 * narrowly focused on bundle production.
 *
 * Lifecycle (detached process group, timeout, SIGTERM -> SIGKILL
 * escalation) and NUL-byte argv validation are delegated to the shared
 * framework modules under `framework/shell/`.
 *
 * Evidence: a JSON document at ProbeContext.evidencePath summarizing
 * exit code, archive size, and elapsed seconds.
 */
const DIAGNOSTICS_TIMEOUT_MS = 30_000;

interface DiagnosticsEvidence {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  elapsedMs: number;
  archivePath: string;
  archiveSize: number | null;
  stderrTail: string;
}

function writeEvidence(evidencePath: string, payload: DiagnosticsEvidence): void {
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(payload, null, 2));
  } catch {
    /* evidence write is best-effort; never fail the probe on IO. */
  }
}

export const diagnosticsProbe: ProbeFn = async (ctx: ProbeContext): Promise<ProbeOutcome> => {
  // Pre-flight: nemoclaw must be on PATH; the legacy test treats this
  // as a hard prerequisite, not a skip.
  // (We rely on the spawned process surfacing ENOENT if it isn't.)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-diag-probe-"));
  const archivePath = path.join(tmp, "quick-debug.tar.gz");
  const safeArgs = [
    validateShellToken("debug", "diagnosticsProbe argv[0]"),
    validateShellToken("--quick", "diagnosticsProbe argv[1]"),
    validateShellToken("--output", "diagnosticsProbe argv[2]"),
    validateShellToken(archivePath, "diagnosticsProbe archivePath"),
  ];
  const startedAt = Date.now();
  let stderrTail = "";

  const child = spawn("nemoclaw", safeArgs, {
    // Use the parent env directly: probes run inside the framework
    // process and don't need the redacted secret env that shell
    // steps build at the spawn boundary. PATH/HOME/E2E_* are
    // already in process.env.
    env: process.env,
    cwd: ctx.repoRoot,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const supervised = await superviseChild(child, {
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
    onStderr: (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-1024);
    },
  });
  const exitCode = supervised.exitCode;
  const signal = supervised.signal;
  const spawnErrorMessage = supervised.spawnError?.message ?? null;
  if (spawnErrorMessage) {
    // ENOENT or similar — nemoclaw is not on PATH. Surface verbatim
    // so the operator can see it's an environment problem, not a real
    // diagnostics failure.
    stderrTail = (stderrTail + `spawn error: ${spawnErrorMessage}`).slice(-1024);
  }
  const elapsedMs = Date.now() - startedAt;

  let archiveSize: number | null = null;
  try {
    const stat = fs.statSync(archivePath);
    archiveSize = stat.size;
  } catch {
    archiveSize = null;
  }

  const evidence: DiagnosticsEvidence = {
    exitCode,
    signal,
    timedOut: supervised.timedOut,
    spawnError: spawnErrorMessage,
    elapsedMs,
    archivePath,
    archiveSize,
    stderrTail,
  };
  writeEvidence(ctx.evidencePath, evidence);

  // Best-effort cleanup of the tmp dir; keep the JSON evidence on
  // disk regardless.
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* tmp cleanup is non-fatal */
  }

  if (supervised.timedOut) {
    return {
      status: "failed",
      classifier: "runner-infra",
      message: `diagnosticsProbe: nemoclaw debug --quick exceeded ${DIAGNOSTICS_TIMEOUT_MS / 1000}s`,
    };
  }
  if (spawnErrorMessage) {
    // The host CLI was not available. Classify as runner-infra so
    // the orchestrator's retry policy can react to it as an
    // environment problem rather than a deterministic probe failure.
    return {
      status: "failed",
      classifier: "runner-infra",
      message: `diagnosticsProbe: failed to spawn nemoclaw: ${spawnErrorMessage}`,
    };
  }
  if (exitCode !== 0) {
    return {
      status: "failed",
      message: `diagnosticsProbe: nemoclaw debug --quick exited ${exitCode}; stderr: ${stderrTail.slice(-300)}`,
    };
  }
  if (archiveSize === null) {
    return {
      status: "failed",
      message: `diagnosticsProbe: archive missing at ${archivePath}`,
    };
  }
  if (archiveSize === 0) {
    return {
      status: "failed",
      message: `diagnosticsProbe: archive at ${archivePath} is empty`,
    };
  }

  return {
    status: "passed",
    message: `diagnosticsProbe: bundle ok (${archiveSize} bytes, ${elapsedMs}ms)`,
  };
};
