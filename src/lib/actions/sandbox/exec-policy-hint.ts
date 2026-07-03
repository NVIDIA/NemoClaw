// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxLogsOptions } from "../../domain/sandbox/log-options";
import {
  buildEnableSandboxAuditLogsArgs,
  buildSandboxLogsArgs,
  getLogsProbeTimeoutMs,
  parseLineTimestamp,
} from "../../domain/sandbox/logs";

/**
 * Denial-adjacent guidance for the `nemoclaw <name> exec -- ...` path (#5978).
 *
 * Sandbox egress is denied-by-default and enforced by the OpenShell L7 proxy.
 * From inside the sandbox a generic client (curl, python, git, wget, …) sees a
 * policy denial only as the opaque protocol error
 * `curl: (56) CONNECT tunnel failed, response 403` — the detailed allow/deny
 * reason lives in the NemoClaw/OpenShell audit log, but nothing pointed the
 * user there on the actual failure path. The prior connect-shell startup banner
 * (scripts/nemoclaw-start.sh) only helps top-level interactive shells; the
 * reporter's QA path is non-interactive `exec`, which stayed opaque.
 *
 * This module bridges the gap at the NemoClaw-owned `exec` command boundary:
 * after the sandbox command exits non-zero, NemoClaw reads recent audit logs
 * and, only when a policy denial is recorded AFTER the command started, appends
 * a concise host-side stderr hint. The child's own stdout/stderr bytes and its
 * exit code are left untouched — the hint is emitted by the host CLI process
 * after the child has been reaped, never by wrapping or piping the tool.
 */

/** Opt-out env var, shared with the connect-shell breadcrumb stanza. */
export const POLICY_HINT_SUPPRESS_ENV = "NEMOCLAW_NO_POLICY_HINT";

/** Number of recent log lines to scan for a denial event. */
export const POLICY_HINT_TAIL_LINES = 200;

// A denied endpoint is a bare `host:port` (or `ip:port`) target from a CONNECT
// audit event — never secret material. This allowlist bounds what may be echoed
// into terminal/CI logs: DNS labels or IPv4 octets, a dot-separated host, and a
// 1–5 digit port. Anything that does not match is dropped and the hint falls
// back to a generic message rather than rendering an untrusted token.
const SAFE_ENDPOINT_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*:\d{1,5}$/;

/**
 * True when a log line records a network policy denial. Matches the OpenShell
 * OCSF audit signature (`NET:OPEN ... DENIED`) plus the proxy/JSON denial
 * phrasings, so the detector is tool- and format-agnostic.
 */
export function isPolicyDenialLine(line: string): boolean {
  if (line.includes("NET:OPEN") && line.includes("DENIED")) return true;
  if (line.includes("policy_denied")) return true;
  if (/\bnot (?:allowed|permitted)\b[^\n]*\bpolic/i.test(line)) return true;
  if (/\bnot in policy\b/i.test(line)) return true;
  return false;
}

// A leading log timestamp is stripped before the generic host:port fallback so
// the colon-bearing time component of an ISO timestamp (for example the `04:00`
// in `2026-07-03T04:00:00Z`) is never mistaken for the denied endpoint. Both
// forms produced by NemoClaw's log sources are covered: the OpenShell audit
// epoch bracket and the gateway ISO 8601 stamp (mirrors parseLineTimestamp).
const LEADING_EPOCH_TIMESTAMP_RE = /^\s*\[\d+(?:\.\d+)?\]\s*/;
const LEADING_ISO_TIMESTAMP_RE =
  /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*/;

/**
 * Extract the denied `host:port` endpoint from an audit line, preferring the
 * `-> host:port` arrow target of a NET:OPEN event and falling back to the first
 * `host:port` token after any leading timestamp. Returns null when no token
 * passes the safe allowlist so a malformed or crafted line can never inject
 * bytes into the emitted hint.
 */
export function extractDeniedEndpoint(line: string): string | null {
  const candidates: string[] = [];
  const arrow = line.match(/->\s*([^\s\]]+:\d{1,5})(?:\b|$)/);
  if (arrow) candidates.push(arrow[1]);
  const withoutTimestamp = line
    .replace(LEADING_EPOCH_TIMESTAMP_RE, "")
    .replace(LEADING_ISO_TIMESTAMP_RE, "");
  const generic = withoutTimestamp.match(/\b([a-zA-Z0-9.-]+:\d{1,5})\b/);
  if (generic) candidates.push(generic[1]);
  for (const candidate of candidates) {
    if (SAFE_ENDPOINT_RE.test(candidate)) return candidate;
  }
  return null;
}

export type PolicyDenialMatch = { endpoint: string | null };

// parseLineTimestamp floors a second-precision timestamp (an epoch or ISO stamp
// with no fractional part) to `.000`, so its true instant can be up to 999 ms
// later than the parsed value. These patterns detect that missing sub-second
// precision so the recency check can compare against the latest instant the
// line could represent.
const SECOND_PRECISION_EPOCH_RE = /^\s*\[\d+\]/;
const SECOND_PRECISION_ISO_RE =
  /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?(?!\.\d)/;

// The latest instant a line's timestamp could represent: exact for sub-second
// precision, or +999 ms when the stamp is only second-precise.
function latestPossibleTimestampMs(line: string, timestamp: number): number {
  const secondPrecise = SECOND_PRECISION_EPOCH_RE.test(line) || SECOND_PRECISION_ISO_RE.test(line);
  return secondPrecise ? timestamp + 999 : timestamp;
}

/**
 * Find the most recent policy-denial event that could have occurred at or after
 * the command started. Lines without a parseable timestamp, and denials whose
 * latest possible instant predates the command start, are ignored so a stale
 * denial from a previous command does not trigger a hint.
 *
 * There is no arbitrary backward tolerance. The sandbox shares the host's
 * kernel clock, and this command's own denial is always logged after the host
 * stamped the start time (the child must spawn, connect, and be refused first),
 * so the cutoff is exact for millisecond-precision lines: a backward skew would
 * let a denial from an immediately preceding exec masquerade as this command's.
 * The only slack is the inherent granularity of a second-precision stamp — a
 * denial logged as `HH:MM:SS` could have happened anywhere in that second, so it
 * is kept when that whole second reaches the start time, which is the smallest
 * window that cannot silently drop a genuinely fresh denial.
 */
export function findRecentPolicyDenial(
  logOutput: string,
  commandStartedAtMs: number,
): PolicyDenialMatch | null {
  const threshold = commandStartedAtMs;
  let match: PolicyDenialMatch | null = null;
  for (const line of logOutput.split(/\r?\n/)) {
    if (!isPolicyDenialLine(line)) continue;
    const timestamp = parseLineTimestamp(line);
    if (timestamp === null || latestPossibleTimestampMs(line, timestamp) < threshold) continue;
    match = { endpoint: extractDeniedEndpoint(line) };
  }
  return match;
}

/** Render the concise, denial-adjacent stderr hint. */
export function buildPolicyDenialExecHint(
  cliName: string,
  sandboxName: string,
  endpoint: string | null,
): string {
  const target = endpoint ? ` for ${endpoint}` : "";
  return [
    `${cliName}: recent network policy denial detected${target} inside sandbox '${sandboxName}'.`,
    "  The sandbox's egress policy blocked this request; the tool above only saw the proxy's 403.",
    `  See the denied flow:    ${cliName} ${sandboxName} logs --tail 50`,
    `  Review applied presets: ${cliName} ${sandboxName} policy-list`,
    `  Allow the host:         ${cliName} ${sandboxName} policy-add <preset>`,
    `  Silence this hint:      export ${POLICY_HINT_SUPPRESS_ENV}=1`,
  ].join("\n");
}

/**
 * Whether a policy-denial probe is warranted after an exec. Only failing
 * commands are probed, transport failures (openshell never ran the command) are
 * skipped, and the user opt-out short-circuits everything.
 */
export function shouldProbePolicyDenial(
  commandCode: number,
  hadInvocationError: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  if (commandCode === 0) return false;
  if (hadInvocationError) return false;
  const suppress = env[POLICY_HINT_SUPPRESS_ENV];
  if (suppress && suppress !== "0" && suppress !== "false") return false;
  return true;
}

export type PolicyDenialLogProbe = (sandboxName: string) => string;
export type PolicyDenialAuditEnabler = (sandboxName: string) => void;

// A denial that just caused the failure is written by the proxy before the tool
// even sees its 403, so it is almost always present on the first read. These
// small, bounded retries only cover the rare case where the audit event has not
// yet flushed to the queryable log the instant the child is reaped — matching
// why the live `pollDeniedReasonLog` helper polls. Audit logging is enabled once
// before the loop, and only the read is retried, so an ordinary (non-denial)
// failure adds at most a couple of quick log reads plus a few hundred ms.
export const POLICY_HINT_PROBE_ATTEMPTS = 3;
export const POLICY_HINT_PROBE_RETRY_MS = 120;

export type PolicyDenialHintDeps = {
  probeLogs?: PolicyDenialLogProbe;
  enableAudit?: PolicyDenialAuditEnabler;
  env?: NodeJS.ProcessEnv;
  writeStderr?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  retryDelayMs?: number;
};

// The timer is intentionally NOT unref'd: this sleep runs between the child's
// exit and the final process.exit, when no other handle keeps the event loop
// alive. An unref'd timer would let Node drain the loop and exit early with the
// default code 0 mid-retry, silently dropping the real command's exit code.
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Enable audit logging once before reading, mirroring what `nemoclaw <name>
// logs` does so denials surface under the same conditions the user would see
// them. Best-effort: a failure just means we read whatever is already retained,
// and it can never affect the exec's exit code.
function defaultEnableAudit(sandboxName: string): void {
  const runtime =
    require("../../adapters/openshell/runtime") as typeof import("../../adapters/openshell/runtime");
  runtime.captureOpenshell(buildEnableSandboxAuditLogsArgs(sandboxName), {
    ignoreError: true,
    includeStderr: true,
    timeout: getLogsProbeTimeoutMs(),
  });
}

// Capture the recent log tail. Best-effort: any failure yields empty output and
// therefore no hint.
function defaultProbeLogs(sandboxName: string): string {
  const runtime =
    require("../../adapters/openshell/runtime") as typeof import("../../adapters/openshell/runtime");
  const options: SandboxLogsOptions = {
    follow: false,
    lines: String(POLICY_HINT_TAIL_LINES),
    since: null,
  };
  const result = runtime.captureOpenshell(buildSandboxLogsArgs(sandboxName, options), {
    ignoreError: true,
    includeStderr: true,
    timeout: getLogsProbeTimeoutMs(),
  });
  return String(result.output ?? "");
}

/**
 * After a failed `nemoclaw <name> exec`, emit a denial-adjacent hint on stderr
 * when a policy denial is recorded after the command started. Returns the hint
 * text when one is emitted (for tests), or null. Never throws to the caller:
 * probe failures degrade silently so the exec result is never corrupted.
 *
 * The audit log is probed a few times with a short delay so a denial that has
 * not yet flushed to the queryable log the instant the child exits is still
 * caught, without adding meaningful latency to the common no-denial path.
 */
export async function maybeEmitPolicyDenialHint(
  cliName: string,
  sandboxName: string,
  commandCode: number,
  hadInvocationError: boolean,
  commandStartedAtMs: number,
  deps: PolicyDenialHintDeps = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (!shouldProbePolicyDenial(commandCode, hadInvocationError, env)) return null;

  const probeLogs = deps.probeLogs ?? defaultProbeLogs;
  const enableAudit = deps.enableAudit ?? defaultEnableAudit;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = deps.attempts ?? POLICY_HINT_PROBE_ATTEMPTS;
  const retryDelayMs = deps.retryDelayMs ?? POLICY_HINT_PROBE_RETRY_MS;

  try {
    enableAudit(sandboxName);
  } catch {
    // Enabling audit logging is a convenience; proceed to read regardless.
  }

  let match: PolicyDenialMatch | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let logOutput: string;
    try {
      logOutput = probeLogs(sandboxName);
    } catch {
      return null;
    }
    match = findRecentPolicyDenial(logOutput, commandStartedAtMs);
    if (match) break;
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  if (!match) return null;

  const hint = buildPolicyDenialExecHint(cliName, sandboxName, match.endpoint);
  (deps.writeStderr ?? ((line: string) => console.error(line)))(hint);
  return hint;
}
