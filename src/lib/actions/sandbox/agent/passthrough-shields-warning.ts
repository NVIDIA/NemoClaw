// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { shellQuote } from "../../../core/shell-quote";
import {
  readRecentShieldsAutoRestore,
  type ShieldsAutoRestoreEvent,
  type ShieldsAutoRestoreReadResult,
} from "../../../shields/audit";

// Source-of-truth boundary for the host CLI relock diagnostic:
//
// - Invalid state: after shields auto-relock, OpenClaw can report only
//   `missing scope: operator.write`; an older relock warning also becomes stale
//   after the user lowers shields again.
// - Source boundary: OpenShell/OpenClaw own current scope state. NemoClaw audit
//   JSONL is non-authoritative context. Validated chronology may suppress stale
//   context but never establishes current policy state, and unreadable history
//   never blocks dispatch. The audit writers are the shields timer and inline
//   expired-timer recovery paths.
// - Presentation boundary: sandbox names are user-controlled command text and
//   must remain shell-quoted. Direct stderr output is deliberate so the warning
//   is visible in a one-shot CLI while machine-readable stdout stays clean.
// - Source-fix constraint: this helper covers only host `nemoclaw <name> agent`
//   dispatches. Connect-managed OpenClaw sessions use a separate bounded audit
//   watcher. Sessions entered outside NemoClaw still need an upstream structured
//   relock error or a separate extend-on-activity design.
// - Regression tests cover validated/fallback timeouts, shell metacharacters
//   and embedded quotes, real-file JSON stdout separation, unreadable/absent
//   history, newer-down suppression, and terminal-runtime exclusion.
// - Removal condition: drop this diagnostic when OpenClaw exposes the relock
//   cause directly or NemoClaw prevents mid-session relock by extending on
//   activity.

// A relock remains useful context briefly after it happens. This is a
// relevance window measured from the restore event, independent of the
// original shields-down timeout; a longer window risks stale-session warnings.
const SHIELDS_RELOCK_WARNING_WINDOW_MS = 10 * 60 * 1000;

type ShieldsWarningProcess = {
  stderr: { write(value: string): unknown };
};

type RecentShieldsAutoRestoreReader = (sandboxName: string) => ShieldsAutoRestoreReadResult;

export function normalizeShieldsRelockTimeoutSeconds(timeoutSeconds: number | null): number | null {
  return timeoutSeconds !== null &&
    Number.isInteger(timeoutSeconds) &&
    timeoutSeconds >= 1 &&
    timeoutSeconds <= 1800
    ? timeoutSeconds
    : null;
}

export function formatShieldsDownRecoveryCommand(
  sandboxName: string,
  timeoutSeconds: number | null,
): string {
  const safeTimeout = normalizeShieldsRelockTimeoutSeconds(timeoutSeconds);
  return `${CLI_NAME} ${shellQuote(sandboxName)} shields down --timeout ${String(safeTimeout ?? 60)}s`;
}

function emitShieldsRelockWarning(
  proc: ShieldsWarningProcess,
  relock: ShieldsAutoRestoreEvent,
  sandboxName: string,
): void {
  // Defend the user-facing command suggestion even when tests or future
  // callers inject an event without going through the audit reader.
  const timeoutSeconds = normalizeShieldsRelockTimeoutSeconds(relock.timeoutSeconds);
  const afterPart = timeoutSeconds !== null ? ` after ${String(timeoutSeconds)}s` : "";
  proc.stderr.write(
    `  ⚠ Shields auto-relocked${afterPart} — run \`${formatShieldsDownRecoveryCommand(sandboxName, timeoutSeconds)}\` to extend.\n`,
  );
}

function emitShieldsAuditUnreadableWarning(proc: ShieldsWarningProcess, sandboxName: string): void {
  proc.stderr.write(
    `  ⚠ Could not read shields audit history; continuing without relock context. Run \`${CLI_NAME} ${shellQuote(sandboxName)} shields status\` to verify current state.\n`,
  );
}

export function maybeEmitShieldsRelockWarning(
  proc: ShieldsWarningProcess,
  sandboxName: string,
  getRecentShieldsAutoRestore: RecentShieldsAutoRestoreReader = (name) =>
    readRecentShieldsAutoRestore(name, SHIELDS_RELOCK_WARNING_WINDOW_MS),
): void {
  const relock = getRecentShieldsAutoRestore(sandboxName);
  if (relock.kind === "event") {
    emitShieldsRelockWarning(proc, relock.event, sandboxName);
  } else if (relock.kind === "unreadable") {
    emitShieldsAuditUnreadableWarning(proc, sandboxName);
  }
}
