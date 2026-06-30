// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { shellQuote } from "../../../core/shell-quote";
import {
  readRecentShieldsAutoRestore,
  type ShieldsAutoRestoreEvent,
  type ShieldsAutoRestoreReadResult,
} from "../../../shields/audit";

// A relock remains useful context briefly after it happens. This is a
// relevance window measured from the restore event, independent of the
// original shields-down timeout; a longer window risks stale-session warnings.
const SHIELDS_RELOCK_WARNING_WINDOW_MS = 10 * 60 * 1000;

type ShieldsWarningProcess = {
  stderr: { write(value: string): unknown };
};

type RecentShieldsAutoRestoreReader = (sandboxName: string) => ShieldsAutoRestoreReadResult;

function emitShieldsRelockWarning(
  proc: ShieldsWarningProcess,
  relock: ShieldsAutoRestoreEvent,
  sandboxName: string,
): void {
  // Defend the user-facing command suggestion even when tests or future
  // callers inject an event without going through the audit reader.
  const timeoutSeconds =
    relock.timeoutSeconds !== null &&
    Number.isInteger(relock.timeoutSeconds) &&
    relock.timeoutSeconds >= 1 &&
    relock.timeoutSeconds <= 1800
      ? relock.timeoutSeconds
      : null;
  const afterPart = timeoutSeconds !== null ? ` after ${String(timeoutSeconds)}s` : "";
  const timeoutSuggestion =
    timeoutSeconds !== null ? `--timeout ${String(timeoutSeconds)}s` : "--timeout 60s";
  proc.stderr.write(
    `  ⚠ Shields auto-relocked${afterPart} — run \`${CLI_NAME} ${shellQuote(sandboxName)} shields down ${timeoutSuggestion}\` to extend.\n`,
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
