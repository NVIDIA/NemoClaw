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
 * resolve. The sourced runtime environment makes the list call inspect the
 * same live gateway through local loopback, while the approval call also
 * strips OPENCLAW_GATEWAY_URL/PORT/TOKEN from the child env. The reviewed dist
 * patch then forces OpenClaw's existing local-only stored-device-auth path for
 * the exact bounded self-repair shape so a shared token reloaded from config
 * cannot take precedence. Remove this compatibility path when OpenClaw can
 * complete scope upgrades natively through device-token auth using
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
  /** Fixed clone-only diagnostic; never contains command output or identifiers. */
  receipt: AutoPairApprovalReceipt | null;
};

export type AutoPairApprovalReceipt =
  | "policy-missing"
  | "exec-failed"
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
  /^__NEMOCLAW_AUTO_PAIR_RECEIPT__=(policy-missing|exec-failed|list-timeout|list-exec-failed|list-scope-upgrade-pending|list-device-pairing-required|list-gateway-connect-failed|list-command-failed|list-empty-output|list-invalid-json|list-invalid-output|list-missing-pending|clone-no-match|clone-ambiguous|request-rejected|approve-failed|approved-one)$/;

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
    ? options.localDeviceOnly
      ? `        else:
            if reconcile_completed_local_approval(device):
                approved_count += 1
            else:
                exit_with_receipt('approve-failed')
`
      : "        else:\n            exit_with_receipt('approve-failed')\n"
    : "";
  const failedApproveAction = options.emitReceipt
    ? "exit_with_receipt('approve-failed')"
    : "continue";
  const approveExceptionHandler =
    options.emitReceipt && options.localDeviceOnly
      ? `    except subprocess.TimeoutExpired:
        # The canonical transition can finish while this competing approval
        # process is still waiting. Never retry it. Accept only the exact
        # rotated state published for this clone and synchronize that bounded
        # credential before the caller restarts the gateway.
        if reconcile_completed_local_approval(device):
            approved_count += 1
        else:
            exit_with_receipt('approve-failed')
    except (FileNotFoundError, OSError):
        exit_with_receipt('approve-failed')
`
      : `    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        ${failedApproveAction}
`;
  const maxApprovals = options.budget?.maxApprovals ?? AUTO_PAIR_MAX_APPROVALS;
  const listTimeoutS = options.budget?.listTimeoutS ?? AUTO_PAIR_LIST_TIMEOUT_S;
  const approveTimeoutS = options.budget?.approveTimeoutS ?? AUTO_PAIR_APPROVE_TIMEOUT_S;
  const gatedListHelper = options.localDeviceOnly
    ? `
# A restored clone can create an exact pending request while its device-list
# call is denied or blocked by that same pairing or scope-upgrade gate. Read
# local state only to recover candidates for the identity/scope filter below.
# Canonical OpenClaw approval remains the only writer. This matches the reviewed
# first-run watcher boundary in scripts/nemoclaw-start.sh (#7818).
# Delete this fallback once pinned OpenClaw returns pending entries before the
# authenticated devices list fails or times out.
def local_pending_after_gated_list():
    state_dir = os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw'
    pending_path = os.path.join(state_dir, 'devices', 'pending.json')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = -1
    try:
        import stat
        fd = os.open(pending_path, flags)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        with os.fdopen(fd, encoding='utf-8') as handle:
            fd = -1
            local_pending = json.load(handle)
    except (OSError, ValueError):
        return None
    finally:
        if fd >= 0:
            os.close(fd)
    if not isinstance(local_pending, dict):
        return None
    candidates = []
    for request_id, request in local_pending.items():
        if (
            not isinstance(request_id, str)
            or not isinstance(request, dict)
            or request.get('requestId') != request_id
        ):
            return None
        candidates.append(request)
    return candidates
`
    : "";
  const gatedListAction = (receipt: AutoPairApprovalReceipt) =>
    options.localDeviceOnly
      ? `pending = local_pending_after_gated_list()
        if pending is None:
            ${exitWithReceipt("list-missing-pending")}`
      : exitWithReceipt(receipt);
  const timedOutListAction = options.localDeviceOnly
    ? `pending = local_pending_after_gated_list()
    if not pending:
        ${exitWithReceipt("list-timeout")}
    proc = subprocess.CompletedProcess(
        [OPENCLAW, 'devices', 'list', '--json'],
        0,
        stdout=json.dumps({'pending': pending}),
        stderr='',
    )`
    : exitWithReceipt("list-timeout");
  const localDeviceFilter = options.localDeviceOnly
    ? `
# Snapshot restore shares one gateway across the source sandbox and its clone.
# Select exactly one pending CLI transition whose device identity matches the
# clone executing this script. Ambiguous or malformed state approves nothing;
# OpenClaw remains the only writer through the canonical approve command.
import binascii
import hashlib
import re
import stat
import time

REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')
ALLOWED_LOCAL_SCOPES = {'operator.pairing', 'operator.read', 'operator.write'}

state_dir = os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw'
state_dir_real = os.path.realpath(state_dir)

def clone_state_path(*parts):
    candidate = os.path.join(state_dir, *parts)
    parent_real = os.path.realpath(os.path.dirname(candidate))
    if os.path.commonpath((state_dir_real, parent_real)) != state_dir_real:
        raise OSError('clone state path escaped its root')
    return candidate

def read_clone_json(path):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError('clone state entry is not a regular file')
        with os.fdopen(fd, encoding='utf-8') as handle:
            fd = -1
            return json.load(handle)
    finally:
        if fd >= 0:
            os.close(fd)

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

def consistent_scope_view(device):
    if 'scopes' not in device or 'requestedScopes' in device:
        return None
    views = []
    for key in ('scopes', 'requestedScopes'):
        if key not in device:
            continue
        raw_scopes = device.get(key)
        if not isinstance(raw_scopes, list) or not raw_scopes:
            return None
        scopes = []
        for scope in raw_scopes:
            if not isinstance(scope, str) or not scope.strip():
                return None
            scopes.append(scope.strip())
        if len(scopes) != len(set(scopes)) or not set(scopes).issubset(ALLOWED_LOCAL_SCOPES):
            return None
        views.append(set(scopes))
    if not views or any(view != views[0] for view in views[1:]):
        return None
    return views[0]

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
    if not token or scopes is None:
        return None
    return token, scopes

try:
    local_identity = read_clone_json(clone_state_path('identity', 'device.json'))
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

# Capture only an exact pairing-scoped clone baseline. This lets the failure
# path distinguish a canonical approval completed by the competing startup
# watcher from an arbitrary failed command. The source sandbox's auth state is
# never consulted.
local_previous_operator_token = ''
try:
    paired_before = read_clone_json(clone_state_path('devices', 'paired.json'))
    auth_before = read_clone_json(clone_state_path('identity', 'device-auth.json'))
except FileNotFoundError:
    paired_before = {}
    auth_before = {}
except (OSError, ValueError):
    ${exitWithReceipt("request-rejected")}
if not isinstance(paired_before, dict) or not isinstance(auth_before, dict):
    ${exitWithReceipt("request-rejected")}
related_paired_before = [
    (map_key, device) for map_key, device in paired_before.items()
    if map_key == local_device_id or (
        isinstance(device, dict) and (
            str(device.get('deviceId', '') or '').strip() == local_device_id
            or str(device.get('publicKey', '') or '').strip() == local_public_key
        )
    )
]
if len(related_paired_before) > 1:
    ${exitWithReceipt("request-rejected")}
if len(related_paired_before) == 1:
    paired_map_key, local_paired_before = related_paired_before[0]
    paired_credential_before = (
        paired_operator_credential(local_paired_before)
        if isinstance(local_paired_before, dict)
        else None
    )
    auth_credential_before = paired_operator_credential(auth_before)
    if (
        paired_map_key == local_device_id
        and isinstance(local_paired_before, dict)
        and str(local_paired_before.get('deviceId', '') or '').strip() == local_device_id
        and str(local_paired_before.get('publicKey', '') or '').strip() == local_public_key
        and normalized_roles(local_paired_before) == {'operator'}
        and bounded_scope_set(local_paired_before.get('scopes')) == {'operator.pairing'}
        and bounded_scope_set(local_paired_before.get('approvedScopes')) == {'operator.pairing'}
        and paired_credential_before is not None
        and paired_credential_before[1] == {'operator.pairing'}
        and auth_before.get('version') == 1
        and str(auth_before.get('deviceId', '') or '').strip() == local_device_id
        and auth_credential_before == paired_credential_before
    ):
        local_previous_operator_token = paired_credential_before[0]

def reconcile_completed_local_approval(request):
    previous_token = local_previous_operator_token
    request_scopes = consistent_scope_view(request)
    if not previous_token or request_scopes is None or 'operator.write' not in request_scopes:
        return False
    try:
        pending_after = read_clone_json(clone_state_path('devices', 'pending.json'))
        paired_after = read_clone_json(clone_state_path('devices', 'paired.json'))
    except (OSError, ValueError):
        return False
    if not isinstance(pending_after, dict) or not isinstance(paired_after, dict):
        return False
    request_id = request.get('requestId')
    if request_id in pending_after:
        return False
    related_pending_after = [
        device for device in pending_after.values()
        if isinstance(device, dict) and (
            str(device.get('deviceId', '') or '').strip() == local_device_id
            or str(device.get('publicKey', '') or '').strip() == local_public_key
        )
    ]
    if related_pending_after:
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

    dir_fd = -1
    temp_name = ''
    try:
        auth_path = clone_state_path('identity', 'device-auth.json')
        auth_dir = os.path.dirname(auth_path)
        dir_flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
        dir_fd = os.open(auth_dir, dir_flags)
        if not stat.S_ISDIR(os.fstat(dir_fd).st_mode):
            return False
        try:
            auth_stat = os.stat('device-auth.json', dir_fd=dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            auth_stat = None
        if auth_stat is not None and not stat.S_ISREG(auth_stat.st_mode):
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
            | getattr(os, 'O_NOFOLLOW', 0)
        )
        fd = os.open(temp_name, temp_flags, 0o600, dir_fd=dir_fd)
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
                src_dir_fd=dir_fd,
                dst_dir_fd=dir_fd,
            )
            temp_name = ''
            os.fsync(dir_fd)
        finally:
            if fd >= 0:
                os.close(fd)
    except (OSError, ValueError):
        return False
    finally:
        if temp_name and dir_fd >= 0:
            try:
                os.unlink(temp_name, dir_fd=dir_fd)
            except FileNotFoundError:
                pass
        if dir_fd >= 0:
            os.close(dir_fd)
    return True

def is_local_pairing_transition(device):
    request_id = device.get('requestId')
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        return False
    if str(device.get('deviceId', '') or '').strip() != local_device_id:
        return False
    if str(device.get('publicKey', '') or '').strip() != local_public_key:
        return False
    if str(device.get('clientId', '') or '').strip() != 'cli':
        return False
    if str(device.get('clientMode', '') or '').strip() != 'cli':
        return False
    if normalized_roles(device) != {'operator'}:
        return False
    scopes = consistent_scope_view(device)
    if scopes is None:
        return False
    is_repair = device.get('isRepair')
    if is_repair is True:
        return 'operator.write' in scopes
    if is_repair not in (None, False):
        return False
    return scopes == {'operator.pairing'} or 'operator.write' in scopes

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
if not is_local_pairing_transition(related_pending[0]):
    ${exitWithReceipt("request-rejected")}
local_request_id = related_pending[0].get('requestId')
if sum(
    1 for device in pending
    if isinstance(device, dict) and device.get('requestId') == local_request_id
) != 1:
    ${exitWithReceipt("clone-ambiguous")}
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
${gatedListHelper}
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

try:
    proc = subprocess.run(
        [OPENCLAW, 'devices', 'list', '--json'],
        capture_output=True, text=True, timeout=${listTimeoutS},
    )
except subprocess.TimeoutExpired:
    ${timedOutListAction}
except (FileNotFoundError, OSError):
    ${exitWithReceipt("list-exec-failed")}
if proc.returncode != 0:
    command_output = f'{proc.stdout}\\n{proc.stderr}'.lower()
    if (
        'scope upgrade pending approval' in command_output
        or 'pairing required: device is asking for more scopes' in command_output
    ):
        ${gatedListAction("list-scope-upgrade-pending")}
    elif 'device pairing required' in command_output or 'pairing required' in command_output:
        ${gatedListAction("list-device-pairing-required")}
    elif 'gateway connect failed' in command_output:
        ${exitWithReceipt("list-gateway-connect-failed")}
    else:
        ${exitWithReceipt("list-command-failed")}
else:
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
        ${exitWithReceipt("list-missing-pending")}${localDeviceFilter}
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
    approve_env = gateway_approval_env(os.environ)
    attempted_count += 1
    try:
        approve_proc = subprocess.run(
            [OPENCLAW, 'devices', 'approve', request_id, '--json'],
            capture_output=True, text=True, timeout=${approveTimeoutS}, env=approve_env,
        )
        if approve_proc.returncode == 0:
            approved_count += 1
${failedApproveBranch}${approveExceptionHandler}
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
  } = {},
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
  const { getOpenshellBinary } =
    require("../../adapters/openshell/runtime") as typeof import("../../adapters/openshell/runtime");
  try {
    const result = spawnSync(
      getOpenshellBinary(),
      ["sandbox", "exec", "--name", sandboxName, "--", "sh", "-c", script],
      {
        cwd: ROOT,
        env: process.env,
        stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"],
        encoding: "utf-8",
        timeout: outerTimeoutMs,
      },
    );
    const output = String(result.stdout || "");
    const receipt: AutoPairApprovalReceipt | null = !emitReceipt
      ? null
      : result.error || result.status !== 0 || result.signal
        ? "exec-failed"
        : (parseAutoPairApprovalReceipt(output) ?? "exec-failed");
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
