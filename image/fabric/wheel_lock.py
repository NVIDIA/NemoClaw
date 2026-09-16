# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Hash locally compiled wheels for the same strict install as registry wheels."""

import hashlib
import sys
from pathlib import Path


def requirements(directory: Path) -> str:
    wheels = sorted(directory.glob("*.whl"))
    if not wheels:
        raise ValueError("no locally compiled wheels")
    lines = []
    names = set()
    for wheel in wheels:
        name, version = wheel.name.split("-")[:2]
        if name in names:
            raise ValueError("ambiguous locally compiled package")
        names.add(name)
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        lines.append(f"{name.replace('_', '-')}=={version} --hash=sha256:{digest}\n")
    return "".join(lines)


if __name__ == "__main__":
    print(requirements(Path(sys.argv[1])), end="")
