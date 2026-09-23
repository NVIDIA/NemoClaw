# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Bind the Brev image transfer to its source revision, archive, and OCI digest."""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


def archive_hash(root):
    digest = hashlib.sha256()
    with (root / "image.tar").open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def record(root, revision):
    metadata = json.loads((root / "metadata.json").read_text())
    digest = metadata["openclaw"]["containerimage.digest"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("build did not produce an immutable image digest")
    manifest = {
        "revision": revision,
        "sha256": archive_hash(root),
        "image": f"nc-fabric@{digest}",
    }
    (root / "candidate.json").write_text(json.dumps(manifest) + "\n")


def load(root, revision):
    manifest = json.loads((root / "candidate.json").read_text())
    if manifest["revision"] != revision:
        raise ValueError("candidate source revision mismatch")
    if manifest["sha256"] != archive_hash(root):
        raise ValueError("candidate archive checksum mismatch")
    if not re.fullmatch(r"nc-fabric@sha256:[0-9a-f]{64}", manifest["image"]):
        raise ValueError("candidate image digest is invalid")
    subprocess.run(
        ["docker", "image", "load", "-i", str(root / "image.tar")], check=True
    )
    image = json.loads(
        subprocess.check_output(["docker", "image", "inspect", "nc-fabric:openclaw"])
    )[0]
    if image["Os"] != "linux" or image["Architecture"] != "amd64":
        raise ValueError("candidate image must target linux/amd64")
    if manifest["image"] not in image["RepoDigests"]:
        raise ValueError(
            "loaded candidate does not retain the build's repository digest"
        )
    (root / "image-ref").write_text(manifest["image"] + "\n")
    return manifest["image"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["record", "load"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("revision")
    args = parser.parse_args()
    {"record": record, "load": load}[args.command](args.directory, args.revision)
