# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Retain original Cargo and OpenSSL sources identified by pinned wheel metadata."""

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import tempfile
import tomllib
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def registry_sources(sboms, locks, sdists):
    sources = {}

    def add(name, version, checksum, openssl=False):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not re.fullmatch(
            r"[A-Za-z0-9_.+-]+", version
        ):
            raise ValueError("invalid Cargo package identity")
        if not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError(f"missing SHA-256 for {name} {version}")
        key = f"{name}-{version}" + (".tar.gz" if openssl else ".crate")
        if key in sources and sources[key][2] != checksum:
            raise ValueError(f"conflicting SHA-256 pins for {key}")
        url = (
            f"https://github.com/openssl/openssl/releases/download/openssl-{version}/{key}"
            if openssl
            else f"https://static.crates.io/crates/{name}/{key}"
        )
        sources[key] = (name, version, checksum, url)

    for root in sboms:
        for path in sorted(root.glob("**/*.dist-info/sboms/*.json")):
            for component in json.loads(path.read_text()).get("components", []):
                is_openssl = component.get("name") == "openssl" and component.get(
                    "purl", ""
                ).startswith("pkg:generic/openssl@")
                if is_openssl or component.get("bom-ref", "").startswith(
                    "registry+https://github.com/rust-lang/crates.io-index#"
                ):
                    hashes = {
                        h["content"].lower()
                        for h in component.get("hashes", [])
                        if h.get("alg") == "SHA-256"
                    }
                    if len(hashes) != 1:
                        raise ValueError(f"missing unique SHA-256 in {path}")
                    add(component["name"], component["version"], hashes.pop(), is_openssl)

    def read_lock(text):
        for package in tomllib.loads(text).get("package", []):
            if package.get("source") == "registry+https://github.com/rust-lang/crates.io-index":
                add(package["name"], package["version"], package.get("checksum", ""))

    for path in locks:
        read_lock(path.read_text())
    for path in sdists:
        with tarfile.open(path) as source:
            locks = [
                member
                for member in source
                if member.isfile() and member.name.endswith("/Cargo.lock")
            ]
            if not locks:
                print(
                    f"{path.name}: no Cargo.lock in this source distribution",
                    file=sys.stderr,
                )
            for member in locks:
                read_lock(source.extractfile(member).read().decode())
    return sources


def upstream_notices(directory, cache, sources):
    files = {}
    if directory is None:
        return files
    for filename in sources:
        if not filename.endswith(".crate"):
            continue
        manifest = vcs = None
        with tarfile.open(cache / filename, "r|gz") as archive:
            for member in archive:
                if not member.isfile() or member.name.count("/") != 1:
                    continue
                if member.name.endswith("/Cargo.toml"):
                    manifest = tomllib.loads(archive.extractfile(member).read().decode())
                if member.name.endswith("/.cargo_vcs_info.json"):
                    vcs = json.loads(archive.extractfile(member).read())
                if manifest is not None and vcs is not None:
                    break
        if manifest is None or vcs is None:
            continue
        repository = manifest.get("package", {}).get("repository", "")
        revision = vcs.get("git", {}).get("sha1", "")
        if not isinstance(repository, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
            continue
        match = re.search(r"github\.com[/:]([^/]+/[^/#]+)", repository)
        if match:
            repo = match[1].removesuffix(".git").lower().replace("/", "--")
            for path in directory.glob(f"rust-notice-{repo}--{revision.lower()}--*"):
                files["upstream-notices/" + path.name] = path
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sboms", type=Path, action="append", default=[])
    parser.add_argument("--lock", type=Path, action="append", default=[])
    parser.add_argument("--sdist", type=Path, action="append", default=[])
    parser.add_argument("--upstream-notices", type=Path)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.sboms and not args.lock and not args.sdist:
        parser.error("provide wheel SBOMs or a Cargo lockfile")
    sources = registry_sources(args.sboms, args.lock, args.sdist)
    args.cache.mkdir(parents=True, exist_ok=True)

    def fetch(item):
        filename, (name, version, expected, url) = item
        path = args.cache / filename
        if not path.exists():
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != expected:
                raise ValueError(f"source checksum mismatch: {name} {version}")
            with tempfile.NamedTemporaryFile(dir=args.cache, delete=False) as temp:
                temp.write(data)
            os.replace(temp.name, path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"cached source checksum mismatch: {name} {version}")

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch, sources.items()))
    supplemental = upstream_notices(args.upstream_notices, args.cache, sources)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False) as temp:
        try:
            with gzip.GzipFile(filename="", fileobj=temp, mode="wb", mtime=epoch) as zipped:
                with tarfile.open(fileobj=zipped, mode="w") as archive:
                    files = {name: args.cache / name for name in sources}
                    files.update({"python/" + path.name: path for path in args.sdist})
                    files.update(supplemental)
                    for filename, path in sorted(files.items()):
                        data = path.read_bytes()
                        if (
                            filename in sources
                            and hashlib.sha256(data).hexdigest() != sources[filename][2]
                        ):
                            raise ValueError(f"source changed during packaging: {filename}")
                        info = tarfile.TarInfo(filename)
                        info.size = len(data)
                        info.mode = 0o644
                        info.mtime = epoch
                        archive.addfile(info, io.BytesIO(data))
            temp.flush()
            os.chmod(temp.name, 0o644)
            os.replace(temp.name, args.output)
        finally:
            Path(temp.name).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
