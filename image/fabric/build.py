# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Build a local native Linux Fabric image from a verified source archive.

Requires Docker, uv, and a native C/Rust build toolchain (maturin can provision
Rust in its cache). Python and Rust build tools remain development dependencies.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request

REVISION = "51a28c1aefec56abd877070b6973d0a32a1e3003"
SOURCE_HASH = "14fab1b7094e41f2056051316cff7f84bd7e0f294b2c6aa1c09a30085b4406cf"
ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / ".build/fabric"


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    if platform.system() != "Linux" or platform.machine() != "aarch64":
        raise SystemExit("This first image recipe is qualified only for native Linux ARM64")
    BUILD.mkdir(parents=True, exist_ok=True)
    archive = BUILD / "source.tar.gz"
    if not archive.exists():
        with urllib.request.urlopen(f"https://codeload.github.com/NVIDIA/NeMo-Fabric/tar.gz/{REVISION}", timeout=60) as response:
            archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SOURCE_HASH:
        raise SystemExit("Fabric source checksum mismatch")
    with tarfile.open(archive) as source:
        source.extractall(BUILD, filter="data")
    source = BUILD / f"NeMo-Fabric-{REVISION}"
    own_wheels = BUILD / "own-wheels"
    own_wheels.mkdir(exist_ok=True)
    env = dict(os.environ, SOURCE_DATE_EPOCH="1789171200")
    for package in ("sdk/python/nemo-fabric-runtime", "adapter-contract/python",
                    "adapters/python/common", "adapters/python/deepagents"):
        args = ["uv", "build", "--python", "3.13", "--wheel", "--out-dir", str(own_wheels)]
        if package.endswith("nemo-fabric-runtime"):
            args += ["--config-setting", "build-args=--locked"]
        run(*args, str(source / package), env=env)
    lock = (ROOT / "image/fabric/dependencies.lock").read_text()
    wheels = sorted(own_wheels.glob("*.whl"))
    if len(wheels) != 4:
        raise SystemExit("Expected exactly four native/source Fabric wheels")
    for wheel in wheels:
        name = wheel.name.split("-", 1)[0].replace("_", "-")
        lock += f"{name}==0.4.0 --hash=sha256:{hashlib.sha256(wheel.read_bytes()).hexdigest()}\n"
    (BUILD / "requirements.txt").write_text(lock)
    run("uv", "venv", "--allow-existing", "--python", "3.13", str(BUILD / "download-venv"))
    python = str(BUILD / "download-venv/bin/python")
    run("uv", "pip", "install", "--python", python, "pip==26.2.1")
    run(python, "-m", "pip", "download", "--only-binary=:all:", "--require-hashes",
        "--find-links", str(own_wheels), "-r", str(BUILD / "requirements.txt"), "-d", str(BUILD / "wheels"))
    for name in ("Dockerfile", "fabric.py"):
        shutil.copyfile(ROOT / "image/fabric" / name, BUILD / name)
    (BUILD / "provenance.json").write_text(json.dumps({
        "fabric_revision": REVISION, "source_sha256": SOURCE_HASH,
        "harness": "deepagents", "version": "0.7.13",
        "requirements_sha256": hashlib.sha256(lock.encode()).hexdigest(),
    }, indent=2) + "\n")
    run("docker", "build", "-t", "nc-prototype-fabric:deepagents", str(BUILD))
    run("docker", "image", "inspect", "nc-prototype-fabric:deepagents", "--format", "{{index .RepoDigests 0}}")


if __name__ == "__main__":
    main()
