// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolveOpenshellBinary } from "../../../adapters/openshell/command-argv";
import type { LaunchReadinessOpenClawSessionQualification } from "../../../state/launch-readiness-lease";
import { ROOT } from "../../../state/paths";
import { WARMUP_TIMEOUT_MS, WATCHER_STATUS_TIMEOUT_MS } from "../auto-pair-warmup";
import { readAutoPairApprovalPolicyModule } from "../auto-pair-approval";

const QUALIFICATION_MARKER = "__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=";
const SETTLEMENT_MARKER = "__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=";
const RETRYABLE_OBSERVATION_EXIT_STATUS = 3;
const SHA256_RE = /^[a-f0-9]{64}$/;
export const OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS = 3_000;
// Reuse one fixed pairing lifecycle across ordinary onboarding and Portable.
// A contended gateway list can consume the watcher's complete child bound, so
// the appearance window retains room for another observation after three
// attempts (#9817).
export const OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS = 60_000;
export const OPENCLAW_ONBOARDING_PAIRING_POLL_MS = 1_000;
export const OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS = 30_000;
// Reserve the bounded request producer and watcher-observation windows. The
// host no longer owns an ordinary onboarding approval child (#10269).
export const OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS =
  OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS +
  OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS +
  WARMUP_TIMEOUT_MS +
  OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS +
  WATCHER_STATUS_TIMEOUT_MS;
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
  readonly state: "pairing-only" | "scope-upgrade-pending" | "settled";
  readonly deviceIdentitySha256: string;
};

export type OpenClawPairingRepairObservation = {
  readonly state: "pairing-only" | "pairing-pending" | "settled";
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

export class OpenClawPairingObservationRetryableError extends OpenClawPairingQualificationError {
  constructor() {
    super();
    this.name = "OpenClawPairingObservationRetryableError";
  }
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

function parseOpenClawPairingSettlementRecord(output: string): Record<string, unknown> | null {
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
    (record.state !== "pairing-only" &&
      record.state !== "scope-upgrade-pending" &&
      record.state !== "pairing-pending" &&
      record.state !== "settled")
  ) {
    return null;
  }
  return record;
}

export function parseOpenClawPairingSettlementObservation(
  output: string,
): OpenClawPairingSettlementObservation | null {
  const record = parseOpenClawPairingSettlementRecord(output);
  if (
    !record ||
    (record.state !== "pairing-only" &&
      record.state !== "scope-upgrade-pending" &&
      record.state !== "settled")
  ) {
    return null;
  }
  return record as OpenClawPairingSettlementObservation;
}

export function parseOpenClawPairingRepairObservation(
  output: string,
): OpenClawPairingRepairObservation | null {
  const record = parseOpenClawPairingSettlementRecord(output);
  if (
    !record ||
    (record.state !== "pairing-only" &&
      record.state !== "pairing-pending" &&
      record.state !== "settled")
  ) {
    return null;
  }
  return record as OpenClawPairingRepairObservation;
}

export function buildOpenClawPairingObservationScript(
  approvalPolicyModuleB64: string,
  stateDirectory: string,
  mode:
    | "ordinary-settlement"
    | "qualification"
    | "repair-settlement"
    | "settlement" = "qualification",
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
import sqlite3
import stat
import subprocess
import sys
import urllib.parse

MARKER = ${JSON.stringify(marker)}
MAX_ENTRY_BYTES = 512 * 1024
MAX_SQLITE_BYTES = 1024 * 1024 * 1024
MAX_SAFE_INTEGER = 9007199254740991
OPENCLAW_STATE_SCHEMA_VERSION = 15
REQUIRED_ROLES = ['operator']
PAIRING_ONLY_SCOPES = ['operator.pairing']
REQUEST_SCOPES = ['operator.pairing', 'operator.write']
TOKEN_SCOPES = ['operator.pairing', 'operator.read', 'operator.write']
ALLOW_CANONICAL_PENDING = ${mode === "ordinary-settlement" || mode === "repair-settlement" ? "True" : "False"}
ORDINARY_SETTLEMENT = ${mode === "ordinary-settlement" ? "True" : "False"}
REPORT_CANONICAL_PENDING = ${mode === "repair-settlement" ? "True" : "False"}
REQUIRE_REPAIR_PENDING = ${mode === "repair-settlement" ? "True" : "False"}
STRICT_SETTLEMENT = ${mode === "settlement" ? "True" : "False"}
ED25519_SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')
RAW_PUBLIC_KEY_RE = re.compile(r'^[A-Za-z0-9_-]{43}$')

def reject():
    sys.exit(1)

def retry_observation():
    sys.exit(${RETRYABLE_OBSERVATION_EXIT_STATUS})

class StateChangedError(Exception):
    pass

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

def sqlite_file_metadata(fd):
    metadata = os.fstat(fd)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_gid != os.getegid()
        or metadata.st_mode & 0o007
        or metadata.st_size < 1
        or metadata.st_size > MAX_SQLITE_BYTES
    ):
        raise OSError('unsafe sqlite database')
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
            raise StateChangedError('state root changed')
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
    if name not in ('devices', 'identity', 'state'):
        raise OSError('unsupported directory')
    fd = os.open(name, directory_flags, dir_fd=parent_fd)
    directory_metadata(fd)
    if not directory_is_current(parent_fd, name, fd):
        os.close(fd)
        raise StateChangedError('directory changed')
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
            raise StateChangedError('entry changed')
        return b''.join(chunks), after
    finally:
        os.close(fd)

def assert_sqlite_database_absent(state_fd):
    sqlite_state_fd = -1
    try:
        try:
            sqlite_state_fd = open_directory(state_fd, 'state')
        except FileNotFoundError:
            return
        try:
            os.stat('openclaw.sqlite', dir_fd=sqlite_state_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise StateChangedError('sqlite database appeared')
    finally:
        if sqlite_state_fd >= 0:
            os.close(sqlite_state_fd)

def assert_legacy_layout_current():
    state_fd = open_state_root()
    try:
        assert_sqlite_database_absent(state_fd)
    finally:
        os.close(state_fd)

def read_legacy_snapshot(state_fd):
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
            raise StateChangedError('state root changed')
        assert_sqlite_database_absent(state_fd)
        return {
            'layout': 'legacy',
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

def optional(row, key, value):
    if value is not None:
        row[key] = value

def parse_json_column(value):
    if not isinstance(value, str):
        raise ValueError('invalid sqlite JSON column')
    return json.loads(value)

def safe_timestamp(value):
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER

def validate_identity_key_pair(public_key_pem, private_key_pem):
    if not isinstance(public_key_pem, str) or not isinstance(private_key_pem, str):
        raise ValueError('invalid identity key material')
    openssl = '/usr/bin/openssl'
    openssl_metadata = os.stat(openssl, follow_symlinks=False)
    if (
        not stat.S_ISREG(openssl_metadata.st_mode)
        or openssl_metadata.st_nlink != 1
        or openssl_metadata.st_uid != 0
        or openssl_metadata.st_mode & 0o022
    ):
        raise OSError('openssl is unsafe')
    try:
        derived_public_key = subprocess.run(
            [openssl, 'pkey', '-pubout', '-outform', 'DER'],
            input=private_key_pem.encode('utf-8'),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={
                'LANG': 'C',
                'OPENSSL_CONF': '/dev/null',
                'PATH': '/usr/bin:/bin',
            },
            check=True,
            timeout=2,
        ).stdout
    except (subprocess.SubprocessError, UnicodeError) as error:
        raise ValueError('invalid identity private key') from error
    match = re.fullmatch(
        r'-----BEGIN PUBLIC KEY-----\\n([A-Za-z0-9+/]{59}=)\\n-----END PUBLIC KEY-----\\n',
        public_key_pem,
    )
    if match is None:
        raise ValueError('invalid identity public key')
    expected_public_key = base64.b64decode(match.group(1), validate=True)
    if derived_public_key != expected_public_key:
        raise ValueError('identity key pair mismatch')

def sqlite_sidecar_metadata(fd, require_nonempty):
    metadata = os.fstat(fd)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_gid != os.getegid()
        or metadata.st_mode & 0o007
        or (require_nonempty and metadata.st_size < 1)
        or metadata.st_size > MAX_SQLITE_BYTES
    ):
        raise OSError('unsafe sqlite sidecar')
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_mode & 0o7777,
    )

def sqlite_entry_is_current(sqlite_state_fd, name, fd, expected):
    current = os.stat(name, dir_fd=sqlite_state_fd, follow_symlinks=False)
    current_metadata = (
        current.st_dev,
        current.st_ino,
        current.st_uid,
        current.st_gid,
        current.st_size,
        current.st_mtime_ns,
        current.st_mode & 0o7777,
    )
    descriptor_metadata = sqlite_sidecar_metadata(fd, name.endswith('-shm'))
    if name.endswith('-shm'):
        # SQLite's native WAL reader may update read marks in the existing SHM.
        # Its identity and safety attributes must remain pinned; its mutable
        # size/time fields are not state evidence and cannot be equality-fenced.
        stable_fields = (0, 1, 2, 3, 6)
        return all(
            current_metadata[index] == expected[index]
            and descriptor_metadata[index] == expected[index]
            for index in stable_fields
        )
    return current_metadata == expected and descriptor_metadata == expected

def open_wal_descriptors(sqlite_state_fd):
    wal_fd = -1
    shared_memory_fd = -1
    try:
        wal_fd = os.open('openclaw.sqlite-wal', file_flags, dir_fd=sqlite_state_fd)
    except FileNotFoundError:
        return None
    try:
        wal_metadata = sqlite_sidecar_metadata(wal_fd, False)
        if not sqlite_entry_is_current(
            sqlite_state_fd, 'openclaw.sqlite-wal', wal_fd, wal_metadata,
        ):
            raise StateChangedError('sqlite WAL changed')
        try:
            shared_memory_fd = os.open(
                'openclaw.sqlite-shm', file_flags, dir_fd=sqlite_state_fd,
            )
        except FileNotFoundError as error:
            # A read-only connection to the source would otherwise create the
            # missing SHM sidecar. Retry until the canonical writer publishes it.
            raise StateChangedError('sqlite WAL is not reader-ready') from error
        shared_memory_metadata = sqlite_sidecar_metadata(shared_memory_fd, True)
        if not sqlite_entry_is_current(
            sqlite_state_fd,
            'openclaw.sqlite-shm',
            shared_memory_fd,
            shared_memory_metadata,
        ):
            raise StateChangedError('sqlite shared memory changed')
        return (wal_fd, wal_metadata, shared_memory_fd, shared_memory_metadata)
    except Exception:
        if shared_memory_fd >= 0:
            os.close(shared_memory_fd)
        os.close(wal_fd)
        raise

def regular_open_file_identity_counts():
    descriptor_root = next(
        (candidate for candidate in ('/proc/self/fd', '/dev/fd') if os.path.isdir(candidate)),
        None,
    )
    if descriptor_root is None:
        raise OSError('open descriptor census is unavailable')
    counts = {}
    for name in os.listdir(descriptor_root):
        if not name.isdecimal():
            continue
        try:
            metadata = os.fstat(int(name))
        except OSError:
            continue
        if stat.S_ISREG(metadata.st_mode):
            identity = (metadata.st_dev, metadata.st_ino)
            counts[identity] = counts.get(identity, 0) + 1
    return counts, descriptor_root

def require_sqlite_vfs_descriptor(counts, baseline, fd, expected_delta):
    metadata = os.fstat(fd)
    identity = (metadata.st_dev, metadata.st_ino)
    if counts.get(identity, 0) != baseline.get(identity, 0) + expected_delta:
        raise StateChangedError('sqlite reopened an unvalidated file identity')

def read_sqlite_snapshot(state_fd, sqlite_state_fd):
    database_fd = os.open('openclaw.sqlite', file_flags, dir_fd=sqlite_state_fd)
    connection = None
    wal_descriptors = None
    try:
        before = sqlite_file_metadata(database_fd)
        current = os.stat('openclaw.sqlite', dir_fd=sqlite_state_fd, follow_symlinks=False)
        if (
            current.st_dev,
            current.st_ino,
            current.st_uid,
            current.st_gid,
            current.st_size,
            current.st_mtime_ns,
            current.st_mode & 0o7777,
        ) != before:
            raise StateChangedError('sqlite database changed')
        wal_descriptors = open_wal_descriptors(sqlite_state_fd)
        descriptor_baseline, descriptor_root = regular_open_file_identity_counts()
        database_path = os.path.join(STATE_DIR, 'state', 'openclaw.sqlite')
        # Native mode=ro preserves SQLite's coherent committed-WAL view without
        # writing DB/WAL. It may update read marks in the already-existing SHM
        # coordination cache; the pre-open descriptor requirement prevents this
        # observer from creating a new source sidecar.
        database_uri = 'file:' + urllib.parse.quote(database_path, safe='/') + '?mode=ro'
        if wal_descriptors is None:
            database_uri += '&immutable=1'
        connection = sqlite3.connect(database_uri, uri=True, timeout=0)
        after_connect, _ = regular_open_file_identity_counts()
        require_sqlite_vfs_descriptor(
            after_connect, descriptor_baseline, database_fd, 1,
        )
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only = ON')
        connection.execute('PRAGMA trusted_schema = OFF')
        connection.execute('BEGIN')
        schema_version = connection.execute('PRAGMA user_version').fetchone()[0]
        after_schema_read, _ = regular_open_file_identity_counts()
        require_sqlite_vfs_descriptor(
            after_schema_read, descriptor_baseline, database_fd, 1,
        )
        if wal_descriptors is not None:
            require_sqlite_vfs_descriptor(
                after_schema_read, descriptor_baseline, wal_descriptors[0], 1,
            )
            shared_memory_identity = (
                wal_descriptors[3][0], wal_descriptors[3][1],
            )
            shared_memory_delta = (
                after_schema_read.get(shared_memory_identity, 0)
                - descriptor_baseline.get(shared_memory_identity, 0)
            )
            if descriptor_root == '/proc/self/fd' or shared_memory_delta != 0:
                require_sqlite_vfs_descriptor(
                    after_schema_read, descriptor_baseline, wal_descriptors[2], 1,
                )
        if type(schema_version) is not int or schema_version != OPENCLAW_STATE_SCHEMA_VERSION:
            raise ValueError('unsupported sqlite schema version')
        identities = connection.execute(
            "SELECT identity_key, device_id, public_key_pem, private_key_pem, "
            "created_at_ms, updated_at_ms "
            "FROM device_identities WHERE identity_key = 'primary'",
        ).fetchall()
        if len(identities) != 1:
            raise ValueError('invalid primary identity cardinality')
        identity_row = identities[0]
        if (
            not safe_timestamp(identity_row['created_at_ms'])
            or not safe_timestamp(identity_row['updated_at_ms'])
        ):
            raise ValueError('invalid identity timestamps')
        validate_identity_key_pair(
            identity_row['public_key_pem'], identity_row['private_key_pem'],
        )
        device_id = identity_row['device_id']

        paired = {}
        for source in connection.execute(
            'SELECT device_id, public_key, client_id, client_mode, role, roles_json, '
            'scopes_json, approved_scopes_json, tokens_json FROM device_pairing_paired '
            'ORDER BY device_id',
        ):
            row = {
                'deviceId': source['device_id'],
                'publicKey': source['public_key'],
            }
            optional(row, 'clientId', source['client_id'])
            optional(row, 'clientMode', source['client_mode'])
            optional(row, 'role', source['role'])
            optional(row, 'roles', parse_json_column(source['roles_json']) if source['roles_json'] is not None else None)
            optional(row, 'scopes', parse_json_column(source['scopes_json']) if source['scopes_json'] is not None else None)
            optional(row, 'approvedScopes', parse_json_column(source['approved_scopes_json']) if source['approved_scopes_json'] is not None else None)
            optional(row, 'tokens', parse_json_column(source['tokens_json']) if source['tokens_json'] is not None else None)
            paired[source['device_id']] = row

        pending = {}
        for source in connection.execute(
            'SELECT request_id, device_id, public_key, client_id, client_mode, role, '
            'roles_json, scopes_json, is_repair FROM device_pairing_pending ORDER BY request_id',
        ):
            row = {
                'requestId': source['request_id'],
                'deviceId': source['device_id'],
                'publicKey': source['public_key'],
            }
            optional(row, 'clientId', source['client_id'])
            optional(row, 'clientMode', source['client_mode'])
            optional(row, 'role', source['role'])
            optional(row, 'roles', parse_json_column(source['roles_json']) if source['roles_json'] is not None else None)
            optional(row, 'scopes', parse_json_column(source['scopes_json']) if source['scopes_json'] is not None else None)
            optional(row, 'isRepair', source['is_repair'] != 0 if source['is_repair'] is not None else None)
            pending[source['request_id']] = row

        auth_tokens = {}
        for source in connection.execute(
            'SELECT role, token, scopes_json FROM device_auth_tokens '
            'WHERE device_id = ? ORDER BY role',
            (device_id,),
        ):
            auth_tokens[source['role']] = {
                'role': source['role'],
                'token': source['token'],
                'scopes': parse_json_column(source['scopes_json']),
            }
        if wal_descriptors is None:
            late_wal_descriptors = open_wal_descriptors(sqlite_state_fd)
            if late_wal_descriptors is not None:
                os.close(late_wal_descriptors[2])
                os.close(late_wal_descriptors[0])
                raise StateChangedError('sqlite WAL changed')
        else:
            if not sqlite_entry_is_current(
                sqlite_state_fd,
                'openclaw.sqlite-wal',
                wal_descriptors[0],
                wal_descriptors[1],
            ) or not sqlite_entry_is_current(
                sqlite_state_fd,
                'openclaw.sqlite-shm',
                wal_descriptors[2],
                wal_descriptors[3],
            ):
                raise StateChangedError('sqlite WAL changed')
        connection.execute('COMMIT')
        after = sqlite_file_metadata(database_fd)
        current = os.stat('openclaw.sqlite', dir_fd=sqlite_state_fd, follow_symlinks=False)
        if before != after or (
            current.st_dev,
            current.st_ino,
            current.st_uid,
            current.st_gid,
            current.st_size,
            current.st_mtime_ns,
            current.st_mode & 0o7777,
        ) != after or not state_root_is_current(state_fd) or not directory_is_current(state_fd, 'state', sqlite_state_fd):
            raise StateChangedError('sqlite database changed')
        return {
            'layout': 'sqlite',
            'directories': [directory_metadata(state_fd), directory_metadata(sqlite_state_fd)],
            'identity': (json.dumps({
                'deviceId': device_id,
                'publicKeyPem': identity_row['public_key_pem'],
                'privateKeyPem': identity_row['private_key_pem'],
            }, sort_keys=True).encode('utf-8'), before),
            'auth': (json.dumps({
                'version': 1,
                'deviceId': device_id,
                'tokens': auth_tokens,
            }, sort_keys=True).encode('utf-8'), before),
            'paired': (json.dumps(paired, sort_keys=True).encode('utf-8'), before),
            'pending': (json.dumps(pending, sort_keys=True).encode('utf-8'), before),
        }
    except sqlite3.OperationalError as error:
        if 'locked' in str(error).lower() or 'busy' in str(error).lower():
            raise StateChangedError('sqlite database is busy') from error
        raise
    finally:
        if connection is not None:
            connection.close()
        if wal_descriptors is not None:
            os.close(wal_descriptors[2])
            os.close(wal_descriptors[0])
        os.close(database_fd)

def read_snapshot():
    state_fd = open_state_root()
    sqlite_state_fd = -1
    try:
        try:
            sqlite_state_fd = open_directory(state_fd, 'state')
        except FileNotFoundError:
            return read_legacy_snapshot(state_fd)
        try:
            database_entry = os.stat('openclaw.sqlite', dir_fd=sqlite_state_fd, follow_symlinks=False)
        except FileNotFoundError:
            return read_legacy_snapshot(state_fd)
        if not stat.S_ISREG(database_entry.st_mode):
            raise OSError('unsafe sqlite database')
        return read_sqlite_snapshot(state_fd, sqlite_state_fd)
    finally:
        if sqlite_state_fd >= 0:
            os.close(sqlite_state_fd)
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
        retry_observation()
    if first.get('layout') == 'legacy':
        assert_legacy_layout_current()
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
    canonical_pending_count = 0
    for request_id, request in pending.items():
        if (
            not isinstance(request_id, str)
            or not request_id
            or not isinstance(request, dict)
        ):
            reject()
        if ORDINARY_SETTLEMENT and request.get('deviceId') != device_id:
            continue
        if request.get('requestId') != request_id:
            reject()
        if ALLOW_CANONICAL_PENDING:
            # The host warm-up or an earlier client command can publish the
            # canonical write transition before finalization observes it.
            # Admit only that exact intermediate state while the startup
            # watcher remains the sole approval owner. Final observation still
            # requires settled scopes and no same-device pending request.
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
                or (REQUIRE_REPAIR_PENDING and request.get('isRepair') is not True)
                or not valid_write_scopes
                or not isinstance(decision, dict)
                or decision.get('allowed') is not True
            ):
                reject()
            canonical_pending_count += 1
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
    if ALLOW_CANONICAL_PENDING:
        relevant_pending_count = canonical_pending_count if ORDINARY_SETTLEMENT else len(pending)
        if relevant_pending_count and (relevant_pending_count != 1 or not pairing_only):
            reject()
    if not settled and not pairing_only:
        reject()

    device_identity_sha256 = hashlib.sha256(json.dumps({
        'deviceId': device_id,
        'publicKey': device_public_key,
    }, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
    ${
      mode !== "qualification"
        ? "print(MARKER + json.dumps({\n        'deviceIdentitySha256': device_identity_sha256,\n        'state': ('settled' if settled else ('scope-upgrade-pending' if ORDINARY_SETTLEMENT and canonical_pending_count else ('pairing-pending' if REPORT_CANONICAL_PENDING and pending else 'pairing-only'))),\n    }, sort_keys=True, separators=(',', ':')))\n    sys.exit(0)"
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
except (FileNotFoundError, StateChangedError):
    retry_observation()
except (OSError, ValueError, TypeError, KeyError, binascii.Error, UnicodeError, sqlite3.Error):
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
  mode: "ordinary-settlement" | "qualification" | "repair-settlement" | "settlement",
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
      timeout: OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS,
    },
  );
  if (!result.error && !result.signal && result.status === RETRYABLE_OBSERVATION_EXIT_STATUS) {
    throw new OpenClawPairingObservationRetryableError();
  }
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

export function observeOpenClawPairingRepairSettlement(
  sandboxName: string,
  gatewayName: string,
  openclawVersion: string,
  stateDirectory: string,
  execDeps?: Partial<OpenClawPairingQualificationDeps>,
): OpenClawPairingRepairObservation {
  try {
    const executed = runOpenClawPairingObservation(
      sandboxName,
      gatewayName,
      openclawVersion,
      stateDirectory,
      "repair-settlement",
      execDeps,
    );
    const observation = parseOpenClawPairingRepairObservation(executed.output);
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
    };
  } catch (error) {
    if (error instanceof OpenClawPairingQualificationError) throw error;
    throw new OpenClawPairingQualificationError();
  } finally {
    recordQualificationStage(startedAt);
  }
}
