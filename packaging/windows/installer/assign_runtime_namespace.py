# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Assign the immutable namespace before finalizing paths embedded in its bytes."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import stat


def assign(receipt: Path, source_revision: str, component_identity: str):
    if not re.fullmatch("[a-f0-9]{40}", source_revision) or not re.fullmatch(
        "[a-f0-9]{64}", component_identity
    ):
        raise ValueError(
            "Namespace assignment requires exact source and component identities."
        )
    expected = {
        "schemaVersion": 1,
        "kind": "native-runtime-namespace",
        "sourceRevision": source_revision,
        "componentIdentity": component_identity,
    }
    record = {**expected, "runtimeId": secrets.token_hex(32)}
    encoded = (json.dumps(record, sort_keys=True, indent=2) + "\n").encode("ascii")
    try:
        with receipt.open("xb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        return record
    except FileExistsError:
        info = receipt.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_size > 4096
            or getattr(info, "st_file_attributes", 0) & 0x400
        ):
            raise ValueError(
                "The existing namespace receipt has an invalid file identity."
            ) from None
        current = json.loads(receipt.read_bytes())
        if (
            type(current) is not dict
            or set(current) != {*expected, "runtimeId"}
            or type(current.get("schemaVersion")) is not int
            or any(current.get(name) != value for name, value in expected.items())
            or type(current.get("runtimeId")) is not str
            or not re.fullmatch("[a-f0-9]{64}", current["runtimeId"])
        ):
            raise ValueError(
                "A namespace receipt cannot be reused for changed inputs."
            ) from None
        return current


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--component-identity", required=True)
    args = parser.parse_args()
    print(
        assign(args.receipt, args.source_revision, args.component_identity)["runtimeId"]
    )
