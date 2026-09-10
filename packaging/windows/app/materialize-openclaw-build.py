# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Restore exact published app/compiler bytes in CI; never executes package hooks."""
import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import tarfile
import time
import urllib.parse
import urllib.request


def require(value, message):
    if not value:
        raise ValueError(message)


def safe_parts(value, allow_current=False):
    require(isinstance(value, str) and value and "\\" not in value, "Invalid package path.")
    require(not value.startswith("/"), "Absolute package path.")
    parts = value.rstrip("/").split("/")
    if allow_current:
        parts = [part for part in parts if part != "."]
    require(parts, "Empty package path.")
    devices = {"CON", "PRN", "AUX", "NUL", "CLOCK$"} | {
        prefix + digit for prefix in ("COM", "LPT") for digit in "123456789¹²³"
    }
    for part in parts:
        require(part not in ("", ".", "..") and part[-1:] not in (".", " "), "Aliased package path.")
        require(not any(ord(char) < 32 or char in '<>:"|?*' for char in part), "Invalid Windows package path character.")
        require(part.split(".", 1)[0].upper() not in devices, "Reserved Windows package path.")
    return tuple(parts)


def fetch(item, cache, deadline):
    url = item["url"]
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.hostname == "registry.npmjs.org", "Unexpected package source.")
    filename = cache / (hashlib.sha256(url.encode()).hexdigest() + ".tgz")
    if not filename.exists():
        temporary = filename.with_suffix(".part")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept-Encoding": "identity"}), timeout=30) as response, temporary.open("xb") as target:
            count = 0
            while data := response.read(1024 * 1024):
                count += len(data)
                require(count <= 128 * 1024 * 1024 and time.monotonic() < deadline, "Package download exceeds its bound.")
                target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, filename)
    data = filename.read_bytes()
    require(len(data) <= 128 * 1024 * 1024, "Oversized package archive.")
    algorithm, expected = item["integrity"].split("-", 1)
    require(algorithm == "sha512" and hashlib.sha512(data).digest() == base64.b64decode(expected), "Package SRI mismatch.")
    if "sha256" in item:
        require(hashlib.sha256(data).hexdigest() == item["sha256"], "Package SHA256 mismatch.")
    if "bytes" in item:
        require(len(data) == item["bytes"], "Package archive length mismatch.")
    return {"url": url, "archive": str(filename), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "integrity": item["integrity"]}


def extract(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    files = 0
    total = 0
    with tarfile.open(archive, "r:gz") as source:
        prefix = None
        for member in source:
            parts = safe_parts(member.name, allow_current=True)
            prefix = parts[0] if prefix is None else prefix
            require(parts[0] == prefix, "Multiple package archive roots.")
            target = destination.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            require(member.isfile() and member.size <= 128 * 1024 * 1024, "Nonregular or oversized package member.")
            files += 1
            total += member.size
            require(files <= 50000 and total <= 1024 * 1024 * 1024, "Expanded package exceeds its bound.")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as incoming:
                data = incoming.read(member.size + 1)
            require(len(data) == member.size, "Truncated package member.")
            if target.exists() or target.is_symlink():
                require(target.is_file() and not target.is_symlink() and target.stat().st_nlink == 1, "Nonregular overlapping package path.")
                require(target.read_bytes() == data, "Overlapping package members differ.")
            else:
                with target.open("xb") as output:
                    output.write(data)
                os.chmod(target, member.mode & 0o755)
    return {"files": files, "bytes": total}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--lock", type=Path, default=Path(__file__).with_name("windows-app-build.lock.json"))
    parser.add_argument("--portable-proof", action="store_true")
    args = parser.parse_args()
    require(os.name == "nt" or args.portable_proof, "Materialization is a Windows CI operation.")
    require(not args.output.exists(), "A fresh build-input directory is required.")
    args.output.mkdir(parents=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    lock = json.loads(args.lock.read_text())
    require(lock["schemaVersion"] == 1, "Unknown application build lock.")
    deadline = time.monotonic() + 900
    source = fetch(lock["openclaw"], args.cache, deadline)
    package = args.output / "openclaw"
    source_inventory = extract(source["archive"], package)
    shrinkwrap = json.loads((package / "npm-shrinkwrap.json").read_text())
    require(shrinkwrap["name"] == "openclaw" and shrinkwrap["version"] == "2026.7.1" and shrinkwrap["lockfileVersion"] == 3, "Unexpected source shrinkwrap.")
    packages = shrinkwrap["packages"]
    requested = {item["resolved"]: {"url": item["resolved"], "integrity": item["integrity"]} for name, item in packages.items() if name}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
        archives = list(workers.map(lambda item: fetch(item, args.cache, deadline), requested.values()))
    by_url = {item["url"]: item for item in archives}
    dependencies = []
    for name, item in packages.items():
        if not name:
            continue
        components = safe_parts(name)
        require(name.startswith("node_modules/"), "Invalid locked package path.")
        inventory = extract(by_url[item["resolved"]]["archive"], package.joinpath(*components))
        dependencies.append({"path": name, "version": item["version"], "lifecycleScriptDeclared": item.get("hasInstallScript", False), **inventory})
    platform_package = "@esbuild/darwin-arm64" if args.portable_proof else "@esbuild/win32-arm64"
    compiler = []
    for item in lock["compilerPackages"]:
        if item["package"] not in ("esbuild", platform_package):
            continue
        archive = fetch(item, args.cache, deadline)
        inventory = extract(archive["archive"], args.output / "tools" / "node_modules" / item["package"])
        compiler.append({**archive, "package": item["package"], **inventory})
    receipt = {"schemaVersion": 1, "classification": "verified-application-build-inputs", "portableProof": args.portable_proof, "source": source, "sourceInventory": source_inventory, "dependencyArchives": archives, "dependencies": dependencies, "compiler": compiler, "lifecycleScriptsExecuted": False, "runtimeReady": False, "lockSha256": hashlib.sha256(args.lock.read_bytes()).hexdigest()}
    (args.output / "materialization-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"packages": len(dependencies), "sourceRoot": str(package), "toolRoot": str(args.output / "tools"), "runtimeReady": False}))


if __name__ == "__main__":
    main()
