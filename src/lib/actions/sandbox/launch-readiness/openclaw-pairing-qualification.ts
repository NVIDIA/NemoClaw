// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import { resolveOpenshellBinary } from "../../../adapters/openshell/command-argv";
import type { LaunchReadinessOpenClawSessionQualification } from "../../../state/launch-readiness-lease";
import { ROOT } from "../../../state/paths";
import { readAutoPairApprovalPolicyModule } from "../auto-pair-approval";

const QUALIFICATION_MARKER = "__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=";
const SETTLEMENT_MARKER = "__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=";
const SHA256_RE = /^[a-f0-9]{64}$/;
const OBSERVATION_TIMEOUT_MS = 3_000;
const OBSERVATION_MAX_OUTPUT_BYTES = 4 * 1_024;

export const OPENCLAW_PAIRING_REQUIRED_ROLES = ["operator"] as const;
// Canonical approval preserves the requested pairing/write view on the paired
// record and adds the implied read scope only to credential-bearing token views.
export const OPENCLAW_PAIRING_REQUEST_SCOPES = ["operator.pairing", "operator.write"] as const;
export const OPENCLAW_PAIRING_REQUIRED_SCOPES = [
  "operator.pairing",
  "operator.read",
  "operator.write",
] as const;

export type OpenClawPairingQualification = LaunchReadinessOpenClawSessionQualification;

export type OpenClawPairingSettlementObservation = {
  readonly state: "pairing-only" | "settled";
  readonly deviceIdentitySha256: string;
};

interface ObservationProjection {
  deviceIdentitySha256: string;
  pairingStateSha256: string;
  requiredRoles: ["operator"];
  requiredScopes: ["operator.pairing", "operator.read", "operator.write"];
}

interface OpenClawPairingQualificationDeps {
  getOpenshellBinary: () => string;
  readApprovalPolicy: () => string | null;
  spawnSync: typeof spawnSync;
}

export class OpenClawPairingQualificationError extends Error {
  constructor() {
    super("OpenClaw pairing qualification is unavailable.");
    this.name = "OpenClawPairingQualificationError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

export function parseOpenClawPairingObservation(output: string): ObservationProjection | null {
  const lines = output.trimEnd().split(/\r?\n/);
  const markerLines = lines.filter((line) => line.startsWith(QUALIFICATION_MARKER));
  if (markerLines.length !== 1 || lines.at(-1) !== markerLines[0]) return null;
  let value: unknown;
  try {
    value = JSON.parse(markerLines[0]!.slice(QUALIFICATION_MARKER.length)) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "deviceIdentitySha256",
      "pairingStateSha256",
      "requiredRoles",
      "requiredScopes",
    ]) ||
    typeof record.deviceIdentitySha256 !== "string" ||
    !SHA256_RE.test(record.deviceIdentitySha256) ||
    typeof record.pairingStateSha256 !== "string" ||
    !SHA256_RE.test(record.pairingStateSha256) ||
    !isExactStringArray(record.requiredRoles, OPENCLAW_PAIRING_REQUIRED_ROLES) ||
    !isExactStringArray(record.requiredScopes, OPENCLAW_PAIRING_REQUIRED_SCOPES)
  ) {
    return null;
  }
  return record as unknown as ObservationProjection;
}

export function parseOpenClawPairingSettlementObservation(
  output: string,
): OpenClawPairingSettlementObservation | null {
  const lines = output.trimEnd().split(/\r?\n/);
  const markerLines = lines.filter((line) => line.startsWith(SETTLEMENT_MARKER));
  if (markerLines.length !== 1 || lines.at(-1) !== markerLines[0]) return null;
  let value: unknown;
  try {
    value = JSON.parse(markerLines[0]!.slice(SETTLEMENT_MARKER.length)) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["deviceIdentitySha256", "state"]) ||
    typeof record.deviceIdentitySha256 !== "string" ||
    !SHA256_RE.test(record.deviceIdentitySha256) ||
    (record.state !== "pairing-only" && record.state !== "settled")
  ) {
    return null;
  }
  return record as OpenClawPairingSettlementObservation;
}

export function buildOpenClawPairingObservationScript(
  approvalPolicyModuleB64: string,
  stateDirectory: string,
  mode: "ordinary-settlement" | "qualification" | "settlement" = "qualification",
): string {
  if (!path.posix.isAbsolute(stateDirectory)) {
    throw new OpenClawPairingQualificationError();
  }
  if (
    !approvalPolicyModuleB64 ||
    Buffer.from(approvalPolicyModuleB64, "base64").toString("base64") !== approvalPolicyModuleB64
  ) {
    throw new OpenClawPairingQualificationError();
  }
  const stateDirectoryB64 = Buffer.from(stateDirectory, "utf8").toString("base64");
  const marker = mode === "qualification" ? QUALIFICATION_MARKER : SETTLEMENT_MARKER;
  // OpenClaw owns these in-sandbox state files. This observer reads
  // descriptor-pinned state through the requested gateway and returns only
  // allowlisted fields and digests. Pairing changes remain owned by the
  // canonical OpenClaw request producer and approval command.
  return `
command -v python3 >/dev/null 2>&1 || exit 1
NEMOCLAW_APPROVAL_POLICY_B64='${approvalPolicyModuleB64}' \
NEMOCLAW_OPENCLAW_STATE_DIR_B64='${stateDirectoryB64}' \
python3 - <<'PYQUALIFY'
import base64
import binascii
import hashlib
import json
import os
import re
import stat
import sys

MARKER = ${JSON.stringify(marker)}
MAX_ENTRY_BYTES = 512 * 1024
REQUIRED_ROLES = ['operator']
PAIRING_ONLY_SCOPES = ['operator.pairing']
REQUEST_SCOPES = ['operator.pairing', 'operator.write']
TOKEN_SCOPES = ['operator.pairing', 'operator.read', 'operator.write']
ORDINARY_SETTLEMENT = ${mode === "ordinary-settlement" ? "True" : "False"}
STRICT_SETTLEMENT = ${mode === "settlement" ? "True" : "False"}
ED25519_SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')
RAW_PUBLIC_KEY_RE = re.compile(r'^[A-Za-z0-9_-]{43}$')

def reject():
    sys.exit(1)

try:
    policy_source = base64.b64decode(
        os.environ.get('NEMOCLAW_APPROVAL_POLICY_B64', ''), validate=True,
    ).decode('utf-8')
    STATE_DIR = base64.b64decode(
        os.environ.get('NEMOCLAW_OPENCLAW_STATE_DIR_B64', ''), validate=True,
    ).decode('utf-8')
    policy_globals = {}
    exec(compile(policy_source, 'openclaw_device_approval_policy.py', 'exec'), policy_globals)
    approval_request_decision = policy_globals['approval_request_decision']
except Exception:
    reject()

if not os.path.isabs(STATE_DIR):
    reject()
for required_flag in ('O_DIRECTORY', 'O_NOFOLLOW'):
    if not hasattr(os, required_flag):
        reject()

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)
path_flags = getattr(os, 'O_PATH', os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)
file_flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NONBLOCK', 0)

def directory_metadata(fd):
    metadata = os.fstat(fd)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_gid != os.getegid()
        or metadata.st_mode & 0o002
    ):
        raise OSError('unsafe directory')
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_mode & 0o7777,
    )

def file_metadata(fd):
    metadata = os.fstat(fd)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_gid != os.getegid()
        or metadata.st_mode & 0o007
        or metadata.st_size < 1
        or metadata.st_size > MAX_ENTRY_BYTES
    ):
        raise OSError('unsafe file')
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_mode & 0o7777,
    )

def state_root_is_current(fd):
    current = os.stat(STATE_DIR, follow_symlinks=False)
    pinned = os.fstat(fd)
    return (
        stat.S_ISDIR(current.st_mode)
        and (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino)
    )

def open_state_root():
    root_fd = os.open(os.sep, path_flags)
    try:
        for component in (part for part in STATE_DIR.split(os.sep) if part):
            if component in ('.', '..'):
                raise OSError('unsafe state path')
            next_fd = os.open(component, path_flags, dir_fd=root_fd)
            os.close(root_fd)
            root_fd = next_fd
        directory_metadata(root_fd)
        if not state_root_is_current(root_fd):
            raise OSError('state root changed')
        return root_fd
    except Exception:
        os.close(root_fd)
        raise

def directory_is_current(parent_fd, name, fd):
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    pinned = os.fstat(fd)
    return (
        stat.S_ISDIR(current.st_mode)
        and (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino)
    )

def open_directory(parent_fd, name):
    if name not in ('devices', 'identity'):
        raise OSError('unsupported directory')
    fd = os.open(name, directory_flags, dir_fd=parent_fd)
    directory_metadata(fd)
    if not directory_is_current(parent_fd, name, fd):
        os.close(fd)
        raise OSError('directory changed')
    return fd

def read_entry(directory_fd, name):
    if not name or name in ('.', '..') or os.sep in name:
        raise OSError('unsafe entry')
    fd = os.open(name, file_flags, dir_fd=directory_fd)
    try:
        before = file_metadata(fd)
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, min(64 * 1024, MAX_ENTRY_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_ENTRY_BYTES:
                raise OSError('entry too large')
        after = file_metadata(fd)
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if before != after or (
            current.st_dev,
            current.st_ino,
            current.st_uid,
            current.st_gid,
            current.st_size,
            current.st_mtime_ns,
            current.st_mode & 0o7777,
        ) != after:
            raise OSError('entry changed')
        return b''.join(chunks), after
    finally:
        os.close(fd)

def read_snapshot():
    state_fd = open_state_root()
    devices_fd = -1
    identity_fd = -1
    try:
        devices_fd = open_directory(state_fd, 'devices')
        identity_fd = open_directory(state_fd, 'identity')
        identity_raw, identity_metadata = read_entry(identity_fd, 'device.json')
        auth_raw, auth_metadata = read_entry(identity_fd, 'device-auth.json')
        paired_raw, paired_metadata = read_entry(devices_fd, 'paired.json')
        pending_raw, pending_metadata = read_entry(devices_fd, 'pending.json')
        if (
            not state_root_is_current(state_fd)
            or not directory_is_current(state_fd, 'devices', devices_fd)
            or not directory_is_current(state_fd, 'identity', identity_fd)
        ):
            raise OSError('state root changed')
        return {
            'directories': [directory_metadata(state_fd), directory_metadata(devices_fd), directory_metadata(identity_fd)],
            'identity': (identity_raw, identity_metadata),
            'auth': (auth_raw, auth_metadata),
            'paired': (paired_raw, paired_metadata),
            'pending': (pending_raw, pending_metadata),
        }
    finally:
        if identity_fd >= 0:
            os.close(identity_fd)
        if devices_fd >= 0:
            os.close(devices_fd)
        os.close(state_fd)

def parse_json(raw):
    value = json.loads(raw.decode('utf-8'))
    if not isinstance(value, dict):
        raise ValueError('expected object')
    return value

def public_key(identity):
    raw_value = identity.get('publicKey')
    raw = ''
    if raw_value is not None:
        if not isinstance(raw_value, str) or not RAW_PUBLIC_KEY_RE.fullmatch(raw_value):
            return ''
        raw_bytes = base64.urlsafe_b64decode(raw_value + '=')
        if len(raw_bytes) != 32 or base64.urlsafe_b64encode(raw_bytes).decode('ascii').rstrip('=') != raw_value:
            return ''
        raw = raw_value

    pem_value = identity.get('publicKeyPem')
    pem_key = ''
    if pem_value is not None:
        if not isinstance(pem_value, str):
            return ''
        match = re.fullmatch(
            r'-----BEGIN PUBLIC KEY-----\\n([A-Za-z0-9+/]{59}=)\\n-----END PUBLIC KEY-----\\n',
            pem_value,
        )
        if not match:
            return ''
        der = base64.b64decode(match.group(1), validate=True)
        if len(der) != 44 or not der.startswith(ED25519_SPKI_PREFIX):
            return ''
        pem_key = base64.urlsafe_b64encode(der[len(ED25519_SPKI_PREFIX):]).decode('ascii').rstrip('=')
    if not raw and not pem_key:
        return ''
    if raw and pem_key and raw != pem_key:
        return ''
    return raw or pem_key

def exact_string_set(value, expected):
    return (
        isinstance(value, list)
        and all(isinstance(entry, str) and entry for entry in value)
        and len(value) == len(set(value))
        and set(value) == set(expected)
    )

def normalized_roles(device):
    roles = set()
    if device.get('role') is not None:
        if not isinstance(device.get('role'), str) or not device.get('role'):
            return None
        roles.add(device.get('role'))
    if device.get('roles') is not None:
        raw_roles = device.get('roles')
        if (
            not isinstance(raw_roles, list)
            or not all(isinstance(role, str) and role for role in raw_roles)
            or len(raw_roles) != len(set(raw_roles))
        ):
            return None
        roles.update(raw_roles)
    return roles

try:
    first = read_snapshot()
    second = read_snapshot()
    if first != second:
        reject()
    identity = parse_json(first['identity'][0])
    auth = parse_json(first['auth'][0])
    paired = parse_json(first['paired'][0])
    pending = parse_json(first['pending'][0])
    device_id = identity.get('deviceId')
    device_public_key = public_key(identity)
    public_key_raw = base64.urlsafe_b64decode(device_public_key + '=' * (-len(device_public_key) % 4))
    if (
        not isinstance(device_id, str)
        or not re.fullmatch(r'[a-f0-9]{64}', device_id)
        or len(public_key_raw) != 32
        or hashlib.sha256(public_key_raw).hexdigest() != device_id
    ):
        reject()

    local_paired = [
        (map_key, device) for map_key, device in paired.items()
        if map_key == device_id or (
            isinstance(device, dict) and (
                device.get('deviceId') == device_id
                or device.get('publicKey') == device_public_key
            )
        )
    ]
    if len(local_paired) != 1:
        reject()
    map_key, paired_device = local_paired[0]
    if (
        map_key != device_id
        or not isinstance(paired_device, dict)
        or paired_device.get('deviceId') != device_id
        or paired_device.get('publicKey') != device_public_key
        or paired_device.get('clientId') != 'cli'
        or paired_device.get('clientMode') != 'cli'
        or paired_device.get('role') != 'operator'
        or not exact_string_set(paired_device.get('roles'), REQUIRED_ROLES)
        or 'requestedScopes' in paired_device
        or 'publicKeyPem' in paired_device
    ):
        reject()
    paired_tokens = paired_device.get('tokens')
    paired_operator = paired_tokens.get('operator') if isinstance(paired_tokens, dict) and set(paired_tokens) == {'operator'} else None
    if (
        not isinstance(paired_operator, dict)
        or paired_operator.get('role') != 'operator'
        or paired_operator.get('revokedAtMs') is not None
        or not isinstance(paired_operator.get('token'), str)
        or not paired_operator.get('token')
        or paired_operator.get('token').strip() != paired_operator.get('token')
        or any(alias in paired_operator for alias in ('requestedScopes', 'approvedScopes', 'roles'))
    ):
        reject()
    auth_tokens = auth.get('tokens')
    auth_operator = auth_tokens.get('operator') if isinstance(auth_tokens, dict) and set(auth_tokens) == {'operator'} else None
    if (
        type(auth.get('version')) is not int
        or auth.get('version') != 1
        or auth.get('deviceId') != device_id
        or not isinstance(auth_operator, dict)
        or auth_operator.get('role') != 'operator'
        or auth_operator.get('revokedAtMs') is not None
        or not isinstance(auth_operator.get('token'), str)
        or auth_operator.get('token') != paired_operator.get('token')
        or any(alias in auth_operator for alias in ('requestedScopes', 'approvedScopes', 'roles'))
    ):
        reject()

    if STRICT_SETTLEMENT and pending:
        reject()
    for request_id, request in pending.items():
        if (
            not isinstance(request_id, str)
            or not request_id
            or not isinstance(request, dict)
            or request.get('requestId') != request_id
        ):
            reject()
        if ORDINARY_SETTLEMENT:
            # The startup watcher can publish the canonical write transition
            # before finalization observes the pairing-only device. Admit only
            # that exact intermediate state so the owning controller can reach
            # its one approval pass. Its final observation still requires the
            # settled scopes and no same-device pending request.
            decision = approval_request_decision(request)
            request_scopes = request.get('scopes')
            valid_write_scopes = (
                exact_string_set(request_scopes, ['operator.write'])
                or exact_string_set(request_scopes, REQUEST_SCOPES)
            )
            if (
                request.get('deviceId') != device_id
                or request.get('publicKey') != device_public_key
                or request.get('clientId') != 'cli'
                or request.get('clientMode') != 'cli'
                or request.get('role') != 'operator'
                or not exact_string_set(request.get('roles'), REQUIRED_ROLES)
                or 'requestedScopes' in request
                or 'publicKeyPem' in request
                or type(request.get('isRepair')) is not bool
                or not valid_write_scopes
                or not isinstance(decision, dict)
                or decision.get('allowed') is not True
            ):
                reject()
            continue
        decision = approval_request_decision(request)
        if decision.get('reason') == 'malformed-scopes':
            reject()
        if decision.get('allowed'):
            sys.exit(2)

    for map_key, device in paired.items():
        if not isinstance(map_key, str) or not map_key or not isinstance(device, dict):
            reject()
        if not isinstance(device.get('deviceId'), str) or not device.get('deviceId'):
            reject()
        if normalized_roles(device) is None:
            reject()

    settled = (
        exact_string_set(paired_device.get('scopes'), REQUEST_SCOPES)
        and exact_string_set(paired_device.get('approvedScopes'), REQUEST_SCOPES)
        and exact_string_set(paired_operator.get('scopes'), TOKEN_SCOPES)
        and exact_string_set(auth_operator.get('scopes'), TOKEN_SCOPES)
    )
    pairing_only = (
        exact_string_set(paired_device.get('scopes'), PAIRING_ONLY_SCOPES)
        and exact_string_set(paired_device.get('approvedScopes'), PAIRING_ONLY_SCOPES)
        and exact_string_set(paired_operator.get('scopes'), PAIRING_ONLY_SCOPES)
        and exact_string_set(auth_operator.get('scopes'), PAIRING_ONLY_SCOPES)
    )
    if ORDINARY_SETTLEMENT and pending and (len(pending) != 1 or not pairing_only):
        reject()
    if not settled and not pairing_only:
        reject()

    device_identity_sha256 = hashlib.sha256(json.dumps({
        'deviceId': device_id,
        'publicKey': device_public_key,
    }, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
    ${
      mode !== "qualification"
        ? "print(MARKER + json.dumps({\n        'deviceIdentitySha256': device_identity_sha256,\n        'state': 'settled' if settled else 'pairing-only',\n    }, sort_keys=True, separators=(',', ':')))\n    sys.exit(0)"
        : "if not settled:\n        reject()"
    }

    projection = {
        'deviceIdentitySha256': device_identity_sha256,
        # Bind only the allowlisted security projection. Token values, unknown
        # device state, and pending-request fields never contribute a reusable
        # credential oracle outside the sandbox.
        'pairingStateSha256': hashlib.sha256(json.dumps({
            'deviceId': device_id,
            'publicKey': device_public_key,
            'clientId': 'cli',
            'clientMode': 'cli',
            'roles': REQUIRED_ROLES,
            'pairedRequestScopes': REQUEST_SCOPES,
            'approvedRequestScopes': REQUEST_SCOPES,
            'pairedToken': {
                'active': True,
                'role': 'operator',
                'scopes': TOKEN_SCOPES,
            },
            'clientAuth': {
                'deviceId': device_id,
                'matchesPairedToken': True,
                'role': 'operator',
                'scopes': TOKEN_SCOPES,
                'version': 1,
            },
            'relevantPending': False,
        }, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest(),
        'requiredRoles': REQUIRED_ROLES,
        'requiredScopes': TOKEN_SCOPES,
    }
    print(MARKER + json.dumps(projection, sort_keys=True, separators=(',', ':')))
except (OSError, ValueError, TypeError, KeyError, binascii.Error, UnicodeError):
    reject()
PYQUALIFY
`;
}

function recordQualificationStage(startedAt: number): void {
  try {
    performance.measure("nemoclaw.openclaw-pairing.qualification", {
      start: startedAt,
      end: performance.now(),
    });
  } catch {
    // Performance measurements never control pairing qualification.
  }
}

function runOpenClawPairingObservation(
  sandboxName: string,
  gatewayName: string,
  openclawVersion: string,
  stateDirectory: string,
  mode: "ordinary-settlement" | "qualification" | "settlement",
  execDeps?: Partial<OpenClawPairingQualificationDeps>,
): { readonly output: string; readonly policy: string } {
  const approvalPolicy = (execDeps?.readApprovalPolicy ?? readAutoPairApprovalPolicyModule)();
  const normalizedVersion = openclawVersion.trim();
  if (
    !approvalPolicy ||
    normalizedVersion.length > 128 ||
    (mode === "qualification" && !normalizedVersion)
  ) {
    throw new OpenClawPairingQualificationError();
  }
  const approvalPolicyModuleB64 = Buffer.from(approvalPolicy, "utf8").toString("base64");
  const script = buildOpenClawPairingObservationScript(
    approvalPolicyModuleB64,
    stateDirectory,
    mode,
  );
  const deps = {
    getOpenshellBinary: execDeps?.getOpenshellBinary ?? resolveOpenshellBinary,
    spawnSync: execDeps?.spawnSync ?? spawnSync,
  };
  const result = deps.spawnSync(
    deps.getOpenshellBinary(),
    ["sandbox", "exec", "--name", sandboxName, "-g", gatewayName, "--", "sh", "-s"],
    {
      cwd: ROOT,
      env: process.env,
      input: script,
      encoding: "utf8",
      maxBuffer: OBSERVATION_MAX_OUTPUT_BYTES,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: OBSERVATION_TIMEOUT_MS,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new OpenClawPairingQualificationError();
  }
  return { output: String(result.stdout ?? ""), policy: approvalPolicy };
}

export function observeOpenClawPairingSettlement(
  sandboxName: string,
  gatewayName: string,
  openclawVersion: string,
  stateDirectory: string,
  execDeps?: Partial<OpenClawPairingQualificationDeps>,
): OpenClawPairingSettlementObservation {
  try {
    const executed = runOpenClawPairingObservation(
      sandboxName,
      gatewayName,
      openclawVersion,
      stateDirectory,
      "settlement",
      execDeps,
    );
    const observation = parseOpenClawPairingSettlementObservation(executed.output);
    if (!observation) throw new OpenClawPairingQualificationError();
    return observation;
  } catch (error) {
    if (error instanceof OpenClawPairingQualificationError) throw error;
    throw new OpenClawPairingQualificationError();
  }
}

export function observeOrdinaryOpenClawPairingSettlement(
  sandboxName: string,
  gatewayName: string,
  openclawVersion: string,
  stateDirectory: string,
  execDeps?: Partial<OpenClawPairingQualificationDeps>,
): OpenClawPairingSettlementObservation {
  try {
    const executed = runOpenClawPairingObservation(
      sandboxName,
      gatewayName,
      openclawVersion,
      stateDirectory,
      "ordinary-settlement",
      execDeps,
    );
    const observation = parseOpenClawPairingSettlementObservation(executed.output);
    if (!observation) throw new OpenClawPairingQualificationError();
    return observation;
  } catch (error) {
    if (error instanceof OpenClawPairingQualificationError) throw error;
    throw new OpenClawPairingQualificationError();
  }
}

export function observeOpenClawPairingQualification(
  sandboxName: string,
  gatewayName: string,
  openclawVersion: string,
  stateDirectory: string,
  execDeps?: Partial<OpenClawPairingQualificationDeps>,
): OpenClawPairingQualification {
  const normalizedVersion = openclawVersion.trim();
  const startedAt = performance.now();
  try {
    const executed = runOpenClawPairingObservation(
      sandboxName,
      gatewayName,
      normalizedVersion,
      stateDirectory,
      "qualification",
      execDeps,
    );
    const projection = parseOpenClawPairingObservation(executed.output);
    if (!projection) throw new OpenClawPairingQualificationError();
    return {
      schemaVersion: 1,
      kind: "openclaw-pairing",
      openclawVersion: normalizedVersion,
      ...projection,
      policySha256: sha256(executed.policy),
    };
  } catch (error) {
    if (error instanceof OpenClawPairingQualificationError) throw error;
    throw new OpenClawPairingQualificationError();
  } finally {
    recordQualificationStage(startedAt);
  }
}
