// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  maybeWarmOllamaAfterDaemonRestart,
  OLLAMA_LOCAL_PROVIDER,
  type OllamaRestartRecoveryFailureReason,
  type OllamaRestartRecoveryResult,
  type OllamaRestartRecoveryRoute,
} from "./ollama-restart-recovery";

export { OLLAMA_LOCAL_PROVIDER };

export type OllamaRestartRecoveryFn = (
  route: OllamaRestartRecoveryRoute,
) => OllamaRestartRecoveryResult;

export interface OllamaRestartRecoveryProcess {
  stderr: { write(s: string): unknown };
}

function describeWarmFailure(reason: OllamaRestartRecoveryFailureReason): string {
  switch (reason) {
    case "timeout":
      return "timed out";
    case "command-failed":
      return "curl exited unsuccessfully";
    case "ollama-error":
      return "Ollama returned an error";
    case "invalid-response":
      return "Ollama returned an invalid response";
    case "spawn-failed":
      return "the warm-up process could not start";
  }
}

function reportRecovery(
  route: OllamaRestartRecoveryRoute,
  result: OllamaRestartRecoveryResult,
  proc: OllamaRestartRecoveryProcess,
): void {
  const model = String(route.model ?? "").trim() || "the registered model";
  if (result.kind === "warmed") {
    if (result.ok) {
      proc.stderr.write(`  Ollama model '${model}' is loaded and ready.\n`);
      return;
    }
    proc.stderr.write(
      `  Ollama warm-up for '${model}' ${describeWarmFailure(result.reason)}; continuing to OpenClaw dispatch.\n`,
    );
    return;
  }

  const reason = result.reason;
  switch (reason) {
    case "already-loaded":
      proc.stderr.write(`  Ollama model '${model}' is already loaded.\n`);
      break;
    case "unreachable":
      proc.stderr.write(
        "  Ollama was unreachable during the restart check; continuing to OpenClaw dispatch.\n",
      );
      break;
    case "missing-model":
      proc.stderr.write(
        "  No Ollama model is recorded for this sandbox; continuing to OpenClaw dispatch.\n",
      );
      break;
    case "not-ollama":
      break;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** Run best-effort Ollama recovery without blocking the canonical agent error path. */
export function runOllamaRestartRecovery(
  route: OllamaRestartRecoveryRoute,
  proc: OllamaRestartRecoveryProcess,
  recoverOllama: OllamaRestartRecoveryFn = maybeWarmOllamaAfterDaemonRestart,
): void {
  proc.stderr.write("  Checking Ollama model readiness after daemon restart...\n");
  try {
    reportRecovery(route, recoverOllama(route), proc);
  } catch {
    proc.stderr.write(
      "  Ollama restart recovery failed unexpectedly; continuing to OpenClaw dispatch.\n",
    );
  }
}
