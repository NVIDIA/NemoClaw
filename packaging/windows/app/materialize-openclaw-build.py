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


def dependency_plan(lock, lock_file):
    """Keep the canonical wrapper's hoisted and nested package locations intact."""
    dependency_lock = lock["dependencyLock"]
    lock_path = (lock_file.parent / dependency_lock["path"]).resolve()
    lock_bytes = lock_path.read_bytes()
    require(hashlib.sha256(lock_bytes).hexdigest() == dependency_lock["sha256"], "Dependency lock SHA256 mismatch.")
    document = json.loads(lock_bytes)
    require(document.get("name") == "nemoclaw-openclaw-runtime" and document.get("lockfileVersion") == 3, "Unexpected runtime dependency lock.")
    packages = document["packages"]
    core_path = "node_modules/openclaw"
    core = packages[core_path]
    expected = lock["openclaw"]
    require(packages[""]["dependencies"]["openclaw"] == expected["version"], "Runtime wrapper version differs from the selected source.")
    require(core["version"] == expected["version"] and core["resolved"] == expected["url"] and core["integrity"] == expected["integrity"], "Runtime source differs from the dependency lock.")
    requested = {}
    destinations = set()
    plan = []
    for name, item in packages.items():
        if not name:
            continue
        parts = safe_parts(name)
        remaining = list(parts)
        while remaining:
            require(len(remaining) >= 2 and remaining.pop(0) == "node_modules", "Invalid locked package location.")
            package_name = remaining.pop(0)
            if package_name.startswith("@"):
                require(len(package_name) > 1 and remaining and not remaining[0].startswith("@"), "Invalid scoped package location.")
                remaining.pop(0)
        require(name.casefold() not in destinations and not item.get("link"), "Aliased or linked dependency location.")
        destinations.add(name.casefold())
        require(isinstance(item.get("version"), str) and item["version"], "Missing locked dependency version.")
        archive = {"url": item["resolved"], "integrity": item["integrity"]}
        if archive["url"] in requested:
            require(requested[archive["url"]]["integrity"] == archive["integrity"], "Conflicting dependency archive integrity.")
        requested[archive["url"]] = archive
        plan.append((name, parts, item))
    return lock_bytes, core_path, plan, requested


def choice_dependency_plan(lock, lock_file, core_plan):
    """Complete published channel bundles from main's approved messaging lock."""
    selected = lock.get("choiceDependencyLock")
    if selected is None:
        return None, []
    raw = (lock_file.parent / selected["path"]).resolve().read_bytes()
    require(hashlib.sha256(raw).hexdigest() == selected["sha256"], "Choice dependency lock SHA256 mismatch.")
    document = json.loads(raw)
    require(document.get("name") == "nemoclaw-managed-image-messaging-runtime" and document.get("lockfileVersion") == 3, "Unexpected choice dependency lock.")
    packages = document["packages"]
    additional = {item["package"]: item for item in lock["additionalPackages"]}
    plan = []
    for name in selected["packages"]:
        item = additional[name]
        prefix = "node_modules/" + name
        owner = packages[prefix]
        require(owner["version"] == item["version"] and owner["resolved"] == item["url"] and owner["integrity"] == item["integrity"], "Choice package differs from its dependency lock.")
        target = safe_parts(item["target"])
        require(target[:1] == ("plugins",), "Choice dependencies require the plugins namespace.")
        for location, dependency in packages.items():
            if location.startswith(prefix + "/node_modules/"):
                suffix = location[len(prefix) + 1:]
                plan.append(("/".join((*target, *safe_parts(suffix))), location.rsplit("node_modules/", 1)[1], dependency))
    core = {name: item for name, _, item in core_plan}
    for name in selected["sharedPackages"]:
        location = "node_modules/" + name
        safe_parts(location)
        item = packages[location]
        if location in core:
            require(all(core[location][field] == item[field] for field in ("version", "resolved", "integrity")), "Conflicting shared choice dependency.")
        plan.append((location, name, item))
    seen = set()
    for location, _, item in plan:
        require(location.casefold() not in seen and not item.get("link"), "Aliased or linked choice dependency.")
        seen.add(location.casefold())
        require(isinstance(item.get("version"), str) and item["version"], "Missing choice dependency version.")
        require(item.get("inBundle") or (item.get("resolved") and item.get("integrity")), "Choice dependency has no verified source.")
    return raw, plan


def restore_choice_dependencies(plan, output, cache, deadline):
    restored = []
    for location, name, item in plan:
        destination = output.joinpath(*safe_parts(location))
        metadata_file = destination / "package.json"
        archive = None
        if not metadata_file.exists():
            require(item.get("resolved") and item.get("integrity"), "Missing bundled choice dependency has no pinned archive.")
            archive = fetch({"url": item["resolved"], "integrity": item["integrity"]}, cache, deadline)
            extract(archive["archive"], destination)
        metadata = json.loads(metadata_file.read_text())
        require(metadata["name"] == name and metadata["version"] == item["version"], "Choice dependency identity differs from the canonical lock.")
        restored.append({"path": location, "package": name, "version": item["version"], "archive": archive})
    return restored


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--lock", type=Path, default=Path(__file__).with_name("windows-app-build.lock.json"))
    parser.add_argument("--portable-proof", action="store_true")
    args = parser.parse_args()
    require(os.name == "nt" or args.portable_proof, "Materialization is a Windows CI operation.")
    require(not args.output.exists(), "A fresh build-input directory is required.")
    lock = json.loads(args.lock.read_text())
    require(lock["schemaVersion"] == 1, "Unknown application build lock.")
    dependency_lock_bytes, core_path, plan, requested = dependency_plan(lock, args.lock)
    choice_lock_bytes, choice_plan = choice_dependency_plan(lock, args.lock, plan)
    args.output.mkdir(parents=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 900
    source = fetch(lock["openclaw"], args.cache, deadline)
    package = args.output.joinpath(*safe_parts(core_path))
    source_inventory = extract(source["archive"], package)
    metadata = json.loads((package / "package.json").read_text())
    require(metadata["name"] == "openclaw" and metadata["version"] == lock["openclaw"]["version"], "Unexpected source package identity.")
    del requested[lock["openclaw"]["url"]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
        archives = list(workers.map(lambda item: fetch(item, args.cache, deadline), requested.values()))
    by_url = {item["url"]: item for item in archives}
    by_url[source["url"]] = source
    dependencies = []
    for name, components, item in plan:
        if name == core_path:
            continue
        inventory = extract(by_url[item["resolved"]]["archive"], args.output.joinpath(*components))
        dependencies.append({"path": name, "version": item["version"], "lifecycleScriptDeclared": item.get("hasInstallScript", False), **inventory})
    platform_package = "@esbuild/darwin-arm64" if args.portable_proof else "@esbuild/win32-arm64"
    compiler = []
    for item in lock["compilerPackages"]:
        if item["package"] not in ("esbuild", platform_package, "yaml"):
            continue
        archive = fetch(item, args.cache, deadline)
        inventory = extract(archive["archive"], args.output / "tools" / "node_modules" / item["package"])
        compiler.append({**archive, "package": item["package"], **inventory})
    additional = []
    for item in lock.get("additionalPackages", []):
        target = safe_parts(item["target"])
        require(target[:1] == ("plugins",), "Additional app inputs require the plugins namespace.")
        archive = fetch(item, args.cache, deadline)
        inventory = extract(archive["archive"], args.output.joinpath(*target))
        additional.append({**archive, "package": item["package"], "version": item["version"], "target": item["target"], **inventory})
    choice_dependencies = restore_choice_dependencies(choice_plan, args.output, args.cache, deadline)
    choice_lock = None
    if choice_lock_bytes is not None:
        with (args.output / "choice-package-lock.json").open("xb") as choice_output:
            choice_output.write(choice_lock_bytes)
        choice_lock = {"path": "choice-package-lock.json", "sha256": hashlib.sha256(choice_lock_bytes).hexdigest()}
    with (args.output / "runtime-package-lock.json").open("xb") as dependency_output:
        dependency_output.write(dependency_lock_bytes)
    receipt = {"schemaVersion": 1, "classification": "verified-application-build-inputs", "portableProof": args.portable_proof, "source": source, "sourceRoot": core_path, "sourceInventory": source_inventory, "dependencyLock": {"path": "runtime-package-lock.json", "sha256": hashlib.sha256(dependency_lock_bytes).hexdigest()}, "dependencyArchives": archives, "dependencies": dependencies, "compiler": compiler, "additionalPackages": additional, "lifecycleScriptsExecuted": False, "runtimeReady": False, "lockSha256": hashlib.sha256(args.lock.read_bytes()).hexdigest()}
    receipt["choiceDependencyLock"] = choice_lock
    receipt["choiceDependencies"] = choice_dependencies
    (args.output / "materialization-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"packages": len(dependencies), "sourceRoot": str(package), "toolRoot": str(args.output / "tools"), "runtimeReady": False}))


if __name__ == "__main__":
    main()
