// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProbeContext, ProbeFn, ProbeOutcome } from "./types.ts";

/**
 * Probe: docs.validation (`docsValidationProbe`).
 *
 * Mirrors test/e2e/test-docs-validation.sh:
 *
 *   1. Run `test/e2e/e2e-cloud-experimental/check-docs.sh --only-cli`
 *      to verify `nemoclaw --help` matches docs/reference/commands.mdx
 *      (CLI / docs parity).
 *   2. Run `... --only-links --local-only` to verify markdown internal
 *      links resolve. Remote http(s) probes are skipped by default
 *      because they are slow and flaky under CI rate limiting (the
 *      legacy script documents this caveat).
 *
 * Both checks exit 0 on success. The probe captures both exit codes
 * and surfaces a single combined outcome, with a structured evidence
 * JSON for diagnosis.
 */

const CHECK_DOCS_REL = "test/e2e/e2e-cloud-experimental/check-docs.sh";
const CLI_PARITY_TIMEOUT_MS = 60_000;
const LINK_CHECK_TIMEOUT_MS = 90_000;

interface DocsCheckResult {
  phase: "cli-parity" | "links-local";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  stderrTail: string;
  stdoutTail: string;
}

interface DocsEvidence {
  results: DocsCheckResult[];
}

function runCheck(
  scriptPath: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  phase: DocsCheckResult["phase"],
): Promise<DocsCheckResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdoutTail = "";
    let stderrTail = "";
    const child = spawn("bash", [scriptPath, ...args], {
      env: { ...process.env, CHECK_DOC_LINKS_REMOTE: "0" },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onTimeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutTail = (stdoutTail + chunk.toString("utf8")).slice(-1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1024);
    });
    child.on("error", (err) => {
      clearTimeout(onTimeout);
      resolve({
        phase,
        exitCode: 127,
        signal: null,
        elapsedMs: Date.now() - startedAt,
        stderrTail: `spawn error: ${err.message}`,
        stdoutTail,
      });
    });
    child.on("close", (code, sig) => {
      clearTimeout(onTimeout);
      resolve({
        phase,
        exitCode: code,
        signal: sig,
        elapsedMs: Date.now() - startedAt,
        stderrTail,
        stdoutTail,
      });
    });
  });
}

function writeEvidence(evidencePath: string, payload: DocsEvidence): void {
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, JSON.stringify(payload, null, 2));
  } catch {
    /* evidence write is best-effort */
  }
}

export const docsValidationProbe: ProbeFn = async (ctx: ProbeContext): Promise<ProbeOutcome> => {
  const scriptPath = path.resolve(ctx.repoRoot, CHECK_DOCS_REL);
  if (!fs.existsSync(scriptPath)) {
    return {
      status: "failed",
      message: `docsValidationProbe: check-docs.sh not found at ${scriptPath}`,
    };
  }

  const cliResult = await runCheck(
    scriptPath,
    ["--only-cli"],
    ctx.repoRoot,
    CLI_PARITY_TIMEOUT_MS,
    "cli-parity",
  );
  const linksResult = await runCheck(
    scriptPath,
    ["--only-links", "--local-only"],
    ctx.repoRoot,
    LINK_CHECK_TIMEOUT_MS,
    "links-local",
  );

  writeEvidence(ctx.evidencePath, { results: [cliResult, linksResult] });

  // Surface SIGTERM (timeout) as runner-infra so the orchestrator may
  // retry on a transient slowness. Hard exit-code failures do not
  // retry — a docs/CLI drift is deterministic.
  if (cliResult.signal === "SIGTERM" || linksResult.signal === "SIGTERM") {
    const which = cliResult.signal === "SIGTERM" ? "cli-parity" : "links-local";
    return {
      status: "failed",
      classifier: "runner-infra",
      message: `docsValidationProbe: ${which} check timed out`,
    };
  }
  if (cliResult.exitCode !== 0) {
    return {
      status: "failed",
      message: `docsValidationProbe: CLI/docs parity failed (exit ${cliResult.exitCode}); stderr: ${cliResult.stderrTail.slice(-300)}`,
    };
  }
  if (linksResult.exitCode !== 0) {
    return {
      status: "failed",
      message: `docsValidationProbe: markdown link check failed (exit ${linksResult.exitCode}); stderr: ${linksResult.stderrTail.slice(-300)}`,
    };
  }
  return {
    status: "passed",
    message: `docsValidationProbe: ok (cli ${cliResult.elapsedMs}ms, links ${linksResult.elapsedMs}ms)`,
  };
};
