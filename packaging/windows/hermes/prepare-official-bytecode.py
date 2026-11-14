# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Prepare timestamp-independent import caches in the finished, owned CI tree."""

import argparse
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import platform
import py_compile
import stat
import sys
import tempfile
import time


PYTHON = "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/python.exe"
UPSTREAM = "2237be355906fbe6065ce1815711eee52b2d646e"
INSTALLED_RUNTIME_PREFIX_CHARACTERS = 114


def installable_cache(root, cache):
    relative = cache.relative_to(root).as_posix().replace("/", "\\")
    return INSTALLED_RUNTIME_PREFIX_CHARACTERS + len(relative) < 260


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_totals(root):
    files = size = caches = 0
    for directory, _names, names in os.walk(root, followlinks=False):
        for name in names:
            value = (Path(directory) / name).lstat()
            if stat.S_ISREG(value.st_mode):
                files += 1
                size += value.st_size
                caches += name.endswith(".pyc")
    return {"files": files, "logicalBytes": size, "pycFiles": caches}


def ordinary(path):
    value = path.lstat()
    if (
        not stat.S_ISREG(value.st_mode)
        or value.st_nlink != 1
        or getattr(value, "st_file_attributes", 0) & 0x400
    ):
        raise ValueError(
            "Bytecode input/output must be an ordinary owned file: " + str(path)
        )


def source_files(root):
    """No test-name heuristics: production pruning precedes this preparation."""
    result = []
    for directory, names, files in os.walk(root, followlinks=False):
        current = Path(directory)
        names[:] = sorted(
            name
            for name in names
            if name != "__pycache__"
            and not (current / name).is_symlink()
            and not getattr((current / name).lstat(), "st_file_attributes", 0) & 0x400
        )
        for name in sorted(files):
            if name.endswith(".py"):
                source = current / name
                ordinary(source)
                result.append(source)
    return result


def prepare_tree(root):
    sources = source_files(root)
    if not sources or len(sources) > 50000:
        raise ValueError(
            "The finished Python source inventory is empty or exceeds its bound."
        )
    rows = []
    for number, source in enumerate(sources, 1):
        relative = source.relative_to(root).as_posix()
        content = source.read_bytes()
        cache = Path(importlib.util.cache_from_source(str(source), optimization=""))
        cache.parent.mkdir(exist_ok=True)
        if (
            cache.parent.is_symlink()
            or getattr(cache.parent.lstat(), "st_file_attributes", 0) & 0x400
        ):
            raise ValueError("A bytecode cache directory is a reparse point.")
        variants = [(cache, 0)]
        for level in (1, 2):
            optimized = Path(
                importlib.util.cache_from_source(str(source), optimization=str(level))
            )
            if optimized.exists():
                variants.append((optimized, level))
        for output, optimization in variants:
            existed = output.exists()
            if not installable_cache(root, output):
                if existed:
                    output.unlink()
                continue
            if existed:
                ordinary(output)
            # No source is imported or executed. Relative code filenames avoid
            # embedding the disposable build root; Python fixes them on import.
            py_compile.compile(
                str(source),
                cfile=str(output),
                dfile=relative,
                doraise=True,
                optimize=optimization,
                invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
            )
            ordinary(output)
            compiled = output.read_bytes()
            if (
                compiled[:4] != importlib.util.MAGIC_NUMBER
                or int.from_bytes(compiled[4:8], "little") != 1
                or compiled[8:16] != importlib.util.source_hash(content)
                or source.read_bytes() != content
            ):
                raise ValueError(
                    "Source-bound bytecode verification failed: " + relative
                )
            rows.append(
                {
                    "source": relative,
                    "cache": output.relative_to(root).as_posix(),
                    "sourceSha256": hashlib.sha256(content).hexdigest(),
                    "cacheSha256": hashlib.sha256(compiled).hexdigest(),
                    "cacheBytes": len(compiled),
                    "optimization": optimization,
                    "replaced": existed,
                    "magicHex": compiled[:4].hex(),
                    "flags": 1,
                    "sourceHashHex": compiled[8:16].hex(),
                }
            )
        if number % 512 == 0:
            print(
                f"[Hermes runtime] Prepared Python import caches: {number}/{len(sources)}",
                flush=True,
            )
    return rows


def prove_relocated_import(scratch):
    """Use a disposable module; forbid source compilation in the actual loader."""
    with tempfile.TemporaryDirectory(
        dir=scratch, prefix="bytecode-import-"
    ) as directory:
        original = Path(directory) / "original"
        original.mkdir()
        source = original / "compiled_sentinel.py"
        source.write_text("VALUE = 'HERMES_PREBUILT_BYTECODE'\n", encoding="utf-8")
        rows = prepare_tree(original)
        moved = Path(directory) / "installed"
        original.rename(moved)
        source = moved / source.name
        cache = moved / rows[0]["cache"]
        expected = digest(cache)
        os.utime(source, (0, 0))  # The deterministic exporter writes mtime=0.

        class CacheOnlyLoader(importlib.machinery.SourceFileLoader):
            def source_to_code(self, *_args, **_kwargs):
                raise AssertionError(
                    "Timestamp normalization caused source compilation"
                )

        loader = CacheOnlyLoader("compiled_sentinel", str(source))
        module = importlib.util.module_from_spec(
            importlib.util.spec_from_loader(loader.name, loader)
        )
        loader.exec_module(module)
        if module.VALUE != "HERMES_PREBUILT_BYTECODE" or digest(cache) != expected:
            raise ValueError(
                "The moved hash cache did not satisfy the actual import loader."
            )
        return {
            "sourceMtime": 0,
            "movedRoot": True,
            "sourceCompilationForbidden": True,
            "cacheUnchanged": True,
            "sentinel": module.VALUE,
        }


def validate_receipt(root, report):
    root = Path(root).resolve(strict=True)
    if (
        report.get("classification") != "official-hermes-prepared-bytecode"
        or report.get("status") != "prepared"
        or report.get("upstreamCommit") != UPSTREAM
        or report.get("invalidationMode") != "unchecked-hash"
        or report.get("pythonVersion") != "3.11.16"
        or report.get("magicHex") != "a70d0d0a"
        or report.get("importProof", {}).get("sourceCompilationForbidden") is not True
    ):
        raise ValueError("The canonical runtime lacks its exact CI bytecode proof.")
    all_sources = source_files(root)
    expected_sources = {
        p.relative_to(root).as_posix()
        for p in all_sources
        if installable_cache(
            root, Path(importlib.util.cache_from_source(str(p), optimization=""))
        )
    }
    seen = set()
    sources = set()
    for row in report["files"]:
        for key in ("source", "cache"):
            relative = Path(row[key])
            if (
                relative.is_absolute()
                or ".." in relative.parts
                or not (root / relative).resolve().is_relative_to(root)
            ):
                raise ValueError("A bytecode receipt path escapes the runtime.")
        source, cache = root / row["source"], root / row["cache"]
        optimization = row["optimization"]
        if optimization not in (0, 1, 2):
            raise ValueError("Unexpected bytecode optimization level.")
        suffix = "" if optimization == 0 else ".opt-" + str(optimization)
        expected_cache = (
            source.parent
            / "__pycache__"
            / (source.stem + ".cpython-311" + suffix + ".pyc")
        )
        if cache != expected_cache:
            raise ValueError("Bytecode does not have the canonical import-cache path.")
        if row["cache"] in seen:
            raise ValueError("Duplicate bytecode receipt entry.")
        seen.add(row["cache"])
        sources.add(row["source"])
        ordinary(source)
        ordinary(cache)
        compiled = cache.read_bytes()
        if (
            digest(source) != row["sourceSha256"]
            or digest(cache) != row["cacheSha256"]
            or len(compiled) != row["cacheBytes"]
            or compiled[:4].hex() != report["magicHex"]
            or int.from_bytes(compiled[4:8], "little") != 1
            or compiled[8:16].hex() != row["sourceHashHex"]
        ):
            raise ValueError("Bytecode changed after canonical compilation.")
    if sources != expected_sources or report.get("sourceFileCount") != len(sources):
        raise ValueError("The finished runtime has unprepared Python sources.")
    for relative in expected_sources:
        source = root / relative
        cache = source.parent / "__pycache__" / (source.stem + ".cpython-311.pyc")
        if cache.relative_to(root).as_posix() not in seen:
            raise ValueError("A runtime source lacks its normal import cache.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    root = args.runtime_root.resolve(strict=True)
    if (
        sys.platform != "win32"
        or platform.machine().lower() not in ("arm64", "aarch64")
        or sys.version_info[:3] != (3, 11, 16)
        or os.environ.get("GITHUB_ACTIONS") != "true"
        or Path(sys.executable).resolve() != (root / PYTHON).resolve(strict=True)
    ):
        raise ValueError(
            "Use only the exact canonical interpreter in Windows ARM64 build CI."
        )
    if args.receipt.exists() or args.receipt.resolve().is_relative_to(root):
        raise ValueError("Bytecode evidence must be fresh and outside the runtime.")
    start = time.monotonic()
    report = {
        "schemaVersion": 1,
        "classification": "official-hermes-prepared-bytecode",
        "status": "failed",
        "upstreamCommit": UPSTREAM,
        "pythonVersion": platform.python_version(),
        "pythonSha256": digest(root / PYTHON),
        "builderSha256": digest(Path(__file__)),
        "magicHex": importlib.util.MAGIC_NUMBER.hex(),
        "invalidationMode": "unchecked-hash",
        "sourceFilesRetained": True,
        "requiresVerifiedImmutableRuntime": True,
        "runtimeExecutionQualified": False,
    }
    try:
        report["runtimeBefore"] = runtime_totals(root)
        report["files"] = prepare_tree(root)
        report["sourceFileCount"] = len({r["source"] for r in report["files"]})
        report["skippedLongPathSourceFiles"] = len(source_files(root)) - report["sourceFileCount"]
        report["cacheFileCount"] = len(report["files"])
        report["addedCacheFiles"] = sum(not r["replaced"] for r in report["files"])
        report["replacedCacheFiles"] = sum(r["replaced"] for r in report["files"])
        report["cacheBytes"] = sum(r["cacheBytes"] for r in report["files"])
        report["importProof"] = prove_relocated_import(args.receipt.parent)
        report["runtimeAfter"] = runtime_totals(root)
        report["status"] = "prepared"
        validate_receipt(root, report)
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        report["elapsedMilliseconds"] = int((time.monotonic() - start) * 1000)
        primary = sys.exception()
        try:
            with args.receipt.open("x", encoding="utf-8") as output:
                json.dump(report, output, indent=2)
                output.write("\n")
        except Exception as error:
            if primary is None:
                raise
            primary.add_note("Bytecode receipt also failed: " + str(error))


if __name__ == "__main__":
    main()
