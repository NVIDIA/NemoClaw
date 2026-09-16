# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Record the inputs retained alongside an agent image's executable code."""

import hashlib
import json
import os
from pathlib import Path

if __name__ == "__main__":
    root = Path("/build")
    print(
        json.dumps(
            {
                "harness": os.environ["HARNESS"],
                "fabric_revision": os.environ["FABRIC_REVISION"],
                "source_sha256": os.environ["FABRIC_SHA256"],
                "requirements_sha256": hashlib.sha256(
                    Path("/requirements.txt").read_bytes()
                ).hexdigest(),
                "local_sources": {
                    str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in sorted(root.rglob("*"))
                    if path.is_file()
                },
            },
            indent=2,
        )
    )
