#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Patch the reviewed flat worker archive without weakening native manifest checks."""

import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

UPSTREAM_MANIFEST = "75cda1cfb2545eab51e89edcafebeb33b86c003cc0c52fbd9763abeeddc1b42b"
MODULES = {
    "sqlite-store.worker.mjs",
    "worker-chunk-CMCl78Z0.mjs",
    "worker-chunk-A05CVh6v.mjs",
    "worker-chunk-BS-ufNRt.mjs",
    "worker-chunk-ue1VvP9S.mjs",
    "worker-chunk-DjEXxQHh.mjs",
    "worker-chunk-DnMB5DVi.mjs",
    "worker-chunk-CJ_iECTX.mjs",
    "worker-chunk-sbeUcZ9t.mjs",
    "worker-chunk-DVgC0w97.mjs",
    "worker-chunk-ESi8iLHn.mjs",
    "worker-chunk-tcAUzPTe.mjs",
    "worker-chunk-CbW6oavy.mjs",
}
ENTRYPOINTS = {
    "code-mode-node.worker.mjs", "file-tool-planning.worker.mjs",
    "gateway-state-owner-heartbeat.worker.mjs", "github-exec-launcher.mjs",
    "image-processor.worker.mjs", "openclaw-state-read.worker.mjs",
    "service-child-group-anchor.mjs", "service-child-relay.mjs",
    "sqlite-store.worker.mjs", "worker-native-lifecycle.worker.mjs",
    "worker.mjs", "workspace-rsync-receiver.mjs",
}


def manifest_hash(entries):
    digest = hashlib.sha256(b"openclaw-worker-bundle-v1\0")
    for name, (size, sha256) in sorted(entries.items()):
        digest.update(f"{name}\0{0o700:o}\0{size}\0{sha256}\0".encode())
    return digest.hexdigest()


def file_identity(data):
    return len(data), hashlib.sha256(data).hexdigest()


def read_regular(path, limit):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError(f"Invalid or oversized worker input: {path.name}")
        data = source.read(limit + 1)
        if len(data) != info.st_size or len(data) > limit:
            raise ValueError(f"Worker input changed while reading: {path.name}")
        return data


def read_archive(data):
    """Only flat, unique, regular native artifacts are admitted; no extraction API."""
    files = {}
    total = 0
    # Bound decompression before tarfile parses extended headers or member sizes.
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
        expanded = compressed.read(144 * 1024 * 1024 + 1)
    if len(expanded) > 144 * 1024 * 1024:
        raise ValueError("Worker archive exceeds expanded tar size bound")
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
        for entry in archive:
            name = entry.name
            if (
                len(files) >= 6000 or name in files or not entry.isfile()
                or entry.mode != 0o700 or entry.sparse is not None
                or not (name in ENTRYPOINTS or re.fullmatch(r"worker-chunk-[A-Za-z0-9_-]+\.mjs", name))
                or entry.size < 0 or entry.size > 64 * 1024 * 1024
            ):
                raise ValueError(f"Unreviewed worker archive member: {name!r}")
            total += entry.size
            if total > 128 * 1024 * 1024:
                raise ValueError("Worker archive exceeds unpacked size bound")
            source = archive.extractfile(entry)
            if source is None:
                raise ValueError("Worker archive member is unreadable")
            value = source.read(entry.size + 1)
            if len(value) != entry.size:
                raise ValueError("Worker archive member length mismatch")
            files[name] = value
    if not ENTRYPOINTS.issubset(files) or not MODULES.issubset(files):
        raise ValueError("Worker archive is missing required modules")
    return files


def patch_archive(dist, node, patcher):
    if json.loads(read_regular(dist.parent / "package.json", 1024 * 1024))["version"] != "2026.10.5":
        raise ValueError("Unreviewed OpenClaw worker archive version")
    directory = dist / "worker-artifacts"
    if directory.is_symlink() or not directory.is_dir() or (dist / "worker").exists():
        raise ValueError("Unreviewed worker archive layout")
    archives = list(directory.iterdir())
    if len(archives) != 1 or not re.fullmatch(r"[a-f0-9]{64}\.tar\.gz", archives[0].name):
        raise ValueError("Expected exactly one content-addressed worker archive")
    archive_path = archives[0]
    files = read_archive(read_regular(archive_path, 40 * 1024 * 1024))
    identities = {name: file_identity(data) for name, data in files.items()}
    if archive_path.name != manifest_hash(identities) + ".tar.gz":
        raise ValueError("Worker archive name does not match its native manifest")
    restored = dict(identities)
    inventory_path = dist / "postinstall-inventory.json"
    inventory = json.loads(read_regular(inventory_path, 4 * 1024 * 1024))
    old_relative = "dist/worker-artifacts/" + archive_path.name
    if not isinstance(inventory, list) or any(not isinstance(item, str) for item in inventory) or inventory.count(old_relative) != 1:
        raise ValueError("Worker archive is not uniquely owned by the postinstall inventory")
    with tempfile.TemporaryDirectory(prefix=".nemoclaw-worker-", dir=dist) as temporary:
        stage = Path(temporary)
        for name in sorted(MODULES):
            module_path = stage / name
            module_path.write_bytes(files[name])
            result = subprocess.run(
                [node, patcher, "--archive-module", name, str(module_path)],
                check=True, capture_output=True, text=True, timeout=30,
            )
            proof = json.loads(result.stdout)
            restored[name] = proof["originalSize"], proof["originalSha256"]
            files[name] = read_regular(module_path, 64 * 1024 * 1024)
        if manifest_hash(restored) != UPSTREAM_MANIFEST:
            raise ValueError("Worker archive does not restore to the reviewed upstream manifest")
        updated_hash = manifest_hash({name: file_identity(data) for name, data in files.items()})
        updated_path = directory / (updated_hash + ".tar.gz")
        if updated_path == archive_path:
            return False
        output = stage / "worker.tar.gz"
        with output.open("xb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                    for name, data in sorted(files.items()):
                        entry = tarfile.TarInfo(name)
                        entry.size = len(data)
                        entry.mode = 0o700
                        archive.addfile(entry, io.BytesIO(data))
            raw.flush()
            os.fsync(raw.fileno())
        inventory[inventory.index(old_relative)] = "dist/worker-artifacts/" + updated_path.name
        updated_inventory = stage / "inventory.json"
        updated_inventory.write_text(json.dumps(inventory, indent=2) + "\n")
        # Build-time publication: prepare both artifacts before replacing either.
        # Never mutate the installed archive while parsing or classifying it.
        os.link(output, updated_path)
        os.replace(updated_inventory, inventory_path)
        archive_path.unlink()
    return True


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: patch-openclaw-worker-archive.py <dist> <node> <patcher>")
    print(json.dumps({"changed": patch_archive(Path(sys.argv[1]).resolve(), sys.argv[2], sys.argv[3])}))
