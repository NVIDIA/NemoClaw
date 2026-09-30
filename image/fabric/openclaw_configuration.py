# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Reconcile native sections under OpenClawRuntime's existing exclusive state lock."""

import hashlib
import json
import os
import tempfile
from pathlib import Path


def sections(value):
    if not isinstance(value, dict):
        raise ValueError("native configuration must be an object")
    return {
        key: hashlib.sha256(
            json.dumps(item, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        for key, item in value.items()
    }


def atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def reconcile_configuration(home, native):
    path = home / "openclaw.json"
    receipt = home / "fabric-owned-settings.json"
    if path.is_symlink() or receipt.is_symlink():
        raise RuntimeError("native configuration ownership path is a symlink")
    expected = sections(native)
    owned = expected
    if receipt.exists():
        saved = json.loads(receipt.read_text())
        if (
            not isinstance(saved, dict)
            or set(saved) != {"version", "sections"}
            or type(saved["version"]) is not int
            or saved["version"] != 1
            or not isinstance(saved["sections"], dict)
            or not saved["sections"]
            or any(
                not isinstance(digest, str)
                or len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest)
                for digest in saved["sections"].values()
            )
        ):
            raise RuntimeError("native configuration ownership record is invalid")
        owned = saved["sections"]
    actual = json.loads(path.read_text()) if path.exists() else {}
    if path.exists():
        observed = sections(actual)

        def matches(desired):
            return all(observed.get(key) == digest for key, digest in desired.items())

        # Matching the proposed settings also recovers a crash between the two
        # atomic writes. Without a receipt, only an already matching file is used.
        proposed_is_complete = matches(expected) and not any(
            key in actual for key in owned if key not in expected
        )
        if not matches(owned) and not proposed_is_complete:
            raise RuntimeError("native configuration conflicts with Fabric-owned settings")
        if any(
            key not in owned and key in actual and actual[key] != value
            for key, value in native.items()
        ):
            raise RuntimeError("native configuration conflicts with unowned settings")
    updated = {key: value for key, value in actual.items() if key not in owned}
    updated.update(native)
    if actual != updated or not path.exists():
        atomic_json(path, updated)
    record = {"version": 1, "sections": expected}
    if not receipt.exists() or json.loads(receipt.read_text()) != record:
        atomic_json(receipt, record)
