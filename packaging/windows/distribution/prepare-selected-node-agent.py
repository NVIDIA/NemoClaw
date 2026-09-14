# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Build and prune one locked Node agent in Windows CI."""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile

AGENTS = {"pi": ("agents/pi/pi-runtime", "@earendil-works/pi-coding-agent", "0.84.1")}
REMOVE_DIRS = {"test", "tests", "__tests__", "docs", "doc", "examples", "example", ".github", ".idea", "coverage", "bench", "benchmark"}
REMOVE_SUFFIXES = (".map", ".d.ts", ".d.mts", ".d.cts", ".tsbuildinfo")


def package_relative(path, runtime_root):
    """Return a file's path within its nearest installed npm package."""
    parent = path.parent
    while parent != runtime_root:
        if (parent / "package.json").is_file():
            return path.relative_to(parent)
        parent = parent.parent
    return path.relative_to(runtime_root)


def development_file(path, runtime_root):
    relative = path.relative_to(runtime_root)
    if "node_modules" not in relative.parts:
        return False
    within_package = package_relative(path, runtime_root)
    return (
        bool(within_package.parts)
        and within_package.parts[0].lower() in REMOVE_DIRS
    ) or path.name.endswith(REMOVE_SUFFIXES)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def files(root):
    result = []
    for path in sorted(Path(root).rglob("*")):
        info = path.lstat()
        if path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("The selected Node runtime contains a redirected path.")
        if stat.S_ISREG(info.st_mode):
            result.append(path)
        elif not stat.S_ISDIR(info.st_mode):
            raise ValueError("The selected Node runtime contains a special path.")
    return result


def totals(root):
    rows = files(root)
    return {"files": len(rows), "logicalBytes": sum(path.stat().st_size for path in rows)}


def prepare(agent, source, node, npm, output):
    relative, package, version = AGENTS[agent]
    manifest_root = source / relative
    lock_sha = digest(manifest_root / "package-lock.json")
    output.mkdir()
    shutil.copy2(manifest_root / "package.json", output / "package.json")
    shutil.copy2(manifest_root / "package-lock.json", output / "package-lock.json")
    subprocess.run(
        [str(node), str(npm), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=output,
        env={**os.environ, "npm_config_cache": str(output.parent / "npm-cache")},
        check=True,
        timeout=600,
    )
    if digest(output / "package-lock.json") != lock_sha:
        raise ValueError("npm changed the selected agent lock.")
    installed = json.loads((output / "node_modules" / package / "package.json").read_text())
    if installed.get("name") != package or installed.get("version") != version:
        raise ValueError("The installed Node agent differs from its lock.")
    before = totals(output)
    license_files = [
        path
        for path in files(output)
        if any(token in path.name.lower() for token in ("license", "copying", "notice", "copyright"))
    ]
    archive = output / "THIRD-PARTY-LICENSES.tar.gz"
    with archive.open("xb") as destination:
        with gzip.GzipFile(fileobj=destination, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as tar:
                for path in license_files:
                    data = path.read_bytes()
                    info = tarfile.TarInfo(path.relative_to(output).as_posix())
                    info.size, info.mode, info.mtime = len(data), 0o644, 0
                    tar.addfile(info, io.BytesIO(data))
    removed = []
    for path in reversed(files(output)):
        relative_path = path.relative_to(output)
        if path == archive or "node_modules" not in relative_path.parts:
            continue
        if development_file(path, output):
            path.unlink()
            removed.append(relative_path.as_posix())
    (output / "package-lock.json").unlink()
    for directory in sorted((path for path in output.rglob("*") if path.is_dir()), key=lambda path: len(path.parts), reverse=True):
        if not any(directory.iterdir()):
            directory.rmdir()
    after = totals(output)
    receipt = {
        "schemaVersion": 1,
        "classification": "finished-selected-node-agent",
        "agent": agent,
        "upstream": {"package": package, "version": version},
        "sourceLockSha256": lock_sha,
        "nodeSha256": digest(node),
        "npmVersion": "10.9.8",
        "before": before,
        "after": after,
        "removedFiles": len(removed) + 1,
        "licenseArchive": {"file": archive.name, "bytes": archive.stat().st_size, "sha256": digest(archive), "sourceFiles": len(license_files)},
        "customerBuildRequired": False,
        "runtimeLaunchCopiesRequired": False,
        "installedQualification": False,
    }
    (output / "selected-agent-build.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", choices=AGENTS, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--npm-cli", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("Selected Node agents are prepared only in Windows CI.")
    print(json.dumps(prepare(args.agent, args.source_root, args.node, args.npm_cli, args.output)))


if __name__ == "__main__":
    main()
