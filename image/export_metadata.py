#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Export digest-bound image metadata from a local OCI archive without publishing an image."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 8 * 1024 * 1024
MANIFEST_TYPES = (
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
)
INDEX_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
)
CONFIG_TYPES = (
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
)
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
REFERENCE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@(sha256:[a-f0-9]{64})")
BLOB_PATH = re.compile(r"blobs/sha256/([a-f0-9]{64})")


class Error(Exception):
    pass


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def decode(raw):
    try:
        value = json.loads(raw, object_pairs_hook=object_pairs)
    except (ValueError, UnicodeError):
        raise Error("invalid image metadata JSON") from None
    if not isinstance(value, dict):
        raise Error("image metadata must be a JSON object")
    return value


def read_blobs(stream):
    blobs = {}
    total = 0
    try:
        with tarfile.open(fileobj=stream, mode="r|*") as archive:
            for member in archive:
                match = BLOB_PATH.fullmatch(member.name)
                if not match or not member.isfile() or member.size > LIMIT:
                    continue
                file = archive.extractfile(member)
                prefix = file.read(1)
                # OCI layers remain in the archive stream; only original JSON
                # metadata is retained, with no filesystem extraction.
                if prefix not in (b"{", b" ", b"\n", b"\t", b"\r"):
                    continue
                raw = prefix + file.read()
                try:
                    value = decode(raw)
                except Error:
                    continue
                if not (value.get("schemaVersion") == 2 or "architecture" in value):
                    continue
                digest = "sha256:" + match.group(1)
                if hashlib.sha256(raw).hexdigest() != match.group(1):
                    raise Error("image metadata content does not match its archive digest")
                if digest in blobs:
                    raise Error("archive contains duplicate image metadata")
                total += len(raw)
                if total > LIMIT or len(blobs) >= 128:
                    raise Error("image metadata exceeds the export limit")
                blobs[digest] = raw
    except (tarfile.TarError, OSError):
        raise Error("cannot read the local image archive") from None
    return blobs


def metadata_bundle(image, stream, platform, expected_id=None):
    reference = REFERENCE.fullmatch(image)
    if not reference:
        raise Error("select an immutable image reference with its SHA-256 digest")
    if platform not in ("linux/amd64", "linux/arm64"):
        raise Error("image metadata requires Linux AMD64 or ARM64")
    blobs = read_blobs(stream)
    selected = {}

    def get(digest, size=None):
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise Error("invalid image metadata descriptor digest")
        raw = blobs.get(digest)
        if raw is None:
            raise Error("archive lacks original OCI metadata; use Docker's containerd image store")
        if size is not None and (type(size) is not int or size != len(raw)):
            raise Error("image metadata descriptor size does not match its content")
        try:
            selected[digest] = raw.decode("utf-8")
        except UnicodeError:
            raise Error("image metadata must use UTF-8") from None
        return decode(raw)

    root = reference.group(1)
    manifest_digest = root
    manifest = get(root)
    if manifest.get("schemaVersion") != 2:
        raise Error("unsupported image metadata schema")
    if manifest.get("mediaType") in INDEX_TYPES:
        entries = manifest.get("manifests")
        if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
            raise Error("invalid image index")
        linux = [
            entry
            for entry in entries
            if isinstance(entry.get("platform"), dict) and entry["platform"].get("os") == "linux"
        ]
        # The cluster receives the immutable root reference. A different Linux
        # child could otherwise carry unverified runtime or policy metadata.
        if (
            len(linux) != 1
            or linux[0]["platform"].get("architecture") != platform.split("/")[1]
            or linux[0].get("mediaType") not in MANIFEST_TYPES
        ):
            raise Error("image index requires exactly one Linux manifest for the selected platform")
        descriptor = linux[0]
        if type(descriptor.get("size")) is not int:
            raise Error("invalid image manifest descriptor size")
        manifest_digest = descriptor.get("digest")
        manifest = get(manifest_digest, descriptor.get("size"))
        if manifest.get("mediaType") != descriptor["mediaType"]:
            raise Error("image manifest media type disagrees with its index descriptor")
    if manifest.get("schemaVersion") != 2 or manifest.get("mediaType") not in MANIFEST_TYPES:
        raise Error("unsupported image manifest")
    config = manifest.get("config")
    if not isinstance(manifest.get("layers"), list):
        raise Error("image manifest must declare its layers")
    if (
        not isinstance(config, dict)
        or type(config.get("size")) is not int
        or config.get("mediaType") not in CONFIG_TYPES
    ):
        raise Error("invalid image configuration descriptor")
    # Docker's containerd image store reports an index or manifest ID; older
    # stores report the configuration ID. All must belong to this verified chain.
    if expected_id is not None and expected_id not in (root, manifest_digest, config.get("digest")):
        raise Error("image archive disagrees with the selected local image identity")
    configuration = get(config.get("digest"), config["size"])
    if (
        configuration.get("os") != "linux"
        or configuration.get("architecture") != platform.split("/")[1]
    ):
        raise Error("image configuration does not match the selected platform")
    result = {"schema_version": 1, "manifest_digest": manifest_digest, "blobs": selected}
    if len(json.dumps(result).encode()) > LIMIT:
        raise Error("encoded image metadata exceeds the export limit")
    return result


def write_bundle(path, value):
    if not path.is_absolute() or ROOT in path.resolve().parents or ROOT in path.absolute().parents:
        raise Error("metadata output must be an absolute path outside the repository")
    raw = json.dumps(value, indent=2).encode() + b"\n"
    if len(raw) > LIMIT:
        raise Error("encoded image metadata exceeds the export limit")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        raise Error("metadata output must be a new file in an existing private directory") from None
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
    except OSError:
        path.unlink(missing_ok=True)
        raise Error("cannot write image metadata") from None


def inspect_local(image, docker):
    try:
        result = subprocess.run(
            [*docker, "image", "inspect", image], capture_output=True, timeout=30
        )
        if result.returncode or len(result.stdout) > LIMIT:
            raise Error("cannot inspect the selected local image")
        values = json.loads(result.stdout)
        if not isinstance(values, list) or len(values) != 1:
            raise Error("local image inspection is incomplete")
        value = values[0]
        platform = value["Os"] + "/" + value["Architecture"]
        digest = value["Id"]
        if platform not in ("linux/amd64", "linux/arm64") or not DIGEST.fullmatch(digest):
            raise Error("local image has no supported immutable platform identity")
        return platform, digest
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        raise Error("cannot inspect the selected local image") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--archive", type=Path, help="read an existing local OCI archive instead of Docker"
    )
    parser.add_argument("--platform", choices=("linux/amd64", "linux/arm64"))
    parser.add_argument(
        "--sudo-docker",
        action="store_true",
        help="reuse existing noninteractive sudo access for Docker only",
    )
    args = parser.parse_args()
    try:
        if not REFERENCE.fullmatch(args.image):
            raise Error("select an immutable image reference with its SHA-256 digest")
        if args.archive:
            if not args.platform:
                raise Error("--archive requires an explicit --platform")
            with args.archive.open("rb") as source:
                proof = metadata_bundle(args.image, source, args.platform)
        else:
            docker = ["sudo", "-n", "docker"] if args.sudo_docker else ["docker"]
            platform, identity = inspect_local(args.image, docker)
            if args.platform and args.platform != platform:
                raise Error("requested platform disagrees with the selected local image")
            with subprocess.Popen(
                [*docker, "image", "save", args.image],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            ) as process:
                try:
                    proof = metadata_bundle(args.image, process.stdout, platform, identity)
                    if process.wait() != 0:
                        raise Error("local Docker image export failed")
                except BaseException:
                    process.kill()
                    process.wait()
                    raise
        write_bundle(args.output, proof)
        print("Exported verified image metadata; no image was published.")
        return 0
    except (Error, OSError) as error:
        print(
            str(error) if isinstance(error, Error) else "Local image metadata export failed",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
