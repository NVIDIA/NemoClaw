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
 * (`scripts/lib/openclaw_device_approval_policy.py`): the explicit `cli`,
 * `openclaw-cli`, and `openclaw-control-ui` client identities, restricted to
 * operator.pairing/read/write scopes. A known mode alone is never sufficient;
 * unknown clients are ignored, never approved.
 *
 * Workaround boundary (NemoClaw#4462): OpenClaw owns device-pairing approval
 * semantics. In the reviewed OpenClaw 2026.6.10, a gateway-pinned
 * `devices approve` for a scope-upgrade can request the upgraded scopes for
 * its own connection and return the pending-scope failure it is trying to
 * resolve. The sourced runtime environment identifies the live gateway.
 * Ordinary list and approval children drop shared-auth overrides after pairing
 * so they use the CLI device credential. For a restored pairing-only clone,
 * the approval child also pins the clone's loopback URL and accepts only its
 * descriptor-backed identity and pairing snapshots. The reviewed dist patch
 * uses only the descriptor-backed pairing token for the pinned loopback
 * gateway and disables pathname-backed stored authentication for that exact
 * self-repair shape. It requires a matching live preflight before one canonical
 * approval. The canonical writer binds the authenticated token to the paired
 * and stored-auth before-images, then journals pending, paired, and stored-auth
 * publication together. The wrapper verifies the resulting transition and
 * rewrites the same rotated token to the clone's client-auth store. Remove this
 * compatibility path when OpenClaw can complete scope upgrades natively
 * through device-token auth using operator.pairing.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { shellQuote } from "../../core/shell-quote";
import { ROOT } from "../../state/paths";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_PENDING_READ_ATTEMPTS,
  CONNECT_AUTO_PAIR_PENDING_READ_POLL_S,
  CONNECT_AUTO_PAIR_POST_TIMEOUT_OBSERVE_S,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "./connect-autopair-budget";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";
import { buildTrustedProxyEnvSourceShell } from "./trusted-proxy-env";

// Bound the in-sandbox work: 2s list + 1s × MAX_APPROVALS attempts plus
// shell/python startup slack fits inside the outer spawnSync cap, so a wedged
// sandbox can never block the caller. These are the defaults for the doctor
// recovery surface (#4616), which batch-clears any backlog of pending upgrades.
export const AUTO_PAIR_MAX_APPROVALS = 8;
export const AUTO_PAIR_APPROVAL_TIMEOUT_MS = 12_000;
// Default per-call budgets (seconds) for the in-sandbox openclaw subcommands.
const AUTO_PAIR_LIST_TIMEOUT_S = 2;
const AUTO_PAIR_APPROVE_TIMEOUT_S = 1;
const AUTO_PAIR_POST_TIMEOUT_POLL_S = 0.1;
const PORTABLE_PAIRING_APPROVAL_MARKER = "__NEMOCLAW_PORTABLE_PAIRING_APPROVAL__=";
const PORTABLE_PAIRING_SHA256_RE = /^[a-f0-9]{64}$/u;
const PORTABLE_PAIRING_APPROVAL_MAX_OUTPUT_BYTES = 4 * 1_024;
const PORTABLE_PAIRING_PRODUCER_TIMEOUT_MS = 30_000;
const PORTABLE_PAIRING_PENDING_ATTEMPTS = 5;
const PORTABLE_PAIRING_LIST_TIMEOUT_S = 2;

const CONNECT_AUTO_PAIR_BUDGET = {
  maxApprovals: CONNECT_AUTO_PAIR_MAX_APPROVALS,
  listTimeoutS: CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  approveTimeoutS: CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  timeoutMs: CONNECT_AUTO_PAIR_TIMEOUT_MS,
} as const;

// Per-surface budget overrides. The connect/probe/finalization surfaces (#4504)
// supply a tighter budget — a single realistic pending CLI/webchat scope
// upgrade (maxApprovals = 1) on the watcher's 10s approve budget with a 25s
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
  /** Fixed clone-only diagnostic; never contains command output or identifiers. */
  receipt: AutoPairApprovalReceipt | null;
};

type AutoPairApprovalExecDeps = {
  getOpenshellBinary: () => string;
  spawnSync: typeof spawnSync;
};

export type AutoPairApprovalReceipt =
  | "policy-missing"
  | "exec-failed"
  | "exec-timeout"
  | "exec-spawn-failed"
  | "exec-command-failed"
  | "exec-signal"
  | "exec-invalid-receipt"
  | "list-failed"
  | "list-state-path-invalid"
  | "list-platform-unsupported"
  | "list-state-root-failed"
  | "list-devices-directory-failed"
  | "list-pending-unsafe"
  | "list-pending-unstable"
  | "list-pending-invalid-shape"
  | "list-pending-unavailable"
  | "list-timeout"
  | "list-exec-failed"
  | "list-scope-upgrade-pending"
  | "list-device-pairing-required"
  | "list-gateway-connect-failed"
  | "list-command-failed"
  | "list-empty-output"
  | "list-invalid-json"
  | "list-invalid-output"
  | "list-missing-pending"
  | "clone-no-match"
  | "clone-ambiguous"
  | "request-rejected"
  | "approve-failed"
  | "approved-one";

const AUTO_PAIR_RECEIPT_LINE_RE =
  /^__NEMOCLAW_AUTO_PAIR_RECEIPT__=(policy-missing|exec-failed|list-failed|list-state-path-invalid|list-platform-unsupported|list-state-root-failed|list-devices-directory-failed|list-pending-unsafe|list-pending-unstable|list-pending-invalid-shape|list-pending-unavailable|list-timeout|list-exec-failed|list-scope-upgrade-pending|list-device-pairing-required|list-gateway-connect-failed|list-command-failed|list-empty-output|list-invalid-json|list-invalid-output|list-missing-pending|clone-no-match|clone-ambiguous|request-rejected|approve-failed|approved-one)$/;

/**
 * Parse one fixed receipt only when it is the sole receipt and terminal output
 * line. Any other shape fails closed without exposing command output.
 */
export function parseAutoPairApprovalReceipt(output: string): AutoPairApprovalReceipt | null {
  const markerPrefix = "__NEMOCLAW_AUTO_PAIR_RECEIPT__=";
  const receiptLines = output.split(/\r?\n/).filter((line) => line.startsWith(markerPrefix));
  const terminalLine = output.trimEnd().split(/\r?\n/).at(-1);
  if (receiptLines.length !== 1 || terminalLine !== receiptLines[0]) {
    return null;
  }
  const match = receiptLines[0].match(AUTO_PAIR_RECEIPT_LINE_RE);
  return (match?.[1] as AutoPairApprovalReceipt | undefined) ?? null;
}

type AutoPairApprovalExecResult = {
  error?: Error;
  status: number | null;
  signal?: NodeJS.Signals | null;
};

/**
 * Collapse host-side sandbox-exec failures into fixed, non-secret receipts.
 * Command output, error messages, signal names, and identifiers stay private.
 */
export function classifyAutoPairApprovalExecReceipt(
  result: AutoPairApprovalExecResult,
  output: string,
): AutoPairApprovalReceipt {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    return "exec-timeout";
  }
  if (result.error) {
    return "exec-spawn-failed";
  }
  if (result.signal) {
    return "exec-signal";
  }
  if (result.status !== 0) {
    return "exec-command-failed";
  }
  return parseAutoPairApprovalReceipt(output) ?? "exec-invalid-receipt";
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
 * Build the in-sandbox sh+python approval-pass script. With no emit option the
 * output is byte-identical to the historical connect-time script. `emitSummary`
 * adds the doctor's count; `emitReceipt` adds one fixed restored-clone
 * classification without forwarding command output or request identifiers.
 */
export function buildAutoPairApprovalScript(
  approvalPolicyModuleB64: string,
  options: {
    emitSummary?: boolean;
    emitReceipt?: boolean;
    budget?: AutoPairApprovalBudget;
    localDeviceOnly?: boolean;
  } = {},
): string {
  const summaryLine = options.emitSummary
    ? "print(f'__NEMOCLAW_AUTO_PAIR_APPROVED__={approved_count}')\n"
    : "";
  const receiptPrelude = options.emitReceipt
    ? `
RECEIPT_MARKER = '__NEMOCLAW_AUTO_PAIR_RECEIPT__'

def exit_with_receipt(receipt):
    print(f'{RECEIPT_MARKER}={receipt}')
    sys.exit(0)
`
    : "";
  const exitWithReceipt = (receipt: AutoPairApprovalReceipt) =>
    options.emitReceipt ? `exit_with_receipt('${receipt}')` : "sys.exit(0)";
  const receiptSuccessLine = options.emitReceipt ? "exit_with_receipt('approved-one')\n" : "";
  const rejectedRequestAction = options.emitReceipt
    ? "exit_with_receipt('request-rejected')"
    : "continue";
  const failedApproveBranch = options.emitReceipt
    ? "        else:\n            exit_with_receipt('approve-failed')\n"
    : "";
  const failedApproveAction = options.emitReceipt
    ? "exit_with_receipt('approve-failed')"
    : "continue";
  const cloneStateApprovalGuard = options.localDeviceOnly
    ? `if (
        not clone_directory_is_current('devices', clone_devices_dir_fd)
        or not clone_directory_is_current('identity', clone_identity_dir_fd)
    ):
        ${failedApproveAction}
    `
    : "";
  const maxApprovals = options.localDeviceOnly
    ? 1
    : (options.budget?.maxApprovals ?? AUTO_PAIR_MAX_APPROVALS);
  const listTimeoutS = options.budget?.listTimeoutS ?? AUTO_PAIR_LIST_TIMEOUT_S;
  const approveTimeoutS = options.budget?.approveTimeoutS ?? AUTO_PAIR_APPROVE_TIMEOUT_S;
  const approveEnv = options.localDeviceOnly
    ? `approve_env = gateway_approval_env(os.environ)
    approval_pass_fds = ()
    # A restored pre-convergence clone uses only the pairing-scoped token from
    # its own paired state for one canonical approval. A request without that
    # paired baseline was rejected before this approval loop.
    if local_approval_auth_mode == 'paired-token':
        raw_gateway_port = str(os.environ.get('OPENCLAW_GATEWAY_PORT', '') or '').strip()
        if (
            not raw_gateway_port.isascii()
            or not raw_gateway_port.isdecimal()
            or raw_gateway_port != str(int(raw_gateway_port))
            or not 1 <= int(raw_gateway_port) <= 65535
            or min(
                clone_state_dir_fd,
                clone_devices_dir_fd,
                clone_identity_dir_fd,
                clone_pending_snapshot_fd,
                clone_paired_snapshot_fd,
                clone_identity_snapshot_fd,
            ) < 3
        ):
            ${exitWithReceipt("approve-failed")}
        pinned_gateway_url = f'ws://127.0.0.1:{raw_gateway_port}'
        approve_env.pop('OPENCLAW_GATEWAY_TOKEN', None)
        approve_env.pop('OPENCLAW_GATEWAY_PASSWORD', None)
        approve_env.pop('OPENCLAW_CONFIG_PATH', None)
        approve_env['OPENCLAW_STATE_DIR'] = f'/proc/self/fd/{clone_state_dir_fd}'
        approve_env['OPENCLAW_GATEWAY_URL'] = pinned_gateway_url
        approve_env['NODE_DISABLE_COMPILE_CACHE'] = '1'
        approve_env['OPENCLAW_NO_RESPAWN'] = '1'
        approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)
        approve_env.pop('NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT', None)
        approve_env['NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING'] = '1'
        approve_env['NEMOCLAW_OPENCLAW_PINNED_GATEWAY_URL'] = pinned_gateway_url
        approve_env['NEMOCLAW_OPENCLAW_EXPECTED_DEVICE_ID'] = local_device_id
        approve_env['NEMOCLAW_OPENCLAW_PENDING_FD'] = str(clone_pending_snapshot_fd)
        approve_env['NEMOCLAW_OPENCLAW_PAIRED_FD'] = str(clone_paired_snapshot_fd)
        approve_env['NEMOCLAW_OPENCLAW_IDENTITY_FD'] = str(clone_identity_snapshot_fd)
        approval_pass_fds = (
            clone_state_dir_fd,
            clone_pending_snapshot_fd,
            clone_paired_snapshot_fd,
            clone_identity_snapshot_fd,
        )
    else:
        approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)
        approve_env.pop('NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT', None)
        approve_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)`
    : `approve_env = gateway_approval_env(os.environ)
    approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)
    approve_env.pop('NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT', None)
    approve_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)`;
  const pairedTokenSuccess = options.localDeviceOnly
    ? `            if local_approval_auth_mode == 'paired-token':
                previous_approval_token = local_paired_operator_token
                approve_env.pop('OPENCLAW_GATEWAY_TOKEN', None)
                approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)
                approve_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)
                local_paired_operator_token = ''
                if not sync_approved_clone_device_auth(device, previous_approval_token):
                    ${exitWithReceipt("approve-failed")}
`
    : "";
  const pairedTokenConcurrentSuccess = options.localDeviceOnly
    ? `        elif local_approval_auth_mode == 'paired-token':
            # The clone watcher can win the same canonical approval between this
            # pass's local preflight and CLI call. Do not retry. Accept only the
            # already-published exact transition and synchronize its rotated
            # clone credential through the same strict post-state check.
            previous_approval_token = local_paired_operator_token
            approve_env.pop('OPENCLAW_GATEWAY_TOKEN', None)
            approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)
            approve_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)
            local_paired_operator_token = ''
            if not sync_approved_clone_device_auth(device, previous_approval_token):
                ${exitWithReceipt("approve-failed")}
            approved_count += 1
`
    : "";
  const approveExceptionHandler = options.localDeviceOnly
    ? `    except subprocess.TimeoutExpired:
        if local_approval_auth_mode != 'paired-token':
            ${failedApproveAction}
        # The agent gateway can publish the validated transition after the
        # paired-token child process reaches its timeout. Do not issue a second
        # approval. Observe only that transition for a bounded interval. Then
        # synchronize the rotated clone credential.
        previous_approval_token = local_paired_operator_token
        approve_env.pop('OPENCLAW_GATEWAY_TOKEN', None)
        approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)
        approve_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)
        local_paired_operator_token = ''
        observe_deadline = time.monotonic() + ${CONNECT_AUTO_PAIR_POST_TIMEOUT_OBSERVE_S}
        while not sync_approved_clone_device_auth(device, previous_approval_token):
            remaining_observe_time = observe_deadline - time.monotonic()
            if remaining_observe_time <= 0:
                ${failedApproveAction}
            time.sleep(min(${AUTO_PAIR_POST_TIMEOUT_POLL_S}, remaining_observe_time))
        approved_count += 1
    except (FileNotFoundError, OSError):
        ${failedApproveAction}
`
    : `    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        ${failedApproveAction}
`;
  const approvalPassFdsArgument = options.localDeviceOnly
    ? "\n            pass_fds=approval_pass_fds,"
    : "";
  const pendingRead = options.localDeviceOnly
    ? `
# SOURCE_OF_TRUTH_REVIEW (restored-clone local pending selection):
# Invalid state: after snapshot restore restarts the clone gateway, the bounded
# warm-up asks for operator.write. When the clone's paired baseline lacks that
# scope, OpenClaw creates the pending transition, and that same transition gates
# the devices list this one-shot approval pass would need.
# Creation point: establishRestoredSandboxGatewayPairing runs the direct
# restored-clone gateway warm-up immediately before this approval. Restore
# preserves the clone-owned identity and server pairing record, while its client
# auth store cannot converge on a rotated token until canonical approval
# finishes.
# Source boundary: read only the clone-local pending map, validate one exact
# request below, and delegate the write to OpenClaw's canonical devices approve
# command. OpenClaw 2026.7.1 has no authenticated bootstrap/list API that can
# return this pending request, and that upstream API cannot be added in this PR.
# Regression proof: "adds local-device filtering only for restored-clone
# approval" pins this local-read boundary, and the pinned real-dist proof creates
# the transition before exercising one canonical approval and ordinary verifier.
# Removal condition: delete this path when the pinned OpenClaw release exposes
# that bootstrap/list API for an unpaired clone.
import stat
import time

state_dir = os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw'
if not os.path.isabs(state_dir):
    ${exitWithReceipt("list-state-path-invalid")}
for required_flag in ('O_DIRECTORY', 'O_NOFOLLOW'):
    if not hasattr(os, required_flag):
        ${exitWithReceipt("list-platform-unsupported")}
clone_directory_flags = (
    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)
)
clone_path_flags = (
    getattr(os, 'O_PATH', os.O_RDONLY)
    | os.O_DIRECTORY
    | os.O_NOFOLLOW
    | getattr(os, 'O_CLOEXEC', 0)
)
clone_file_flags = (
    os.O_RDONLY
    | os.O_NOFOLLOW
    | getattr(os, 'O_CLOEXEC', 0)
    | getattr(os, 'O_NONBLOCK', 0)
)
PENDING_READ_ATTEMPTS = ${CONNECT_AUTO_PAIR_PENDING_READ_ATTEMPTS}
PENDING_READ_POLL_S = ${CONNECT_AUTO_PAIR_PENDING_READ_POLL_S}

class CloneStateEntryRotated(OSError):
    pass

def validate_clone_json_descriptor(fd):
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink > 1:
        raise OSError('clone state entry is not a single regular file')
    if metadata.st_nlink == 0:
        raise CloneStateEntryRotated('clone state entry was replaced after open')

def open_clone_state_root():
    # Ancestors such as / are traversal boundaries, not state directories.
    # OpenShell's restored-clone policy permits path traversal but intentionally
    # denies a read-directory handle for the whole filesystem root.
    root_fd = os.open(os.sep, clone_path_flags)
    try:
        for component in (part for part in state_dir.split(os.sep) if part):
            if component in ('.', '..'):
                raise OSError('unsafe clone state root')
            next_fd = os.open(
                component,
                clone_path_flags,
                dir_fd=root_fd,
            )
            os.close(root_fd)
            root_fd = next_fd
        return root_fd
    except Exception:
        os.close(root_fd)
        raise

try:
    clone_state_dir_fd = open_clone_state_root()
except OSError:
    ${exitWithReceipt("list-state-root-failed")}

def clone_state_root_is_current():
    try:
        current = os.stat(state_dir, follow_symlinks=False)
        pinned = os.fstat(clone_state_dir_fd)
    except OSError:
        return False
    return (
        stat.S_ISDIR(current.st_mode)
        and (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino)
    )

def clone_directory_is_current(directory_name, directory_fd):
    if directory_name not in ('devices', 'identity') or not clone_state_root_is_current():
        return False
    try:
        current = os.stat(
            directory_name,
            dir_fd=clone_state_dir_fd,
            follow_symlinks=False,
        )
        pinned = os.fstat(directory_fd)
    except OSError:
        return False
    return (
        stat.S_ISDIR(current.st_mode)
        and stat.S_ISDIR(pinned.st_mode)
        and (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino)
    )

def open_clone_directory(directory_name):
    if directory_name not in ('devices', 'identity'):
        raise OSError('unsupported clone state directory')
    directory_fd = os.open(
        directory_name,
        clone_directory_flags,
        dir_fd=clone_state_dir_fd,
    )
    if not clone_directory_is_current(directory_name, directory_fd):
        os.close(directory_fd)
        raise OSError('clone state directory changed')
    return directory_fd

def open_clone_json_descriptor(directory_fd, directory_name, entry_name):
    if (
        not clone_directory_is_current(directory_name, directory_fd)
        or entry_name in ('', '.', '..')
        or os.sep in entry_name
    ):
        raise OSError('unsafe clone state entry')
    fd = os.open(entry_name, clone_file_flags, dir_fd=directory_fd)
    try:
        validate_clone_json_descriptor(fd)
        with os.fdopen(os.dup(fd), encoding='utf-8') as handle:
            parsed = json.load(handle)
        validate_clone_json_descriptor(fd)
        os.lseek(fd, 0, os.SEEK_SET)
        if not clone_directory_is_current(directory_name, directory_fd):
            raise OSError('clone state directory changed')
        return parsed, fd
    except Exception:
        os.close(fd)
        raise

def read_clone_json(directory_fd, directory_name, entry_name):
    parsed, fd = open_clone_json_descriptor(directory_fd, directory_name, entry_name)
    os.close(fd)
    return parsed

try:
    clone_devices_dir_fd = open_clone_directory('devices')
except OSError:
    ${exitWithReceipt("list-devices-directory-failed")}
# The gateway can publish pending.json immediately after the warm-up. Retry only
# a missing entry before publication, invalid JSON during truncate/write, or an
# opened inode that an atomic replace unlinked. Unsafe filesystem shapes and
# persistently malformed documents fail closed before request selection.
pending_read_failure = 'unavailable'
for pending_read_attempt in range(PENDING_READ_ATTEMPTS):
    try:
        local_pending_by_id, clone_pending_snapshot_fd = open_clone_json_descriptor(
            clone_devices_dir_fd,
            'devices',
            'pending.json',
        )
    except FileNotFoundError:
        pending_read_failure = 'unavailable'
    except (CloneStateEntryRotated, json.JSONDecodeError):
        pending_read_failure = 'unstable'
    except (OSError, ValueError):
        ${exitWithReceipt("list-pending-unsafe")}
    else:
        if not isinstance(local_pending_by_id, dict):
            ${exitWithReceipt("list-pending-invalid-shape")}
        break
    if pending_read_attempt + 1 < PENDING_READ_ATTEMPTS:
        time.sleep(PENDING_READ_POLL_S)
else:
    if pending_read_failure == 'unavailable':
        ${exitWithReceipt("list-pending-unavailable")}
    ${exitWithReceipt("list-pending-unstable")}
pending = list(local_pending_by_id.values())
`
    : `
list_env = gateway_approval_env(os.environ)
list_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)
list_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)
list_env['NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT'] = '1'
try:
    proc = subprocess.run(
        [OPENCLAW, 'devices', 'list', '--json'],
        capture_output=True, text=True, timeout=${listTimeoutS}, env=list_env,
    )
except subprocess.TimeoutExpired:
    ${exitWithReceipt("list-timeout")}
except (FileNotFoundError, OSError):
    ${exitWithReceipt("list-exec-failed")}
if proc.returncode != 0:
    command_output = f'{proc.stdout}\\n{proc.stderr}'.lower()
    if (
        'scope upgrade pending approval' in command_output
        or 'pairing required: device is asking for more scopes' in command_output
    ):
        ${exitWithReceipt("list-scope-upgrade-pending")}
    elif 'device pairing required' in command_output or 'pairing required' in command_output:
        ${exitWithReceipt("list-device-pairing-required")}
    elif 'gateway connect failed' in command_output:
        ${exitWithReceipt("list-gateway-connect-failed")}
    else:
        ${exitWithReceipt("list-command-failed")}
if not proc.stdout.strip():
    ${exitWithReceipt("list-empty-output")}
try:
    data = json.loads(proc.stdout)
except ValueError:
    ${exitWithReceipt("list-invalid-json")}
if not isinstance(data, dict):
    ${exitWithReceipt("list-invalid-output")}
pending = data.get('pending')
if not isinstance(pending, list):
    ${exitWithReceipt("list-missing-pending")}
`;
  const localDeviceFilter = options.localDeviceOnly
    ? `
# Snapshot restore shares one gateway across the source sandbox and its clone.
# Select exactly one pending CLI transition whose device identity matches the
# clone executing this script. Ambiguous or malformed state approves nothing;
# OpenClaw remains the only writer through the canonical approve command.
import binascii
import hashlib
import re
import time

REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')
ALLOWED_LOCAL_SCOPES = {'operator.pairing', 'operator.read', 'operator.write'}

def local_identity_public_key(identity):
    raw = str(identity.get('publicKey', '') or '').strip()
    if raw:
        return raw
    pem = str(identity.get('publicKeyPem', '') or '')
    body = ''.join(line.strip() for line in pem.splitlines() if '---' not in line)
    if not body:
        return ''
    try:
        der = base64.b64decode(body, validate=True)
    except (ValueError, binascii.Error):
        return ''
    if len(der) < 32:
        return ''
    return base64.urlsafe_b64encode(der[-32:]).decode('ascii').rstrip('=')

def normalized_roles(device):
    roles = set()
    if device.get('role') is not None:
        role = device.get('role')
        if not isinstance(role, str) or not role.strip():
            return None
        roles.add(role.strip())
    if device.get('roles') is not None:
        raw_roles = device.get('roles')
        if not isinstance(raw_roles, list):
            return None
        for role in raw_roles:
            if not isinstance(role, str) or not role.strip():
                return None
            roles.add(role.strip())
    return roles

def bounded_scope_set(raw_scopes):
    if not isinstance(raw_scopes, list) or not raw_scopes:
        return None
    scopes = []
    for scope in raw_scopes:
        if not isinstance(scope, str) or not scope.strip():
            return None
        scopes.append(scope.strip())
    if len(scopes) != len(set(scopes)) or not set(scopes).issubset(ALLOWED_LOCAL_SCOPES):
        return None
    return set(scopes)

def consistent_scope_view(device):
    if 'scopes' not in device or 'requestedScopes' in device:
        return None
    views = []
    for key in ('scopes', 'requestedScopes'):
        if key not in device:
            continue
        scopes = bounded_scope_set(device.get(key))
        if scopes is None:
            return None
        views.append(scopes)
    if not views or any(view != views[0] for view in views[1:]):
        return None
    return views[0]

def paired_operator_credential(device):
    raw_tokens = device.get('tokens')
    if not isinstance(raw_tokens, dict) or set(raw_tokens) != {'operator'}:
        return None
    operator = raw_tokens.get('operator')
    if (
        not isinstance(operator, dict)
        or str(operator.get('role', '') or '').strip() != 'operator'
        or operator.get('revokedAtMs') is not None
    ):
        return None
    token = str(operator.get('token', '') or '').strip()
    scopes = bounded_scope_set(operator.get('scopes'))
    if not token or scopes is None or 'operator.pairing' not in scopes:
        return None
    return token, scopes

def paired_has_exact_pairing_baseline(device, token_scopes):
    scopes = bounded_scope_set(device.get('scopes'))
    approved_scopes = bounded_scope_set(device.get('approvedScopes'))
    return (
        scopes == {'operator.pairing'}
        and approved_scopes == {'operator.pairing'}
        and token_scopes == {'operator.pairing'}
    )

def client_auth_matches_paired(token, scopes):
    try:
        auth_store = read_clone_json(
            clone_identity_dir_fd,
            'identity',
            'device-auth.json',
        )
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return None
    if (
        not isinstance(auth_store, dict)
        or auth_store.get('version') != 1
        or str(auth_store.get('deviceId', '') or '').strip() != local_device_id
    ):
        return False
    tokens = auth_store.get('tokens')
    if not isinstance(tokens, dict) or set(tokens) != {'operator'}:
        return False
    operator = tokens.get('operator')
    if not isinstance(operator, dict):
        return False
    stored_scopes = bounded_scope_set(operator.get('scopes'))
    return (
        str(operator.get('token', '') or '').strip() == token
        and str(operator.get('role', '') or '').strip() == 'operator'
        and stored_scopes == scopes
    )

try:
    clone_identity_dir_fd = open_clone_directory('identity')
    local_identity, clone_identity_snapshot_fd = open_clone_json_descriptor(
        clone_identity_dir_fd,
        'identity',
        'device.json',
    )
except (OSError, ValueError):
    ${exitWithReceipt("request-rejected")}
if not isinstance(local_identity, dict):
    ${exitWithReceipt("request-rejected")}
local_device_id = str(local_identity.get('deviceId', '') or '').strip()
local_public_key = local_identity_public_key(local_identity)
if not local_device_id or not local_public_key:
    ${exitWithReceipt("request-rejected")}
try:
    local_public_key_raw = base64.urlsafe_b64decode(
        local_public_key + '=' * (-len(local_public_key) % 4),
    )
except (ValueError, binascii.Error):
    ${exitWithReceipt("request-rejected")}
if (
    len(local_public_key_raw) != 32
    or hashlib.sha256(local_public_key_raw).hexdigest() != local_device_id
):
    ${exitWithReceipt("request-rejected")}

# Snapshot restore preserves this clone-owned runtime auth state instead of
# copying the source sandbox's identity/devices directory. Use the clone's
# paired record and client auth store to choose auth. An exact pairing-only
# baseline uses the clone's paired token for its bounded write upgrade, whether
# OpenClaw marks the request as repair or pre-convergence. The restored source
# config is never a credential.
try:
    local_paired_by_id, clone_paired_snapshot_fd = open_clone_json_descriptor(
        clone_devices_dir_fd,
        'devices',
        'paired.json',
    )
except FileNotFoundError:
    local_paired_by_id = {}
    clone_paired_snapshot_fd = -1
except (OSError, ValueError):
    ${exitWithReceipt("request-rejected")}
if not isinstance(local_paired_by_id, dict):
    ${exitWithReceipt("request-rejected")}
related_paired = [
    (map_key, device) for map_key, device in local_paired_by_id.items()
    if map_key == local_device_id or (
        isinstance(device, dict) and (
            str(device.get('deviceId', '') or '').strip() == local_device_id
            or str(device.get('publicKey', '') or '').strip() == local_public_key
        )
    )
]
if len(related_paired) > 1:
    ${exitWithReceipt("request-rejected")}
has_local_paired_baseline = len(related_paired) == 1
local_paired_operator_token = ''
local_paired_operator_scopes = set()
local_client_auth_matches = False
local_paired_exact_pairing_baseline = False
if has_local_paired_baseline:
    paired_map_key, paired_device = related_paired[0]
    if (
        paired_map_key != local_device_id
        or not isinstance(paired_device, dict)
        or str(paired_device.get('deviceId', '') or '').strip() != local_device_id
        or str(paired_device.get('publicKey', '') or '').strip() != local_public_key
        or normalized_roles(paired_device) != {'operator'}
    ):
        ${exitWithReceipt("request-rejected")}
    paired_credential = paired_operator_credential(paired_device)
    if paired_credential is None:
        ${exitWithReceipt("request-rejected")}
    local_paired_operator_token, local_paired_operator_scopes = paired_credential
    local_paired_exact_pairing_baseline = paired_has_exact_pairing_baseline(
        paired_device,
        local_paired_operator_scopes,
    )
    local_client_auth_matches = client_auth_matches_paired(
        local_paired_operator_token,
        local_paired_operator_scopes,
    )
    if local_client_auth_matches is None:
        ${exitWithReceipt("request-rejected")}

def local_pairing_transition_auth_mode(device):
    request_id = device.get('requestId')
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        return None
    if str(device.get('deviceId', '') or '').strip() != local_device_id:
        return None
    if str(device.get('publicKey', '') or '').strip() != local_public_key:
        return None
    if str(device.get('clientId', '') or '').strip() != 'cli':
        return None
    if str(device.get('clientMode', '') or '').strip() != 'cli':
        return None
    if normalized_roles(device) != {'operator'}:
        return None
    scopes = consistent_scope_view(device)
    if scopes is None:
        return None
    is_repair = device.get('isRepair')
    if not has_local_paired_baseline:
        return None
    if is_repair in (True, False) and 'operator.write' in scopes:
        if local_paired_exact_pairing_baseline:
            return 'paired-token'
        if local_client_auth_matches:
            return 'stored'
    return None

def sync_approved_clone_device_auth(request, previous_token):
    try:
        pending_after = read_clone_json(
            clone_devices_dir_fd,
            'devices',
            'pending.json',
        )
        paired_after = read_clone_json(
            clone_devices_dir_fd,
            'devices',
            'paired.json',
        )
    except (OSError, ValueError):
        return False
    if not isinstance(pending_after, dict) or not isinstance(paired_after, dict):
        return False
    request_id = request.get('requestId')
    if request_id in pending_after:
        return False
    related_after = [
        device for device in pending_after.values()
        if isinstance(device, dict) and (
            str(device.get('deviceId', '') or '').strip() == local_device_id
            or str(device.get('publicKey', '') or '').strip() == local_public_key
        )
    ]
    if related_after:
        return False
    related_paired_after = [
        (map_key, device) for map_key, device in paired_after.items()
        if map_key == local_device_id or (
            isinstance(device, dict) and (
                str(device.get('deviceId', '') or '').strip() == local_device_id
                or str(device.get('publicKey', '') or '').strip() == local_public_key
            )
        )
    ]
    if len(related_paired_after) != 1:
        return False
    paired_map_key, approved_device = related_paired_after[0]
    if (
        paired_map_key != local_device_id
        or not isinstance(approved_device, dict)
        or str(approved_device.get('deviceId', '') or '').strip() != local_device_id
        or str(approved_device.get('publicKey', '') or '').strip() != local_public_key
        or str(approved_device.get('clientId', '') or '').strip() != 'cli'
        or str(approved_device.get('clientMode', '') or '').strip() != 'cli'
        or normalized_roles(approved_device) != {'operator'}
    ):
        return False
    approved_credential = paired_operator_credential(approved_device)
    if approved_credential is None:
        return False
    approved_token, approved_token_scopes = approved_credential
    request_scopes = consistent_scope_view(request)
    if request_scopes is None:
        return False
    expected_token_scopes = set(request_scopes)
    expected_token_scopes.add('operator.pairing')
    if 'operator.write' in expected_token_scopes:
        expected_token_scopes.add('operator.read')
    approved_scopes = bounded_scope_set(approved_device.get('scopes'))
    approved_scope_view = bounded_scope_set(approved_device.get('approvedScopes'))
    if (
        approved_token == previous_token
        or approved_token_scopes != expected_token_scopes
        or approved_scopes is None
        or approved_scope_view is None
        or 'operator.write' not in approved_scopes
        or 'operator.write' not in approved_scope_view
    ):
        return False
    temp_name = ''
    try:
        if not clone_directory_is_current('identity', clone_identity_dir_fd):
            return False
        try:
            auth_stat = os.stat(
                'device-auth.json',
                dir_fd=clone_identity_dir_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            auth_stat = None
        if (
            auth_stat is not None
            and (not stat.S_ISREG(auth_stat.st_mode) or auth_stat.st_nlink != 1)
        ):
            return False
        auth_store = {
            'version': 1,
            'deviceId': local_device_id,
            'tokens': {
                'operator': {
                    'token': approved_token,
                    'role': 'operator',
                    'scopes': sorted(approved_token_scopes),
                    'updatedAtMs': int(time.time() * 1000),
                },
            },
        }
        temp_name = f'.device-auth.{os.getpid()}.{os.urandom(8).hex()}'
        temp_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_NOFOLLOW
            | getattr(os, 'O_CLOEXEC', 0)
        )
        fd = os.open(temp_name, temp_flags, 0o600, dir_fd=clone_identity_dir_fd)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                fd = -1
                json.dump(auth_store, handle, separators=(',', ':'))
                handle.write('\\n')
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(
                temp_name,
                'device-auth.json',
                src_dir_fd=clone_identity_dir_fd,
                dst_dir_fd=clone_identity_dir_fd,
            )
            temp_name = ''
            os.fsync(clone_identity_dir_fd)
            if not clone_directory_is_current('identity', clone_identity_dir_fd):
                return False
        finally:
            if fd >= 0:
                os.close(fd)
    except (OSError, ValueError):
        return False
    finally:
        if temp_name:
            try:
                os.unlink(temp_name, dir_fd=clone_identity_dir_fd)
            except FileNotFoundError:
                pass
    return True

related_pending = [
    device for device in pending
    if isinstance(device, dict) and (
        str(device.get('deviceId', '') or '').strip() == local_device_id
        or str(device.get('publicKey', '') or '').strip() == local_public_key
    )
]
if not related_pending:
    ${exitWithReceipt("clone-no-match")}
if len(related_pending) > 1:
    ${exitWithReceipt("clone-ambiguous")}
local_request_id = related_pending[0].get('requestId')
if sum(
    1 for device in pending
    if isinstance(device, dict) and device.get('requestId') == local_request_id
) != 1:
    ${exitWithReceipt("clone-ambiguous")}
if (
    local_pending_by_id.get(local_request_id) is not related_pending[0]
):
    ${exitWithReceipt("request-rejected")}
local_approval_auth_mode = local_pairing_transition_auth_mode(related_pending[0])
if local_approval_auth_mode is None:
    ${exitWithReceipt("request-rejected")}
pending = related_pending
`
    : "";
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
${receiptPrelude}
try:
    policy_source = base64.b64decode(
        os.environ.get('NEMOCLAW_APPROVAL_POLICY_B64', ''), validate=True,
    ).decode('utf-8')
    policy_globals = {}
    exec(compile(policy_source, 'openclaw_device_approval_policy.py', 'exec'), policy_globals)
    approval_request_decision = policy_globals['approval_request_decision']
    gateway_approval_env = policy_globals['gateway_approval_env']
except Exception:
    ${exitWithReceipt("policy-missing")}

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')
MAX_APPROVALS = ${maxApprovals}

${pendingRead}${localDeviceFilter}
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
        ${rejectedRequestAction}
    seen_request_ids.add(request_id)
    ${approveEnv}
    attempted_count += 1
    ${cloneStateApprovalGuard}try:
        approve_proc = subprocess.run(
            [OPENCLAW, 'devices', 'approve', request_id, '--json'],
            capture_output=True, text=True, timeout=${approveTimeoutS}, env=approve_env,${approvalPassFdsArgument}
        )
        if approve_proc.returncode == 0:
${pairedTokenSuccess}
            approved_count += 1
${pairedTokenConcurrentSuccess}${failedApproveBranch}${approveExceptionHandler}
${summaryLine}${receiptSuccessLine}PYAPPROVE
exit 0
`;
}

/**
 * Run the bounded approval pass inside the named sandbox via `openshell sandbox
 * exec`. Failure modes (timeout, sandbox-exec errors, missing openclaw, gateway
 * unreachable, missing policy helper) are swallowed: callers treat this as
 * best-effort and must never let it throw.
 *
 * `capture` emits the doctor's count. The separate clone-only `receipt` option
 * captures and parses one fixed classification; ordinary callers remain
 * silent, and no captured command output is returned.
 */
export function runSandboxAutoPairApprovalPass(
  sandboxName: string,
  options: {
    capture?: boolean;
    receipt?: boolean;
    budget?: AutoPairApprovalBudget;
    localDeviceOnly?: boolean;
    gatewayName?: string;
  } = {},
  execDeps?: AutoPairApprovalExecDeps,
): AutoPairApprovalResult {
  const emitReceipt = options.receipt === true && options.localDeviceOnly === true;
  const capture = options.capture === true || emitReceipt;
  const approvalPolicyModule = readAutoPairApprovalPolicyModule();
  if (!approvalPolicyModule) {
    return {
      attempted: false,
      reported: false,
      approved: 0,
      receipt: emitReceipt ? "policy-missing" : null,
    };
  }
  const approvalPolicyModuleB64 = Buffer.from(approvalPolicyModule, "utf-8").toString("base64");
  const script = buildAutoPairApprovalScript(approvalPolicyModuleB64, {
    emitSummary: options.capture === true,
    emitReceipt,
    budget: options.budget,
    localDeviceOnly: options.localDeviceOnly,
  });
  const outerTimeoutMs = options.budget?.timeoutMs ?? AUTO_PAIR_APPROVAL_TIMEOUT_MS;
  // Lazy require: `adapters/openshell/runtime` pulls in `runner`, whose
  // load-time `require("./platform")` cannot be resolved by the Vitest TS
  // loader. Importing it here keeps this module unit-testable in-process.
  const deps =
    execDeps ??
    (() => {
      const { getOpenshellBinary } =
        require("../../adapters/openshell/runtime") as typeof import("../../adapters/openshell/runtime");
      return { getOpenshellBinary, spawnSync };
    })();
  try {
    // The restored-clone program is larger than OpenShell's command-argument
    // transport boundary. Use the repository's supported stdin execution path
    // so script growth cannot fail before Python emits its fixed receipt.
    const result = deps.spawnSync(
      deps.getOpenshellBinary(),
      [
        "sandbox",
        "exec",
        "--name",
        sandboxName,
        ...(options.gatewayName ? ["-g", options.gatewayName] : []),
        "--",
        "sh",
        "-s",
      ],
      {
        cwd: ROOT,
        env: process.env,
        input: script,
        stdio: capture ? ["pipe", "pipe", "pipe"] : ["pipe", "ignore", "ignore"],
        encoding: "utf-8",
        timeout: outerTimeoutMs,
      },
    );
    const output = String(result.stdout || "");
    const receipt: AutoPairApprovalReceipt | null = emitReceipt
      ? classifyAutoPairApprovalExecReceipt(result, output)
      : null;
    if (!options.capture) {
      return { attempted: true, reported: false, approved: 0, receipt };
    }
    const match = output.match(/__NEMOCLAW_AUTO_PAIR_APPROVED__=(\d+)/);
    if (!match) {
      return { attempted: true, reported: false, approved: 0, receipt };
    }
    return { attempted: true, reported: true, approved: Number(match[1]), receipt };
  } catch {
    /* defense-in-depth — never throw from the connect or doctor path */
    return {
      attempted: true,
      reported: false,
      approved: 0,
      receipt: emitReceipt ? "exec-failed" : null,
    };
  }
}

/** Run the approval pass with the shared connect, probe, and finalization budget. */
export function runConnectAutoPairApprovalPass(
  sandboxName: string,
  gatewayName?: string,
  runApprovalPass = runSandboxAutoPairApprovalPass,
): void {
  let owningGatewayName = gatewayName;
  if (!owningGatewayName) {
    try {
      owningGatewayName = (
        require("./gateway-target") as typeof import("./gateway-target")
      ).getSandboxTargetGatewayName(sandboxName);
    } catch {
      return;
    }
  }
  const startedAt = performance.now();
  try {
    runApprovalPass(sandboxName, {
      budget: CONNECT_AUTO_PAIR_BUDGET,
      gatewayName: owningGatewayName,
    });
  } finally {
    try {
      performance.measure("nemoclaw.openclaw-pairing.complete-fallback", {
        start: startedAt,
        end: performance.now(),
      });
    } catch {
      // Performance measurements never control the complete pairing pass.
    }
  }
}

export type PortableOpenClawPairingApprovalReceipt =
  | "approved"
  | "ambiguous"
  | "no-request"
  | "rejected"
  | "unavailable";

function fixedPortableApprovalReceipt(receipt: PortableOpenClawPairingApprovalReceipt): string {
  return `print(${JSON.stringify(`${PORTABLE_PAIRING_APPROVAL_MARKER}${receipt}`)})`;
}

export function parsePortableOpenClawPairingApprovalReceipt(
  output: string,
): PortableOpenClawPairingApprovalReceipt | null {
  const lines = output.trimEnd().split(/\r?\n/u);
  const markerLines = lines.filter((line) => line.startsWith(PORTABLE_PAIRING_APPROVAL_MARKER));
  if (markerLines.length !== 1 || lines.at(-1) !== markerLines[0]) return null;
  const receipt = markerLines[0]!.slice(PORTABLE_PAIRING_APPROVAL_MARKER.length);
  return ["approved", "ambiguous", "no-request", "rejected", "unavailable"].includes(receipt)
    ? (receipt as PortableOpenClawPairingApprovalReceipt)
    : null;
}

export function buildPortableOpenClawPairingApprovalScript(
  approvalPolicyModuleB64: string,
  expectedDeviceIdentitySha256: string,
): string {
  if (
    !approvalPolicyModuleB64 ||
    Buffer.from(approvalPolicyModuleB64, "base64").toString("base64") !== approvalPolicyModuleB64 ||
    !PORTABLE_PAIRING_SHA256_RE.test(expectedDeviceIdentitySha256)
  ) {
    throw new Error("Portable OpenClaw pairing approval inputs are invalid.");
  }
  return `
${buildTrustedProxyEnvSourceShell()}
command -v openclaw >/dev/null 2>&1 || { printf '%s\\n' '${PORTABLE_PAIRING_APPROVAL_MARKER}unavailable'; exit 0; }
command -v python3 >/dev/null 2>&1 || { printf '%s\\n' '${PORTABLE_PAIRING_APPROVAL_MARKER}unavailable'; exit 0; }
OPENCLAW_BIN="$(command -v openclaw)" \\
NEMOCLAW_APPROVAL_POLICY_B64=${shellQuote(approvalPolicyModuleB64)} \\
NEMOCLAW_EXPECTED_DEVICE_IDENTITY_SHA256=${shellQuote(expectedDeviceIdentitySha256)} \\
python3 - <<'PYAPPROVE'
import base64
import hashlib
import json
import os
import re
import subprocess
import time

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')
EXPECTED_IDENTITY = os.environ.get('NEMOCLAW_EXPECTED_DEVICE_IDENTITY_SHA256', '')
REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')
REQUEST_SCOPE_SHAPES = {
    frozenset({'operator.write'}),
    frozenset({'operator.pairing', 'operator.write'}),
}

try:
    policy_source = base64.b64decode(
        os.environ.get('NEMOCLAW_APPROVAL_POLICY_B64', ''), validate=True,
    ).decode('utf-8')
    policy_globals = {}
    exec(compile(policy_source, 'openclaw_device_approval_policy.py', 'exec'), policy_globals)
    approval_request_decision = policy_globals['approval_request_decision']
    gateway_approval_env = policy_globals['gateway_approval_env']
except Exception:
    ${fixedPortableApprovalReceipt("unavailable")}
    raise SystemExit(0)

pending = []
for pending_attempt in range(${PORTABLE_PAIRING_PENDING_ATTEMPTS}):
    try:
        listed = subprocess.run(
            [OPENCLAW, 'devices', 'list', '--json'],
            capture_output=True, text=True, timeout=${PORTABLE_PAIRING_LIST_TIMEOUT_S},
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        ${fixedPortableApprovalReceipt("unavailable")}
        raise SystemExit(0)
    if listed.returncode != 0 or not listed.stdout.strip():
        ${fixedPortableApprovalReceipt("unavailable")}
        raise SystemExit(0)
    try:
        data = json.loads(listed.stdout)
    except ValueError:
        ${fixedPortableApprovalReceipt("unavailable")}
        raise SystemExit(0)
    if not isinstance(data, dict) or not isinstance(data.get('pending'), list):
        ${fixedPortableApprovalReceipt("unavailable")}
        raise SystemExit(0)
    pending = data['pending']
    if pending:
        break
    if pending_attempt + 1 < ${PORTABLE_PAIRING_PENDING_ATTEMPTS}:
        time.sleep(1)
if not pending:
    ${fixedPortableApprovalReceipt("no-request")}
    raise SystemExit(0)
if len(pending) != 1 or not isinstance(pending[0], dict):
    ${fixedPortableApprovalReceipt("rejected")}
    raise SystemExit(0)
request = pending[0]
request_id = request.get('requestId')
device_id = request.get('deviceId')
public_key = request.get('publicKey')
scopes = request.get('scopes')
identity = hashlib.sha256(json.dumps({
    'deviceId': device_id,
    'publicKey': public_key,
}, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
decision = approval_request_decision(request)
if (
    not isinstance(request_id, str)
    or not REQUEST_ID_RE.fullmatch(request_id)
    or not isinstance(device_id, str)
    or not device_id
    or not isinstance(public_key, str)
    or not public_key
    or 'publicKeyPem' in request
    or identity != EXPECTED_IDENTITY
    or request.get('clientId') != 'cli'
    or request.get('clientMode') != 'cli'
    or request.get('role') != 'operator'
    or not isinstance(request.get('roles'), list)
    or request.get('roles') != ['operator']
    or not isinstance(scopes, list)
    or len(scopes) != len(set(scopes))
    or frozenset(scopes) not in REQUEST_SCOPE_SHAPES
    or 'requestedScopes' in request
    or request.get('isRepair') is not True
    or not isinstance(decision, dict)
    or decision.get('allowed') is not True
):
    ${fixedPortableApprovalReceipt("rejected")}
    raise SystemExit(0)

approve_env = gateway_approval_env(os.environ)
approve_env.pop('NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING', None)
approve_env.pop('NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT', None)
approve_env.pop('NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING', None)
try:
    approved = subprocess.run(
        [OPENCLAW, 'devices', 'approve', request_id, '--json'],
        capture_output=True, text=True, timeout=${CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S},
        env=approve_env,
    )
except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
    ${fixedPortableApprovalReceipt("ambiguous")}
    raise SystemExit(0)
${fixedPortableApprovalReceipt("approved")} if approved.returncode == 0 else ${fixedPortableApprovalReceipt("ambiguous")}
PYAPPROVE
exit 0
`;
}

/** Run the canonical request producer once; all command output remains in the sandbox. */
export function runPortableOpenClawPairingRequestProducer(
  sandboxName: string,
  gatewayName: string,
  execDeps?: AutoPairApprovalExecDeps,
): void {
  const script = `
${buildTrustedProxyEnvSourceShell()}
command -v openclaw >/dev/null 2>&1 || exit 0
NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING=1 \\
  openclaw agent --agent main -m "ping" \\
  --session-id "${WARMUP_SESSION_ID_PREFIX}$$-$(date +%s)" >/dev/null 2>&1 || true
exit 0
`;
  const deps =
    execDeps ??
    (() => {
      const { getOpenshellBinary } =
        require("../../adapters/openshell/runtime") as typeof import("../../adapters/openshell/runtime");
      return { getOpenshellBinary, spawnSync };
    })();
  try {
    deps.spawnSync(
      deps.getOpenshellBinary(),
      ["sandbox", "exec", "--name", sandboxName, "-g", gatewayName, "--", "sh", "-s"],
      {
        cwd: ROOT,
        env: process.env,
        input: script,
        encoding: "utf8",
        stdio: ["pipe", "ignore", "ignore"],
        timeout: PORTABLE_PAIRING_PRODUCER_TIMEOUT_MS,
      },
    );
  } catch {
    // The strict approval and final observation classify producer failure.
  }
}

/** Invoke at most one canonical `openclaw devices approve` command. */
export function runPortableOpenClawPairingApproval(
  sandboxName: string,
  gatewayName: string,
  expectedDeviceIdentitySha256: string,
  execDeps?: AutoPairApprovalExecDeps,
): PortableOpenClawPairingApprovalReceipt {
  const approvalPolicy = readAutoPairApprovalPolicyModule();
  if (!approvalPolicy) return "unavailable";
  let script: string;
  try {
    script = buildPortableOpenClawPairingApprovalScript(
      Buffer.from(approvalPolicy, "utf8").toString("base64"),
      expectedDeviceIdentitySha256,
    );
  } catch {
    return "unavailable";
  }
  const deps =
    execDeps ??
    (() => {
      const { getOpenshellBinary } =
        require("../../adapters/openshell/runtime") as typeof import("../../adapters/openshell/runtime");
      return { getOpenshellBinary, spawnSync };
    })();
  try {
    const result = deps.spawnSync(
      deps.getOpenshellBinary(),
      ["sandbox", "exec", "--name", sandboxName, "-g", gatewayName, "--", "sh", "-s"],
      {
        cwd: ROOT,
        env: process.env,
        input: script,
        encoding: "utf8",
        maxBuffer: PORTABLE_PAIRING_APPROVAL_MAX_OUTPUT_BYTES,
        stdio: ["pipe", "pipe", "ignore"],
        timeout: CONNECT_AUTO_PAIR_TIMEOUT_MS,
      },
    );
    if (result.error || result.signal || result.status !== 0) return "ambiguous";
    return parsePortableOpenClawPairingApprovalReceipt(String(result.stdout ?? "")) ?? "ambiguous";
  } catch {
    return "ambiguous";
  }
}
