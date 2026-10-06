# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Descriptor-pinned adapter for OpenClaw's canonical pairing-state database."""

import json
import os
import sqlite3
import stat
import urllib.parse


ADAPTER_VERSION = 1
OPENCLAW_STATE_SCHEMA_VERSION = 15
MAX_SQLITE_BYTES = 1024 * 1024 * 1024


class OpenClawPairingStateRetryableError(OSError):
    """The canonical snapshot changed or is not ready for a bounded read."""


def _directory_flags():
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def _path_flags():
    return (
        getattr(os, "O_PATH", os.O_RDONLY)
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )


def _file_flags():
    return (
        os.O_RDONLY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )


def _metadata(metadata, require_nonempty):
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_gid != os.getegid()
        or metadata.st_mode & 0o007
        or (require_nonempty and metadata.st_size < 1)
        or metadata.st_size > MAX_SQLITE_BYTES
    ):
        raise OSError("unsafe canonical pairing-state SQLite entry")
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_mode & 0o7777,
    )


def _directory_metadata(fd):
    metadata = os.fstat(fd)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_gid != os.getegid()
        or metadata.st_mode & 0o002
    ):
        raise OSError("unsafe canonical pairing-state directory")
    return metadata.st_dev, metadata.st_ino


def _state_root_is_current(state_dir, state_fd):
    try:
        current = os.stat(state_dir, follow_symlinks=False)
        pinned = os.fstat(state_fd)
    except OSError:
        return False
    return stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (
        pinned.st_dev,
        pinned.st_ino,
    )


def _directory_is_current(state_dir, state_fd, sqlite_state_fd):
    if not _state_root_is_current(state_dir, state_fd):
        return False
    try:
        current = os.stat("state", dir_fd=state_fd, follow_symlinks=False)
        pinned = os.fstat(sqlite_state_fd)
    except OSError:
        return False
    return stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (
        pinned.st_dev,
        pinned.st_ino,
    )


def _open_state_root(state_dir):
    if not os.path.isabs(state_dir):
        raise OSError("canonical pairing-state path is not absolute")
    for required_flag in ("O_DIRECTORY", "O_NOFOLLOW"):
        if not hasattr(os, required_flag):
            raise OSError("canonical pairing-state descriptor flags are unavailable")
    root_fd = os.open(os.sep, _path_flags())
    try:
        for component in (part for part in state_dir.split(os.sep) if part):
            if component in (".", ".."):
                raise OSError("unsafe canonical pairing-state path")
            next_fd = os.open(component, _path_flags(), dir_fd=root_fd)
            os.close(root_fd)
            root_fd = next_fd
        _directory_metadata(root_fd)
        if not _state_root_is_current(state_dir, root_fd):
            raise OpenClawPairingStateRetryableError("canonical pairing-state root changed")
        return root_fd
    except Exception:
        os.close(root_fd)
        raise


def _open_state_directory(state_dir, state_fd):
    sqlite_state_fd = os.open("state", _directory_flags(), dir_fd=state_fd)
    try:
        _directory_metadata(sqlite_state_fd)
        if not _directory_is_current(state_dir, state_fd, sqlite_state_fd):
            raise OpenClawPairingStateRetryableError(
                "canonical pairing-state directory changed"
            )
        return sqlite_state_fd
    except Exception:
        os.close(sqlite_state_fd)
        raise


def _entry_is_current(
    state_dir,
    state_fd,
    sqlite_state_fd,
    name,
    fd,
    expected,
):
    if not _directory_is_current(state_dir, state_fd, sqlite_state_fd):
        return False
    try:
        current = os.stat(name, dir_fd=sqlite_state_fd, follow_symlinks=False)
    except OSError:
        return False
    current_metadata = (
        current.st_dev,
        current.st_ino,
        current.st_uid,
        current.st_gid,
        current.st_size,
        current.st_mtime_ns,
        current.st_mode & 0o7777,
    )
    descriptor_metadata = _metadata(os.fstat(fd), name != "openclaw.sqlite-wal")
    if name.endswith("-shm"):
        # SQLite may update read marks in an existing SHM. Identity and safety
        # attributes remain immutable; size and timestamps are coordination data.
        stable_fields = (0, 1, 2, 3, 6)
        return all(
            current_metadata[index] == expected[index]
            and descriptor_metadata[index] == expected[index]
            for index in stable_fields
        )
    return current_metadata == expected and descriptor_metadata == expected


def sqlite_snapshot_is_current(
    state_dir,
    state_fd,
    sqlite_state_fd,
    database_fd,
    database_metadata,
):
    return _entry_is_current(
        state_dir,
        state_fd,
        sqlite_state_fd,
        "openclaw.sqlite",
        database_fd,
        database_metadata,
    )


def sqlite_database_metadata(database_fd):
    """Return the validated identity/safety metadata for a pinned database."""

    return _metadata(os.fstat(database_fd), True)


def _open_wal_descriptors(state_dir, state_fd, sqlite_state_fd):
    shared_memory_fd = -1
    try:
        wal_fd = os.open("openclaw.sqlite-wal", _file_flags(), dir_fd=sqlite_state_fd)
    except FileNotFoundError:
        return None
    try:
        wal_metadata = _metadata(os.fstat(wal_fd), False)
        if not _entry_is_current(
            state_dir,
            state_fd,
            sqlite_state_fd,
            "openclaw.sqlite-wal",
            wal_fd,
            wal_metadata,
        ):
            raise OpenClawPairingStateRetryableError("canonical pairing-state WAL changed")
        try:
            shared_memory_fd = os.open(
                "openclaw.sqlite-shm", _file_flags(), dir_fd=sqlite_state_fd
            )
        except FileNotFoundError as error:
            raise OpenClawPairingStateRetryableError(
                "canonical pairing-state WAL is missing its shared-memory sidecar"
            ) from error
        shared_memory_metadata = _metadata(os.fstat(shared_memory_fd), True)
        if not _entry_is_current(
            state_dir,
            state_fd,
            sqlite_state_fd,
            "openclaw.sqlite-shm",
            shared_memory_fd,
            shared_memory_metadata,
        ):
            raise OpenClawPairingStateRetryableError(
                "canonical pairing-state shared-memory sidecar changed"
            )
        return wal_fd, wal_metadata, shared_memory_fd, shared_memory_metadata
    except Exception:
        if shared_memory_fd >= 0:
            os.close(shared_memory_fd)
        os.close(wal_fd)
        raise


def _regular_open_file_identity_counts():
    descriptor_root = next(
        (
            candidate
            for candidate in ("/proc/self/fd", "/dev/fd")
            if os.path.isdir(candidate)
        ),
        None,
    )
    if descriptor_root is None:
        raise OSError("open descriptor census is unavailable")
    counts = {}
    for name in os.listdir(descriptor_root):
        if not name.isdecimal():
            continue
        try:
            metadata = os.fstat(int(name))
        except OSError:
            continue
        if stat.S_ISREG(metadata.st_mode):
            identity = metadata.st_dev, metadata.st_ino
            counts[identity] = counts.get(identity, 0) + 1
    return counts, descriptor_root


def _require_sqlite_vfs_descriptor(counts, baseline, fd, expected_delta):
    metadata = os.fstat(fd)
    identity = metadata.st_dev, metadata.st_ino
    if counts.get(identity, 0) != baseline.get(identity, 0) + expected_delta:
        raise OpenClawPairingStateRetryableError(
            "SQLite reopened an unvalidated pairing-state file identity"
        )


def _optional(record, key, value):
    if value is not None:
        record[key] = value


def _json_column(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("invalid canonical pairing-state JSON column")
    return json.loads(value)


def _pending_record(row):
    record = {
        "requestId": row["request_id"],
        "deviceId": row["device_id"],
        "publicKey": row["public_key"],
        "ts": row["ts"],
    }
    for key, column in (
        ("displayName", "display_name"),
        ("platform", "platform"),
        ("deviceFamily", "device_family"),
        ("clientId", "client_id"),
        ("clientMode", "client_mode"),
        ("browserOrigin", "browser_origin"),
        ("role", "role"),
        ("remoteIp", "remote_ip"),
        ("refreshedAtMs", "refreshed_at_ms"),
    ):
        _optional(record, key, row[column])
    _optional(record, "roles", _json_column(row["roles_json"]))
    _optional(record, "scopes", _json_column(row["scopes_json"]))
    _optional(record, "silent", None if row["silent"] is None else row["silent"] != 0)
    _optional(
        record,
        "isRepair",
        None if row["is_repair"] is None else row["is_repair"] != 0,
    )
    return record


def _paired_record(row):
    record = {
        "deviceId": row["device_id"],
        "publicKey": row["public_key"],
        "createdAtMs": row["created_at_ms"],
        "approvedAtMs": row["approved_at_ms"],
    }
    for key, column in (
        ("displayName", "display_name"),
        ("operatorLabel", "operator_label"),
        ("platform", "platform"),
        ("deviceFamily", "device_family"),
        ("clientId", "client_id"),
        ("clientMode", "client_mode"),
        ("browserOrigin", "browser_origin"),
        ("role", "role"),
        ("remoteIp", "remote_ip"),
        ("approvedVia", "approved_via"),
        ("lastSeenAtMs", "last_seen_at_ms"),
        ("lastSeenReason", "last_seen_reason"),
    ):
        _optional(record, key, row[column])
    for key, column in (
        ("roles", "roles_json"),
        ("scopes", "scopes_json"),
        ("approvedScopes", "approved_scopes_json"),
        ("tokens", "tokens_json"),
        ("nodeSurface", "node_surface_json"),
        ("pendingNodeSurface", "pending_node_surface_json"),
    ):
        _optional(record, key, _json_column(row[column]))
    return record


def _read_records(connection, *, local_device_only=False):
    identities = connection.execute(
        "SELECT identity_key, device_id, public_key_pem, private_key_pem, "
        "created_at_ms, updated_at_ms "
        "FROM device_identities WHERE identity_key = 'primary'"
    ).fetchall()
    if len(identities) != 1:
        raise ValueError("canonical primary device identity is unavailable")
    identity_row = identities[0]
    identity = {
        "version": 1,
        "deviceId": identity_row["device_id"],
        "publicKeyPem": identity_row["public_key_pem"],
        "privateKeyPem": identity_row["private_key_pem"],
    }
    if local_device_only:
        local_device_id = identity_row["device_id"]
        pending_rows = connection.execute(
            "SELECT * FROM device_pairing_pending ORDER BY request_id"
        ).fetchall()
        paired_rows = connection.execute(
            "SELECT * FROM device_pairing_paired WHERE device_id = ? ORDER BY device_id",
            (local_device_id,),
        ).fetchall()
        auth_rows = connection.execute(
            "SELECT device_id, role, token, scopes_json, updated_at_ms "
            "FROM device_auth_tokens WHERE device_id = ? ORDER BY device_id, role",
            (local_device_id,),
        ).fetchall()
    else:
        pending_rows = connection.execute(
            "SELECT * FROM device_pairing_pending ORDER BY request_id"
        ).fetchall()
        paired_rows = connection.execute(
            "SELECT * FROM device_pairing_paired ORDER BY device_id"
        ).fetchall()
        auth_rows = connection.execute(
            "SELECT device_id, role, token, scopes_json, updated_at_ms "
            "FROM device_auth_tokens ORDER BY device_id, role"
        ).fetchall()
    pending = {row["request_id"]: _pending_record(row) for row in pending_rows}
    paired = {row["device_id"]: _paired_record(row) for row in paired_rows}
    auth_by_device = {}
    for row in auth_rows:
        roles = auth_by_device.setdefault(row["device_id"], {})
        if row["role"] in roles:
            raise ValueError("canonical device state contains duplicate auth roles")
        roles[row["role"]] = {
            "token": row["token"],
            "role": row["role"],
            "scopes": _json_column(row["scopes_json"]),
            "updatedAtMs": row["updated_at_ms"],
        }
    if len(pending) != len(pending_rows) or len(paired) != len(paired_rows):
        raise ValueError("canonical device state contains duplicate identities")
    return {
        "adapterVersion": ADAPTER_VERSION,
        "schemaVersion": OPENCLAW_STATE_SCHEMA_VERSION,
        "identity": identity,
        "identityTimestamps": {
            "createdAtMs": identity_row["created_at_ms"],
            "updatedAtMs": identity_row["updated_at_ms"],
        },
        "pending": pending,
        "paired": paired,
        "authByDevice": auth_by_device,
    }


def read_openclaw_pairing_state(
    state_dir,
    *,
    timeout=0.25,
    state_fd=None,
    sqlite_state_fd=None,
    database_fd=None,
    local_device_only=False,
):
    """Read one canonical snapshot, optionally through caller-owned base descriptors."""

    own_state_fd = state_fd is None
    own_sqlite_state_fd = sqlite_state_fd is None
    own_database_fd = database_fd is None
    connection = None
    wal_descriptors = None
    try:
        if own_state_fd:
            state_fd = _open_state_root(state_dir)
        else:
            _directory_metadata(state_fd)
            if not _state_root_is_current(state_dir, state_fd):
                raise OpenClawPairingStateRetryableError(
                    "canonical pairing-state root changed"
                )
        if own_sqlite_state_fd:
            sqlite_state_fd = _open_state_directory(state_dir, state_fd)
        else:
            _directory_metadata(sqlite_state_fd)
            if not _directory_is_current(state_dir, state_fd, sqlite_state_fd):
                raise OpenClawPairingStateRetryableError(
                    "canonical pairing-state directory changed"
                )
        if own_database_fd:
            database_fd = os.open(
                "openclaw.sqlite", _file_flags(), dir_fd=sqlite_state_fd
            )
        database_metadata = sqlite_database_metadata(database_fd)
        if not sqlite_snapshot_is_current(
            state_dir,
            state_fd,
            sqlite_state_fd,
            database_fd,
            database_metadata,
        ):
            raise OpenClawPairingStateRetryableError(
                "canonical pairing-state database changed"
            )
        wal_descriptors = _open_wal_descriptors(state_dir, state_fd, sqlite_state_fd)
        descriptor_baseline, descriptor_root = _regular_open_file_identity_counts()
        database_path = os.path.join(state_dir, "state", "openclaw.sqlite")
        database_uri = (
            "file:" + urllib.parse.quote(database_path, safe="/") + "?mode=ro"
        )
        if wal_descriptors is None:
            database_uri += "&immutable=1"
        connection = sqlite3.connect(database_uri, uri=True, timeout=timeout)
        after_connect, _ = _regular_open_file_identity_counts()
        _require_sqlite_vfs_descriptor(
            after_connect, descriptor_baseline, database_fd, 1
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        connection.execute("PRAGMA trusted_schema = OFF")
        connection.execute("BEGIN")
        schema_version = connection.execute("PRAGMA user_version").fetchone()
        after_schema_read, _ = _regular_open_file_identity_counts()
        _require_sqlite_vfs_descriptor(
            after_schema_read, descriptor_baseline, database_fd, 1
        )
        if wal_descriptors is not None:
            _require_sqlite_vfs_descriptor(
                after_schema_read, descriptor_baseline, wal_descriptors[0], 1
            )
            shared_memory_identity = wal_descriptors[3][0], wal_descriptors[3][1]
            shared_memory_delta = after_schema_read.get(
                shared_memory_identity, 0
            ) - descriptor_baseline.get(shared_memory_identity, 0)
            if descriptor_root == "/proc/self/fd" or shared_memory_delta != 0:
                _require_sqlite_vfs_descriptor(
                    after_schema_read, descriptor_baseline, wal_descriptors[2], 1
                )
        if schema_version is None or schema_version[0] != OPENCLAW_STATE_SCHEMA_VERSION:
            raise ValueError("unsupported canonical device state schema")
        records = _read_records(connection, local_device_only=local_device_only)
        if wal_descriptors is None:
            late_wal_descriptors = _open_wal_descriptors(
                state_dir, state_fd, sqlite_state_fd
            )
            if late_wal_descriptors is not None:
                os.close(late_wal_descriptors[2])
                os.close(late_wal_descriptors[0])
                raise OpenClawPairingStateRetryableError(
                    "canonical pairing-state WAL changed while reading"
                )
        elif not _entry_is_current(
            state_dir,
            state_fd,
            sqlite_state_fd,
            "openclaw.sqlite-wal",
            wal_descriptors[0],
            wal_descriptors[1],
        ) or not _entry_is_current(
            state_dir,
            state_fd,
            sqlite_state_fd,
            "openclaw.sqlite-shm",
            wal_descriptors[2],
            wal_descriptors[3],
        ):
            raise OpenClawPairingStateRetryableError(
                "canonical pairing-state WAL changed while reading"
            )
        if not sqlite_snapshot_is_current(
            state_dir,
            state_fd,
            sqlite_state_fd,
            database_fd,
            database_metadata,
        ):
            raise OpenClawPairingStateRetryableError(
                "canonical pairing-state database changed while reading"
            )
        connection.rollback()
        return records, database_metadata
    except sqlite3.OperationalError as error:
        if "locked" in str(error).lower() or "busy" in str(error).lower():
            raise OpenClawPairingStateRetryableError(
                "canonical pairing-state database is busy"
            ) from error
        raise
    finally:
        if connection is not None:
            connection.close()
        if wal_descriptors is not None:
            os.close(wal_descriptors[2])
            os.close(wal_descriptors[0])
        if own_database_fd and database_fd is not None:
            os.close(database_fd)
        if own_sqlite_state_fd and sqlite_state_fd is not None:
            os.close(sqlite_state_fd)
        if own_state_fd and state_fd is not None:
            os.close(state_fd)
