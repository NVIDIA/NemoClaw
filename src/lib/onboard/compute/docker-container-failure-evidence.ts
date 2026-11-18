// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createDockerGpuDiagnosticRedactor,
  type DockerGpuDiagnosticRedactor,
} from "../docker-gpu-diagnostic-redaction";
import type {
  DockerContainerInspect,
  DockerContainerState,
  DockerGpuPatchDeps,
} from "../docker-gpu-patch-types";

const FAILURE_EVIDENCE_CALL_TIMEOUT_MS = 2_000;
const FAILURE_EVIDENCE_LOG_LINES = 120;
const FAILURE_EVIDENCE_LOG_CHARS = 1_200;
const MISSING_MANAGED_STARTUP_COMMAND_LOG =
  /(?:^|\n)(?:\/usr\/bin\/)?env: (?:[\u0027\u2018]?nemoclaw-start[\u0027\u2019]?|can't execute 'nemoclaw-start'): No such file or directory(?:\r?\n|$)/u;

type DockerContainerFailureEvidenceDeps = Required<
  Pick<DockerGpuPatchDeps, "dockerCapture" | "dockerLogs">
>;

export type DockerContainerFailureEvidence = {
  readonly state: DockerContainerState | null;
  readonly redactedLogTail: string;
  /** True only when inspect data taught the redactor the container's opaque environment values. */
  readonly inspectRedactionApplied: boolean;
  readonly managedStartupCommandMissing: boolean;
};

function parseStateEvidence(value: string): {
  inspect: DockerContainerInspect | null;
  state: DockerContainerState | null;
} {
  const parsed = JSON.parse(value) as unknown;
  if (Array.isArray(parsed) && parsed.length === 1) {
    const inspect = parsed[0] as DockerContainerInspect;
    return { inspect, state: inspect.State ?? null };
  }
  if (parsed && typeof parsed === "object") {
    return { inspect: null, state: parsed as DockerContainerState };
  }
  return { inspect: null, state: null };
}

export function formatDockerContainerState(
  state: DockerContainerState | null,
  keyPrefix = "",
): string[] {
  if (!state) return [];
  const lines: string[] = [];
  if (state.Status) lines.push(`${keyPrefix}status=${state.Status}`);
  if (typeof state.Running === "boolean") {
    lines.push(`${keyPrefix}running=${String(state.Running)}`);
  }
  if (typeof state.ExitCode === "number") lines.push(`${keyPrefix}exit_code=${state.ExitCode}`);
  if (state.OOMKilled) lines.push(`${keyPrefix}oom_killed=true`);
  if (state.Error) lines.push(`${keyPrefix}error=${state.Error}`);
  if (state.Health?.Status) lines.push(`${keyPrefix}health=${state.Health.Status}`);
  if (state.FinishedAt && state.FinishedAt !== "0001-01-01T00:00:00Z") {
    lines.push(`${keyPrefix}finished_at=${state.FinishedAt}`);
  }
  return lines;
}

/**
 * SOURCE_OF_TRUTH_REVIEW
 * invalidState: Docker created a replacement that failed before managed control accepted it;
 *   rollback would erase the replacement's transient state and log evidence.
 * sourceBoundary: this shared collector is the sole Docker inspect/log redaction boundary used
 *   immediately before GPU rollback.
 * whyNotSourceFix: evidence capture cannot repair the external supervisor and must remain best
 *   effort, bounded to 2-second calls, 120 log lines, and a 1,200-character redacted tail so it
 *   can never obstruct rollback.
 * regressionTest: docker-gpu-patch diagnostics tests prove post-wait state and redaction;
 *   docker-gpu-pre-rollback-diagnostics.test.ts proves bounded capture before rollback.
 * removalCondition: remove only when every replacement path emits equivalent bounded, redacted
 *   evidence before rollback, or no longer replaces a Docker container.
 */
export function captureDockerContainerFailureEvidence(
  containerId: string,
  deps: DockerContainerFailureEvidenceDeps,
  options: {
    enrichInspect?: boolean;
    redactor?: DockerGpuDiagnosticRedactor;
    /** Identity-bound inventory captured before any sibling logs are read. */
    inspect?: DockerContainerInspect;
    /** Shared deadline; later Docker calls get only the remaining time and are skipped after it. */
    deadlineMs?: number;
    now?: () => number;
  } = {},
): DockerContainerFailureEvidence {
  const { dockerCapture: capture, dockerLogs: logs } = deps;
  const now = options.now ?? Date.now;
  const callTimeout = (): number | null => {
    if (options.deadlineMs === undefined) return FAILURE_EVIDENCE_CALL_TIMEOUT_MS;
    const remaining = Math.floor(options.deadlineMs - now());
    return remaining > 0 ? Math.min(FAILURE_EVIDENCE_CALL_TIMEOUT_MS, remaining) : null;
  };
  const redactor = options.redactor ?? createDockerGpuDiagnosticRedactor();
  let inspect: DockerContainerInspect | null = options.inspect ?? null;
  let state: DockerContainerState | null = inspect?.State ?? null;
  const stateTimeout = inspect ? null : callTimeout();
  try {
    if (stateTimeout !== null) {
      const output = capture(["inspect", "--format", "{{json .State}}", containerId], {
        ignoreError: true,
        timeout: stateTimeout,
      });
      ({ inspect, state } = parseStateEvidence(output));
    }
  } catch {
    // Failure evidence is best effort and must never obstruct rollback.
  }
  const inspectTimeout = !inspect && options.enrichInspect !== false ? callTimeout() : null;
  if (inspectTimeout !== null) {
    try {
      const output = capture(["inspect", containerId], {
        ignoreError: true,
        timeout: inspectTimeout,
      });
      const parsed = JSON.parse(output) as unknown;
      inspect = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
    } catch {
      // State evidence remains useful when inspect enrichment is unavailable.
    }
  }
  if (inspect) redactor.rememberInspect(inspect);
  let logTail = "";
  const logsTimeout = callTimeout();
  try {
    if (logsTimeout !== null) {
      logTail = logs(containerId, {
        tail: FAILURE_EVIDENCE_LOG_LINES,
        timeout: logsTimeout,
      });
    }
  } catch {
    // The state remains useful when logs are unavailable.
  }
  return {
    state: redactor.redactValue(state) as DockerContainerState | null,
    redactedLogTail: redactor.redactText(logTail).trim().slice(-FAILURE_EVIDENCE_LOG_CHARS),
    inspectRedactionApplied: Array.isArray(inspect?.Config?.Env),
    managedStartupCommandMissing: MISSING_MANAGED_STARTUP_COMMAND_LOG.test(logTail),
  };
}
