# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Partition an already verified Windows CI copy; preserve its canonical input."""

import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile

PROJECT_TREES = (
    "hermes-agent/tests/",
    "hermes-agent/tests-js/",
    "hermes-agent/ui-tui/src/__tests__/",
    "hermes-agent/apps/desktop/src/test/",
    "hermes-agent/apps/desktop/src/components/ui/__tests__/",
    "hermes-agent/scripts/tests/",
    "hermes-agent/.github/",
    "hermes-agent/scripts/ci/",
    "hermes-agent/evals/",
)
WINDOWS_UNUSED_TREES = (
    "hermes-agent/plugins/platforms/photon/sidecar/",
    "hermes-agent/website/",
    "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/pip",
    "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/setuptools",
)
DECLARATIONS = (".d.ts", ".d.mts", ".d.cts")
# Git 2.54 help opens generated HTML/man/info; these are their build inputs.
GIT_DOCUMENTATION_SOURCE = "git/clangarm64/share/doc/git-doc/"
SYMBOL_ROOT = (
    "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/"
)
NATIVE_TEST_EXTENSIONS = {
    SYMBOL_ROOT + "DLLs/" + name + ".pyd"
    for name in (
        "_ctypes_test",
        "_testbuffer",
        "_testcapi",
        "_testconsole",
        "_testimportmultiple",
        "_testinternalcapi",
        "_testmultiphase",
    )
}
SOURCE_MAPS = (
    ".js.map",
    ".mjs.map",
    ".cjs.map",
    ".ts.map",
    ".mts.map",
    ".cts.map",
    ".css.map",
)
METADATA = {
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "uv.lock",
    "py.typed",
}
LICENSE = re.compile(
    r"(^|[._-])(licen[cs]es?|copying|copyright|notices?|authors?|about)($|[._-])",
    re.IGNORECASE,
)
EARLIER_LICENSE = re.compile(
    r"(^|[._-])(licen[cs]e|copying|notice|copyright)($|[._-])", re.IGNORECASE
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def relative(value):
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or path.as_posix() != value
        or ".." in path.parts
        or "\\" in value
        or ":" in value
    ):
        raise ValueError("Invalid partition path: " + value)
    return path


def totals(rows):
    return {"files": len(rows), "bytes": sum(row["bytes"] for row in rows)}


def make_plan(payload, protected=()):
    rows = payload["files"]
    licenses = set(payload["licenseFiles"])
    earlier = {
        row["path"]
        for row in rows
        if EARLIER_LICENSE.search(relative(row["path"]).name)
    }
    union = licenses | earlier
    removed, kept, seen = [], [], set()
    for row in rows:
        path = row["path"]
        parts = relative(path).parts
        if (
            "linkTarget" in row
            or path.casefold() in seen
            or type(row.get("bytes")) is not int
            or row["bytes"] < 0
            or not re.fullmatch(r"[0-9a-f]{64}", row.get("sha256", ""))
        ):
            raise ValueError("Incomplete or ambiguous source inventory: " + path)
        seen.add(path.casefold())
        tree = next(
            (prefix for prefix in PROJECT_TREES if path.startswith(prefix)), None
        )
        unused = next(
            (prefix for prefix in WINDOWS_UNUSED_TREES if path.startswith(prefix)), None
        )
        reason = (
            "windows-unused-runtime"
            if unused
            else "unused-bundled-browser"
            if path.startswith("browsers/")
            else "declaration"
            if path.endswith(DECLARATIONS)
            else "source-map"
            if path.endswith(SOURCE_MAPS)
            else "diagnostic-symbol"
            if path.startswith(SYMBOL_ROOT) and path.endswith(".pdb")
            else "native-test-extension"
            if path in NATIVE_TEST_EXTENSIONS
            else "git-documentation-source"
            if path.startswith(GIT_DOCUMENTATION_SOURCE) and path.endswith(".adoc")
            else tree
        )
        retain = (
            path in union
            or LICENSE.search(parts[-1])
            or any(p.lower() in ("licenses", "license", "legal") for p in parts[:-1])
            or parts[-1] in METADATA
            or any(p.endswith((".dist-info", ".egg-info")) for p in parts[:-1])
        )
        if reason and (not retain or unused):
            if path in protected:
                raise ValueError(
                    "Generated metadata references a removal candidate: " + path
                )
            group = (
                "diagnostic-symbols"
                if reason == "diagnostic-symbol"
                else "unused-bundled-browser"
                if reason == "unused-bundled-browser"
                else "development"
            )
            removed.append({**row, "group": group, "reason": reason})
        else:
            kept.append(row)
    kept_paths = {row["path"] for row in kept}
    removed_paths = {row["path"] for row in removed}
    archived_licenses = union & removed_paths
    if not union.issubset(kept_paths | archived_licenses):
        raise ValueError("The union of license inventories was not retained")
    return {
        "before": totals(rows),
        "removed": totals(removed),
        "remaining": totals(kept),
        "licenseCounts": {
            "inventory": len(licenses),
            "earlierClassifier": len(earlier),
            "overlap": len(licenses & earlier),
            "retainedUnion": len(union),
        },
        "files": removed,
        "archivedLicenseFiles": sorted(archived_licenses),
    }


def ordinary(path, root):
    path.relative_to(root)
    for item in (path, *path.parents):
        stat = item.lstat()
        if item.is_symlink() or getattr(stat, "st_file_attributes", 0) & 0x400:
            raise ValueError("Partition path is a link or reparse point: " + str(item))
        if item == root:
            break
    if not path.is_file():
        raise ValueError("Partition input is not an ordinary file: " + str(path))


def checked_bytes(root, row):
    path = root / row["path"]
    ordinary(path, root)
    data = path.read_bytes()
    if len(data) != row["bytes"] or sha256(data) != row["sha256"]:
        raise ValueError("Candidate bytes changed before partition: " + row["path"])
    return data


def verify_archive(path, rows):
    expected = {row["path"]: row for row in rows}
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != set(expected):
            raise ValueError("Diagnostics archive membership differs from the plan")
        for member in members:
            row = expected[member.name]
            if not member.isfile() or member.size != row["bytes"]:
                raise ValueError("Diagnostics archive member is invalid")
            if sha256(archive.extractfile(member).read()) != row["sha256"]:
                raise ValueError("Diagnostics archive member hash differs")


def partition_copy(root, payload, diagnostics, protected=()):
    """Data-only engine, also exercised on synthetic fixtures. Real use goes through prepare."""
    root, diagnostics = Path(root).resolve(strict=True), Path(diagnostics).resolve()
    if (
        diagnostics.is_relative_to(root)
        or root.is_relative_to(diagnostics)
        or diagnostics.exists()
    ):
        raise ValueError("Diagnostics must be a fresh directory outside the runtime")
    plan = make_plan(payload, protected)
    for row in plan["files"]:
        checked_bytes(root, row)
    diagnostics.mkdir(parents=True)
    archives = []
    for group in ("development", "diagnostic-symbols", "unused-bundled-browser"):
        rows = [row for row in plan["files"] if row["group"] == group]
        path = diagnostics / (group + ".tar.gz")
        with path.open("xb") as destination:
            with gzip.GzipFile(
                fileobj=destination, mode="wb", filename="", mtime=0, compresslevel=6
            ) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    for row in rows:
                        data = checked_bytes(root, row)
                        info = tarfile.TarInfo(row["path"])
                        info.size, info.mode, info.mtime = len(data), 0o644, 0
                        archive.addfile(info, io.BytesIO(data))
        verify_archive(path, rows)
        archives.append(
            {
                "file": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256(path.read_bytes()),
                "content": totals(rows),
            }
        )
    # Check the complete set again before removing any bytes from the disposable copy.
    for row in plan["files"]:
        checked_bytes(root, row)
    for row in plan["files"]:
        (root / row["path"]).unlink()
    archived_license_paths = set(plan["archivedLicenseFiles"])
    license_rows = [row for row in plan["files"] if row["path"] in archived_license_paths]
    license_archive = root / "THIRD-PARTY-LICENSES.tar.gz"
    with license_archive.open("xb") as destination:
        with gzip.GzipFile(fileobj=destination, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for row in license_rows:
                    with tarfile.open(diagnostics / (row["group"] + ".tar.gz"), "r:gz") as prior:
                        data = prior.extractfile(row["path"]).read()
                    info = tarfile.TarInfo(row["path"])
                    info.size, info.mode, info.mtime = len(data), 0o644, 0
                    archive.addfile(info, io.BytesIO(data))
    removed_directories = []
    for name in sorted(
        payload.get("directories", []),
        key=lambda p: len(relative(p).parts),
        reverse=True,
    ):
        path = root / name
        if path.is_dir() and not any(path.iterdir()):
            path.rmdir()
            removed_directories.append(name)
    plan["installedLicenseArchive"] = {
        "file": license_archive.name,
        "bytes": license_archive.stat().st_size,
        "sha256": sha256(license_archive.read_bytes()),
        "content": totals(license_rows),
    }
    plan["removedEmptyProjectDirectories"] = removed_directories
    plan["archives"] = archives
    return plan


def prepare(root, source_inventory, diagnostics):
    if os.name != "nt" or os.environ.get("CI") != "true":
        raise ValueError("Real Hermes archive partitioning requires Windows CI")
    root = Path(root)
    source_bytes = Path(source_inventory).read_bytes()
    marker = json.loads(
        (root / "nemoclaw-windows-runtime.json").read_text(encoding="utf-8")
    )
    plan = partition_copy(
        root, json.loads(source_bytes), diagnostics, marker["generatedFiles"]
    )
    manifest = {
        "schemaVersion": 1,
        "classification": "official-hermes-production-partition",
        "sourceInventorySha256": sha256(source_bytes),
        "canonicalInputPreserved": True,
        "countsScope": "canonical input; excludes final metadata byte deltas, this receipt and later bytecode",
        "runtimeExecutionQualified": False,
        **plan,
    }
    encoded = (json.dumps(manifest, indent=2) + "\n").encode()
    (Path(diagnostics) / "partition-manifest.json").write_bytes(encoded)
    compact = {
        key: manifest[key]
        for key in (
            "schemaVersion",
            "classification",
            "sourceInventorySha256",
            "canonicalInputPreserved",
            "runtimeExecutionQualified",
            "countsScope",
            "before",
            "removed",
            "remaining",
            "licenseCounts",
            "archives",
        )
    }
    compact["manifestSha256"] = sha256(encoded)
    with (root / "production-partition.json").open("x", encoding="utf-8") as stream:
        json.dump(compact, stream, indent=2)
        stream.write("\n")
    return compact
