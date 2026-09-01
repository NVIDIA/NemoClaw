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
      `  Ollama warm-up for '${model}' at ${result.endpoint} ${describeWarmFailure(result.reason)} ` +
        `(${result.detail}). OpenClaw dispatch will continue. To retry the warm-up, restore ` +
        `Ollama access to ${result.endpoint} and confirm that it serves '${model}', then rerun ` +
        `this command.\n`,
    );
    return;
  }

  if (result.reason === "model-absent") {
    proc.stderr.write(
      `  Ollama at ${result.endpoint} reports '${model}' as unavailable ` +
        `(reported models: ${result.inventoryLabel}); continuing to OpenClaw dispatch.\n`,
    );
    proc.stderr.write(
      `  Either the daemon answering that endpoint changed, or the model was removed from ` +
        `it. Restart the daemon that holds '${model}', or rerun \`nemoclaw onboard\` and ` +
        `select a model that the endpoint reports.\n`,
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
        "  Ollama was unreachable during the model check; continuing to OpenClaw dispatch.\n",
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
  proc.stderr.write("  Checking whether the Ollama model is loaded...\n");
  try {
    reportRecovery(route, recoverOllama(route), proc);
  } catch {
    proc.stderr.write(
      "  Ollama restart recovery failed unexpectedly; continuing to OpenClaw dispatch.\n",
    );
  }
}
