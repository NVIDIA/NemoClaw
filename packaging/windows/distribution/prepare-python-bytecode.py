# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""CI-only bytecode preparation with the selected shipping Python interpreter.

The caller supplies import roots from the finalized agent assembly. Their source
files remain in the sealed distribution; unchecked-hash caches deliberately do
not depend on MSI/extraction timestamps. This does not authorize mutable caches.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import platform
import py_compile
import stat
import sys


VERSIONS = {
    "hermes": (3, 11, 16),
    "langchain-deepagents-code": (3, 13, 13),
    "nemocua": (3, 13, 13),
}
WORKERS = {
    "hermes": (
        "hermes-turn",
        "hermes-console",
        "hermes-console-probe",
        "hermes-dashboard",
        "hermes-dashboard-probe",
    ),
    "langchain-deepagents-code": ("deepagents-turn", "deepagents-console"),
    "nemocua": (),
}


def ordinary(path: Path, directory: bool = False) -> None:
    value = path.lstat()
    if stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400:
        raise ValueError("Bytecode inputs must not be reparse points.")
    if not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)):
        raise ValueError("Bytecode inputs must be ordinary files/directories.")
    if not directory and value.st_nlink != 1:
        raise ValueError("Bytecode source hardlinks are not admitted.")


def compile_source(source: Path, output: Path, installed_source: str) -> dict:
    ordinary(source)
    if output.exists() or output.is_symlink():
        raise ValueError("Bytecode output must be fresh.")
    ordinary(output.parent, directory=True)
    content = source.read_bytes()
    py_compile.compile(
        str(source),
        cfile=str(output),
        dfile=installed_source,
        doraise=True,
        optimize=0,
        invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
    )
    compiled = output.read_bytes()
    if (
        compiled[:4] != importlib.util.MAGIC_NUMBER
        or int.from_bytes(compiled[4:8], "little") != 1
        or compiled[8:16] != importlib.util.source_hash(content)
    ):
        raise ValueError(
            "The interpreter did not produce source-matched unchecked-hash bytecode."
        )
    return {
        "sourceSha256": hashlib.sha256(content).hexdigest(),
        "bytecodeSha256": hashlib.sha256(compiled).hexdigest(),
        "sourceBytes": len(content),
        "bytecodeBytes": len(compiled),
        "magicHex": compiled[:4].hex(),
        "flags": 1,
        "sourceHashHex": compiled[8:16].hex(),
    }


def compile_import_file(
    source: Path, installed_source: PureWindowsPath
) -> tuple[Path, dict]:
    ordinary(source)
    if source.suffix != ".py":
        raise ValueError("An import source must be a Python file.")
    cache = Path(importlib.util.cache_from_source(str(source), optimization=""))
    cache.parent.mkdir(exist_ok=True)
    ordinary(cache.parent, directory=True)
    # Official inputs may include timestamp caches. Replace only this
    # interpreter's exact cache name in the owned, not-yet-sealed CI tree.
    if cache.exists():
        ordinary(cache)
        cache.unlink()
    return cache, compile_source(source, cache, str(installed_source))


def compile_import_tree(root: Path, installed_root: PureWindowsPath) -> list[dict]:
    ordinary(root, directory=True)
    receipts = []
    for directory, names, files in os.walk(root, followlinks=False):
        current = Path(directory)
        ordinary(current, directory=True)
        for name in sorted(names):
            ordinary(current / name, directory=True)
        names[:] = sorted(name for name in names if name != "__pycache__")
        for name in sorted(files):
            source = current / name
            ordinary(source)
            if source.suffix != ".py":
                continue
            relative = source.relative_to(root)
            cache, receipt = compile_import_file(
                source, installed_root / relative.as_posix()
            )
            receipts.append(
                {
                    "source": relative.as_posix(),
                    "cache": cache.relative_to(root).as_posix(),
                    **receipt,
                }
            )
    return receipts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", choices=VERSIONS, required=True)
    parser.add_argument("--worker-inputs", type=Path, required=True)
    parser.add_argument("--workers-output", type=Path, required=True)
    parser.add_argument("--installed-workers", required=True)
    parser.add_argument(
        "--import-root",
        nargs=2,
        action="append",
        default=[],
        metavar=("CI_ROOT", "INSTALLED_ROOT"),
    )
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument(
        "--import-file",
        nargs=2,
        action="append",
        default=[],
        metavar=("CI_FILE", "INSTALLED_FILE"),
    )
    parser.add_argument(
        "--direct-entry",
        nargs=2,
        action="append",
        default=[],
        metavar=("CI_FILE", "INSTALLED_FILE"),
    )
    args = parser.parse_args()
    if (
        sys.platform != "win32"
        or platform.machine().lower() not in ("arm64", "aarch64")
        or sys.version_info[:3] != VERSIONS[args.agent]
        or os.environ.get("GITHUB_ACTIONS") != "true"
    ):
        raise ValueError(
            "Run this builder in Windows ARM64 CI with the exact shipping interpreter."
        )
    target = PureWindowsPath(args.installed_workers)
    if not target.is_absolute() or not target.drive or ".." in target.parts:
        raise ValueError("The finalized installed worker path is required.")
    ordinary(args.worker_inputs, directory=True)
    args.workers_output.mkdir(parents=True, exist_ok=True)
    ordinary(args.workers_output, directory=True)
    workers = []
    for name in WORKERS[args.agent]:
        receipt = compile_source(
            args.worker_inputs / (name + ".py"),
            args.workers_output / (name + ".pyc"),
            str(target / (name + ".py")),
        )
        workers.append({"worker": name + ".pyc", **receipt})
    trees = []
    for source_root, destination_root in args.import_root:
        installed = PureWindowsPath(destination_root)
        if (
            not installed.is_absolute()
            or not installed.drive
            or ".." in installed.parts
        ):
            raise ValueError("The finalized installed import path is required.")
        trees.append(
            {
                "installedRoot": str(installed),
                "files": compile_import_tree(Path(source_root), installed),
            }
        )
    modules = []
    for source_file, installed_file in args.import_file:
        installed = PureWindowsPath(installed_file)
        if (
            not installed.is_absolute()
            or not installed.drive
            or ".." in installed.parts
        ):
            raise ValueError("The finalized installed module path is required.")
        cache, compiled = compile_import_file(Path(source_file), installed)
        modules.append(
            {"installedSource": str(installed), "cacheName": cache.name, **compiled}
        )
    direct_entries = []
    for source_file, installed_file in args.direct_entry:
        source = Path(source_file)
        installed = PureWindowsPath(installed_file)
        if (
            source.suffix != ".py"
            or not installed.is_absolute()
            or not installed.drive
            or ".." in installed.parts
        ):
            raise ValueError("The finalized direct Python entry is required.")
        compiled = compile_source(source, source.with_suffix(".pyc"), str(installed))
        direct_entries.append({"entry": source.with_suffix(".pyc").name, **compiled})
    receipt = {
        "schemaVersion": 1,
        "classification": "ci-prepared-python-bytecode",
        "agent": args.agent,
        "pythonVersion": platform.python_version(),
        "platform": sys.platform,
        "architecture": platform.machine(),
        "pythonSha256": hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
        "magicHex": importlib.util.MAGIC_NUMBER.hex(),
        "invalidationMode": "unchecked-hash",
        "importSourceRetained": True,
        "workerInputsAreBuildOnly": True,
        "workers": workers,
        "importTrees": trees,
        "importModules": modules,
        "directEntries": direct_entries,
        "containedBytecodeReuseVerified": False,
    }
    with args.report.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
