# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Prepare a candidate CUDA runtime from the pinned Hermes MSIX without installing it.

The output is a build input, not an installed or qualified inference service.
Model weights are downloaded separately. Nothing from the archive is executed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import xml.etree.ElementTree as ET
import zipfile


CATALOG = Path(__file__).parents[1] / "runtime/native-local-models.json"
REQUIRED = {"llama-server.exe", "llama-server-impl.dll", "llama.dll", "ggml.dll",
            "ggml-base.dll", "ggml-cpu.dll", "ggml-cuda.dll", "cudart64_13.dll",
            "cublas64_13.dll", "cublasLt64_13.dll"}


def regular(path: Path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("The bundle must be an ordinary, singly linked file.")
    return info


def read_small(archive: zipfile.ZipFile, name: str) -> bytes:
    entry = archive.getinfo(name)
    if entry.file_size > 1024 * 1024:
        raise ValueError("Bundle metadata exceeds its size limit.")
    return archive.read(entry)


def verify_pe(path: Path):
    with path.open("rb") as source:
        header = source.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ValueError("An inference binary has no PE header.")
        offset = struct.unpack_from("<I", header, 60)[0]
        if offset > 1024 * 1024 or offset < 64:
            raise ValueError("An inference binary has an invalid PE offset.")
        source.seek(offset)
        if source.read(6) != b"PE\0\0\x64\xaa":
            raise ValueError("An inference binary is not native ARM64.")


def prepare(bundle: Path, output: Path, catalog: dict):
    engine = catalog["engine"]
    before = regular(bundle)
    if output.exists() or output.is_symlink():
        raise ValueError("The inference output must be fresh.")
    parent = output.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or getattr(parent, "st_file_attributes", 0) & 0x400 or output.parent.is_symlink():
        raise ValueError("The inference output parent must be an ordinary directory.")
    with bundle.open("rb") as source:
        opened = os.fstat(source.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("The bundle changed before verification.")
        if opened.st_size != engine["bundleBytes"] or hashlib.file_digest(source, "sha256").hexdigest() != engine["bundleSha256"]:
            raise ValueError("The bundle differs from its pinned size or SHA-256.")
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            names = [entry.filename for entry in archive.infolist()]
            if len(names) != len(set(names)):
                raise ValueError("The bundle contains duplicate entries.")
            manifest = ET.fromstring(read_small(archive, "AppxManifest.xml"))
            identity = manifest.find("{http://schemas.microsoft.com/appx/manifest/foundation/windows10}Identity")
            if identity is None or any(identity.get(key) != value for key, value in {
                "Name": engine["packageIdentity"], "Version": engine["packageVersion"],
                "ProcessorArchitecture": engine["architecture"],
            }.items()):
                raise ValueError("The package identity differs from the pinned bundle.")
            payload = json.loads(read_small(archive, "app/resources/agent-payload/manifest.json"))
            if payload.get("ref") != engine["sourceRevision"] or payload.get("target") != "win32-arm64":
                raise ValueError("The Hermes payload revision differs from its pin.")
            selected = []
            seen = set()
            for entry in archive.infolist():
                if not entry.filename.startswith(engine["prefix"]) or entry.is_dir():
                    continue
                name = entry.filename[len(engine["prefix"]):]
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:exe|dll)", name) or name.lower() in seen:
                    raise ValueError("The CUDA payload has an unsafe or duplicate filename.")
                mode = entry.external_attr >> 16
                if stat.S_ISLNK(mode) or entry.flag_bits & 1 or entry.file_size > 512 * 1024 * 1024:
                    raise ValueError("The CUDA payload contains an unsupported entry.")
                seen.add(name.lower())
                selected.append((entry, name))
            if not {name.lower() for name in REQUIRED}.issubset(seen) or sum(entry.file_size for entry, _ in selected) > 1024**3:
                raise ValueError("The CUDA runtime is incomplete or exceeds its size limit.")
            output.mkdir()
            try:
                (output / "bin").mkdir()
                rows = []
                for entry, name in selected:
                    destination = output / "bin" / name
                    digest = hashlib.sha256()
                    size = 0
                    with archive.open(entry) as incoming, destination.open("xb") as target:
                        while chunk := incoming.read(1024 * 1024):
                            size += len(chunk)
                            if size > entry.file_size:
                                raise ValueError("An inference binary exceeded its declared size.")
                            digest.update(chunk)
                            target.write(chunk)
                    if size != entry.file_size:
                        raise ValueError("An inference binary was truncated.")
                    verify_pe(destination)
                    rows.append({"path": "bin/" + name, "bytes": size, "sha256": digest.hexdigest()})
                after = os.fstat(source.fileno())
                named = regular(bundle)
                if any((value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns) !=
                       (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                       for value in (after, named)):
                    raise ValueError("The bundle changed during preparation.")
                receipt = {"schemaVersion": 1, "classification": "candidate-native-inference-runtime",
                           "engine": engine, "modelsBundled": False,
                           "files": sorted(rows, key=lambda row: row["path"]),
                           "signatureVerified": False, "redistributionApproved": False,
                           "qualification": "not-run"}
                with (output / "runtime.json").open("x", encoding="utf-8") as target:
                    json.dump(receipt, target, indent=2)
                    target.write("\n")
                return receipt
            except BaseException:
                # This fresh directory belongs only to this preparation attempt.
                shutil.rmtree(output)
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    receipt = prepare(args.bundle, args.output, catalog)
    print(json.dumps({"status": "prepared", "files": len(receipt["files"]),
                      "modelsBundled": False, "qualification": "not-run"}))


if __name__ == "__main__":
    main()
