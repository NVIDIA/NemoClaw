# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Build-only, separate embedded Python layouts for Deep Agents and NemoCUA.

The existing payload preparer owns archive provenance. This helper records and
preserves every actual prepared input byte except the declared _pth metadata.
Canonical Hermes uses its official full managed-Python/editable-venv adapter.
Nothing here is called at agent launch or changes runtime permissions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import sys

LAYOUTS = {
    "langchain-deepagents-code": ("deepagents", ["../site-packages"]),
    "nemocua": ("nemocua", []),
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def ordinary(path: Path, directory: bool) -> None:
    info = path.lstat()
    if (
        getattr(info, "st_file_attributes", 0) & 0x400
        or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
        or (not directory and info.st_nlink != 1)
    ):
        raise ValueError(
            "Python metadata preparation does not follow links or special files"
        )


def inventory(root: Path) -> list[dict]:
    ordinary(root, True)
    result = []
    pending = [root]
    entries = 0
    while pending:
        for entry in sorted(pending.pop().iterdir()):
            entries += 1
            if entries > 4096:
                raise ValueError(
                    "The prepared embedded Python tree exceeds its entry bound"
                )
            info = entry.lstat()
            directory = stat.S_ISDIR(info.st_mode)
            ordinary(entry, directory)
            if directory:
                pending.append(entry)
            else:
                result.append(
                    {
                        "path": entry.relative_to(root).as_posix(),
                        "bytes": info.st_size,
                        "sha256": digest(entry),
                    }
                )
    return sorted(result, key=lambda entry: entry["path"])


def finalize_agent_python(
    version_root: Path, source_python: Path, agent: str, version: str
) -> dict:
    if agent not in LAYOUTS or not re.fullmatch(r"3\.13\.(0|[1-9][0-9]{0,3})", version):
        raise ValueError(
            "Only the declared embedded Python 3.13 agent layouts are supported"
        )
    ordinary(version_root, True)
    ordinary(source_python, True)
    version_root = version_root.resolve(strict=True)
    source_python = source_python.resolve(strict=True)
    directory, import_roots = LAYOUTS[agent]
    agent_root = version_root / directory
    ordinary(agent_root, True)
    destination = agent_root / "python"
    descriptor = agent_root / "runtime-python.json"
    if destination.exists() or descriptor.exists():
        raise ValueError(
            "Python metadata must be finalized once in a fresh build layout"
        )
    if destination.is_relative_to(source_python):
        raise ValueError("The source Python tree cannot contain its output")
    if import_roots:
        ordinary(agent_root / "site-packages", True)
    before = inventory(source_python)
    paths = {entry["path"] for entry in before}
    if not {"python.exe", "python313.zip", "python313._pth"}.issubset(paths):
        raise ValueError("The declared embedded Python input is incomplete")
    with (source_python / "python.exe").open("rb") as stream:
        header = stream.read(4096)
    offset = int.from_bytes(header[0x3C:0x40], "little")
    if (
        not header.startswith(b"MZ")
        or offset > len(header) - 6
        or header[offset : offset + 4] != b"PE\0\0"
        or int.from_bytes(header[offset + 4 : offset + 6], "little") != 0xAA64
    ):
        raise ValueError("The prepared Python executable must be Windows ARM64")
    if (
        source_python / "python313._pth"
    ).read_bytes() != b"python313.zip\r\n.\r\nimport site\r\n":
        raise ValueError(
            "The prepared Python import metadata differs from its reviewed baseline"
        )
    encoded = (
        "\r\n".join(["python313.zip", ".", *import_roots, "import site", ""])
    ).encode("ascii")
    # A fresh destination is owned by this operation. On failure only this new
    # copy is removed; the prepared input and other agent layouts remain intact.
    destination.mkdir()
    try:
        for entry in before:
            target = destination / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_python / entry["path"], target)
        if inventory(source_python) != before or inventory(destination) != before:
            raise ValueError("The prepared Python input changed during its exact copy")
        (destination / "python313._pth").write_bytes(encoded)
        after = inventory(destination)
        expected = [dict(entry) for entry in before]
        metadata = next(
            entry for entry in expected if entry["path"] == "python313._pth"
        )
        metadata.update(bytes=len(encoded), sha256=hashlib.sha256(encoded).hexdigest())
        if after != expected:
            raise ValueError(
                "Python preparation changed bytes beyond its declared metadata"
            )
        record = {
            "schemaVersion": 1,
            "classification": "installer-finalized-agent-python",
            "agent": agent,
            "layout": "embedded-python-isolated",
            "pythonVersion": version,
            "interpreter": "python/python.exe",
            "interpreterSha256": next(
                entry["sha256"] for entry in before if entry["path"] == "python.exe"
            ),
            "importRoots": [
                "python/python313.zip",
                "python",
                *(["site-packages"] if import_roots else []),
            ],
            "metadataPath": "python/python313._pth",
            "metadataSha256": hashlib.sha256(encoded).hexdigest(),
            "sourcePreparedTreeSha256": hashlib.sha256(
                json.dumps(before, separators=(",", ":")).encode()
            ).hexdigest(),
            "filesCopiedAtBuild": len(before),
            "bytesCopiedAtBuild": sum(entry["bytes"] for entry in before),
            "runtimeLaunchMutationRequired": False,
            "sourceArchiveVerificationOwner": "existing Windows payload preparer",
        }
        with descriptor.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(record, indent=2) + "\n")
        return record
    except BaseException:
        try:
            shutil.rmtree(destination)
        except OSError:
            print("The new Python build copy also failed cleanup.", file=sys.stderr)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version-root", type=Path, required=True)
    parser.add_argument("--prepared-python", type=Path, required=True)
    parser.add_argument("--python-version", required=True)
    parser.add_argument("--agent", choices=LAYOUTS, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            finalize_agent_python(
                args.version_root, args.prepared_python, args.agent, args.python_version
            )
        )
    )


if __name__ == "__main__":
    main()
