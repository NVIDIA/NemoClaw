// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared, bounded OpenClaw device-scope approval pass.
 *
 * The in-sandbox auto-pair watcher (`scripts/nemoclaw-start.sh`) keeps
 * approving allowlisted scope upgrades in slow-mode for hours after startup.
 * This host-side pass is the defense-in-depth recovery for the cases where the
 * watcher has exited (deadline reached), crashed, or was contended away by a
 * second sandbox — leaving a late scope upgrade pending forever.
 *
 * It is used from two surfaces:
 *   - `nemoclaw <sandbox> connect` (#4263), which runs it silently before SSH.
 *   - `nemoclaw <sandbox> doctor --fix` (#4616), which runs it as a
 *     dashboard-only recovery so a browser/dashboard user can repair pending
 *     OpenClaw tool-scope approvals without ever opening an SSH `connect`.
 *
 * Both surfaces apply the SAME narrow allowlist as the startup watcher
 * (`scripts/lib/openclaw_device_approval_policy.py`): `openclaw-control-ui`
 * clients plus `webchat`/`cli` modes, restricted to operator.pairing/read/write
 * scopes. Unknown clients are ignored, never approved.
 *
 * Workaround boundary (NemoClaw#4462): OpenClaw owns device-pairing approval
 * semantics. In OpenClaw 2026.5.x, a gateway-pinned `devices approve` for a
 * scope-upgrade can request the upgraded scopes for its own connection and
 * return the pending-scope failure it is trying to resolve. The approval call
 * therefore strips OPENCLAW_GATEWAY_URL/PORT/TOKEN from the child env to use
 * OpenClaw's local pairing fallback; the list call stays gateway-pinned so it
 * inspects the live gateway. Remove this local fallback path when OpenClaw
 * approve can complete scope upgrades through the gateway using only
 * operator.pairing.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { shellQuote } from "../../core/shell-quote";
import { ROOT } from "../../state/paths";

// Bound the in-sandbox work: 2s list + 1s × MAX_APPROVALS attempts plus
// shell/python startup slack fits inside the outer spawnSync cap, so a wedged
// sandbox can never block the caller. These are the defaults for the doctor
// recovery surface (#4616), which batch-clears any backlog of pending upgrades.
export const AUTO_PAIR_MAX_APPROVALS = 8;
export const AUTO_PAIR_APPROVAL_TIMEOUT_MS = 12_000;
// Default per-call budgets (seconds) for the in-sandbox openclaw subcommands.
const AUTO_PAIR_LIST_TIMEOUT_S = 2;
const AUTO_PAIR_APPROVE_TIMEOUT_S = 1;

// Per-surface budget overrides. The connect/probe/finalization surfaces (#4504)
// supply a tighter budget — a single realistic pending CLI/webchat scope
// upgrade (maxApprovals = 1) on the watcher's 10s approve budget with a 15s
// outer cap — via ./connect-autopair-budget. The doctor surface (#4616) uses
// the defaults above to drain a backlog. Callers that omit a field inherit the
// default, so the historical doctor payload stays byte-stable.
export type AutoPairApprovalBudget = {
  maxApprovals?: number;
  listTimeoutS?: number;
  approveTimeoutS?: number;
  timeoutMs?: number;
};

const AUTO_PAIR_POLICY_PATH = path.join(
  ROOT,
  "scripts",
  "lib",
  "openclaw_device_approval_policy.py",
);

export type AutoPairApprovalResult = {
  /** The sandbox-exec was issued (false only when the policy helper is absent). */
  attempted: boolean;
  /** The in-sandbox script reported a parseable summary (capture mode only). */
  reported: boolean;
  /** Number of pending requests approved this pass (capture mode only). */
  approved: number;
};

/**
 * Wrap a multi-line shell payload so it survives `openshell sandbox exec`.
 *
 * OpenShell's exec RPC rejects any argument containing a newline or carriage
 * return ("command argument N contains newline or carriage return characters"),
 * so a multi-line `sh -c <script>` is refused outright. We base64-encode the
 * payload onto a single line, decode it to a temp file inside the sandbox, and
 * run that file — preserving heredocs and the original exit status. `base64`
 * from Node is unwrapped (no embedded newlines) and uses only shell-safe
 * characters, so it is safe inside single quotes. This mirrors the
 * base64-then-decode pattern the E2E harness uses for the same reason.
 */
export function wrapSandboxShellScript(script: string): string {
  const encoded = Buffer.from(script, "utf-8").toString("base64");
  return (
    `__nemoclaw_s="$(mktemp)" && ` +
    `printf %s '${encoded}' | base64 -d > "$__nemoclaw_s" && ` +
    `sh "$__nemoclaw_s"; __nemoclaw_rc=$?; rm -f "$__nemoclaw_s"; exit "$__nemoclaw_rc"`
  );
}

export function readAutoPairApprovalPolicyModule(): string | null {
  try {
    return readFileSync(AUTO_PAIR_POLICY_PATH, "utf-8");
  } catch {
    // Best-effort: a packaging/layout regression must not block connect or
    // doctor. Build-context and package `files` coverage keep this helper
    // present in supported installs.
    return null;
  }
}

/**
 * Build the in-sandbox sh+python approval-pass script. When `emitSummary` is
 * false the output is byte-identical to the historical connect-time script so
 * the connect approval-pass tests keep asserting against a stable payload; when
 * true it appends a single machine-readable summary marker so the doctor
 * recovery path can report how many upgrades it approved.
 */
export function buildAutoPairApprovalScript(
  approvalPolicyModuleB64: string,
  options: { emitSummary?: boolean; budget?: AutoPairApprovalBudget } = {},
): string {
  const summaryLine = options.emitSummary
    ? "print(f'__NEMOCLAW_AUTO_PAIR_APPROVED__={approved_count}')\n"
    : "";
  const maxApprovals = options.budget?.maxApprovals ?? AUTO_PAIR_MAX_APPROVALS;
  const listTimeoutS = options.budget?.listTimeoutS ?? AUTO_PAIR_LIST_TIMEOUT_S;
  const approveTimeoutS = options.budget?.approveTimeoutS ?? AUTO_PAIR_APPROVE_TIMEOUT_S;
  return `
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
command -v openclaw >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0
OPENCLAW_BIN="$(command -v openclaw)" NEMOCLAW_APPROVAL_POLICY_B64=${shellQuote(approvalPolicyModuleB64)} python3 - <<'PYAPPROVE'
import base64
import json
import os
import subprocess
import sys

try:
    policy_source = base64.b64decode(
        os.environ.get('NEMOCLAW_APPROVAL_POLICY_B64', ''), validate=True,
    ).decode('utf-8')
    policy_globals = {}
    exec(compile(policy_source, 'openclaw_device_approval_policy.py', 'exec'), policy_globals)
    approval_request_decision = policy_globals['approval_request_decision']
    gateway_approval_env = policy_globals['gateway_approval_env']
except Exception:
    sys.exit(0)

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')
MAX_APPROVALS = ${maxApprovals}

try:
    proc = subprocess.run(
        [OPENCLAW, 'devices', 'list', '--json'],
        capture_output=True, text=True, timeout=${listTimeoutS},
    )
except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
    sys.exit(0)
if proc.returncode != 0 or not proc.stdout.strip():
    sys.exit(0)
try:
    data = json.loads(proc.stdout)
except ValueError:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
pending = data.get('pending')
if not isinstance(pending, list):
    sys.exit(0)
approved_count = 0
attempted_count = 0
seen_request_ids = set()
for device in pending:
    if attempted_count >= MAX_APPROVALS:
        break
    if not isinstance(device, dict):
        continue
    request_id = device.get('requestId')
    if not request_id or request_id in seen_request_ids:
        continue
    decision = approval_request_decision(device)
    if not decision['allowed']:
        continue
    seen_request_ids.add(request_id)
    approve_env = gateway_approval_env(os.environ)
    attempted_count += 1
    try:
        approve_proc = subprocess.run(
            [OPENCLAW, 'devices', 'approve', request_id, '--json'],
            capture_output=True, text=True, timeout=${approveTimeoutS}, env=approve_env,
        )
        if approve_proc.returncode == 0:
            approved_count += 1
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        continue
${summaryLine}PYAPPROVE
exit 0
`;
}

/**
 * Run the bounded approval pass inside the named sandbox via `openshell sandbox
 * exec`. Failure modes (timeout, sandbox-exec errors, missing openclaw, gateway
 * unreachable, missing policy helper) are swallowed: callers treat this as
 * best-effort and must never let it throw.
 *
 * When `capture` is true the script emits a summary marker and this function
 * parses the approved count so doctor can report a repair outcome; otherwise it
 * runs silently like the original connect-time pass.
 */
export function runSandboxAutoPairApprovalPass(
  sandboxName: string,
  options: { capture?: boolean; budget?: AutoPairApprovalBudget } = {},
): AutoPairApprovalResult {
  const capture = options.capture === true;
  const approvalPolicyModule = readAutoPairApprovalPolicyModule();
  if (!approvalPolicyModule) {
    return { attempted: false, reported: false, approved: 0 };
  }
  const approvalPolicyModuleB64 = Buffer.from(approvalPolicyModule, "utf-8").toString("base64");
  const script = buildAutoPairApprovalScript(approvalPolicyModuleB64, {
    emitSummary: capture,
    budget: options.budget,
  });
  const outerTimeoutMs = options.budget?.timeoutMs ?? AUTO_PAIR_APPROVAL_TIMEOUT_MS;
  // Lazy require: `adapters/openshell/runtime` pulls in `runner`, whose
  // load-time `require("./platform")` cannot be resolved by the Vitest TS
  // loader. Importing it here keeps this module unit-testable in-process.
  const { getOpenshellBinary } =
    require("../../adapters/openshell/runtime") as typeof import("../../adapters/openshell/runtime");
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", wrapSandboxShellScript(script)],
      {
        cwd: ROOT,
        env: process.env,
        stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
        encoding: "utf-8",
        timeout: outerTimeoutMs,
      },
    );
    if (!capture) {
      return { attempted: true, reported: false, approved: 0 };
    }
    const match = String(result.stdout || "").match(/__NEMOCLAW_AUTO_PAIR_APPROVED__=(\d+)/);
    if (!match) {
      return { attempted: true, reported: false, approved: 0 };
    }
    return { attempted: true, reported: true, approved: Number(match[1]) };
  } catch {
    /* defense-in-depth — never throw from the connect or doctor path */
    return { attempted: true, reported: false, approved: 0 };
  }
}
