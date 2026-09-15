# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Build a local native Linux Fabric image from a verified source archive.

Requires Docker, uv, and a native C/Rust build toolchain (maturin can provision
Rust in its cache). Python and Rust build tools remain development dependencies.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
from patch_pi import patch_pi
from patch_hermes import patch_hermes
import platform
import shutil
import subprocess
import tarfile
import urllib.request

REVISION = "51a28c1aefec56abd877070b6973d0a32a1e3003"
SOURCE_HASH = "14fab1b7094e41f2056051316cff7f84bd7e0f294b2c6aa1c09a30085b4406cf"
ROOT = Path(__file__).resolve().parents[2]
HERMES_REVISION = "29112bef099274229cadff79cdff7bf7b99c4b77"
HERMES_HASH = "76b99a8be9b77d66833c3cfe2b35c6d6f6a58e4ff9637ef8effcfc1f420ab35a"


HARNESSES = ("deepagents", "hermes", "openclaw", "claude", "codex", "mini-swe-agent", "nooa", "nooa-bench", "remote-agent", "pi")


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--harness", choices=HARNESSES, default="deepagents")
    parser.add_argument("--tag", help="Local output image tag")
    args = parser.parse_args()
    harness = args.harness
    image_tag = args.tag or f"nc-prototype-fabric:{harness}"
    BUILD = ROOT / (".build/fabric" if harness == "deepagents" else f".build/fabric-{harness}")
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
    if harness == "hermes":
        patch_hermes(source)
    own_wheels = BUILD / "own-wheels"
    own_wheels.mkdir(exist_ok=True)
    env = dict(os.environ, SOURCE_DATE_EPOCH="1789171200")
    packages = ["sdk/python/nemo-fabric-runtime", "adapter-contract/python", "adapters/python/common"]
    if harness not in ("openclaw", "pi"):
        packages.append(f"adapters/python/{'nooa' if harness == 'nooa-bench' else harness}")
    for package in packages:
        args = ["uv", "build", "--python", "3.13", "--wheel", "--out-dir", str(own_wheels)]
        if package.endswith("nemo-fabric-runtime"):
            args += ["--config-setting", "build-args=--locked"]
        run(*args, str(source / package), env=env)
    lock_name = "dependencies.lock" if harness == "deepagents" else f"{harness}-dependencies.lock"
    lock = (ROOT / "image/fabric" / lock_name).read_text()
    wheels = sorted(own_wheels.glob("*.whl"))
    if len(wheels) != len(packages):
        raise SystemExit("Unexpected native/source Fabric wheel count")
    for wheel in wheels:
        name = wheel.name.split("-", 1)[0].replace("_", "-")
        lock += f"{name}==0.4.0 --hash=sha256:{hashlib.sha256(wheel.read_bytes()).hexdigest()}\n"
    (BUILD / "requirements.txt").write_text(lock)
    run("uv", "venv", "--allow-existing", "--python", "3.13", str(BUILD / "download-venv"))
    python = str(BUILD / "download-venv/bin/python")
    run("uv", "pip", "install", "--python", python, "pip==26.2.1")
    run(python, "-m", "pip", "download", "--only-binary=:all:", "--require-hashes",
        "--find-links", str(own_wheels), "-r", str(BUILD / "requirements.txt"), "-d", str(BUILD / "wheels"))
    dockerfile = f"Dockerfile.{harness}" if harness in ("hermes", "openclaw", "mini-swe-agent", "pi") else "Dockerfile"
    shutil.copyfile(ROOT / "image/fabric" / dockerfile, BUILD / "Dockerfile")
    shutil.copyfile(ROOT / "image/fabric/fabric.py", BUILD / "fabric.py")
    if harness == "openclaw":
        for name in ("openclaw_adapter.py", "openclaw.fabric-adapter.json"):
            shutil.copyfile(ROOT / "image/fabric" / name, BUILD / name)
    if harness == "pi":
        shutil.copyfile(ROOT / "image/fabric/pi_host.py", BUILD / "pi_host.py")
        for package in ("adapter-contract/typescript", "adapters/typescript"):
            shutil.copytree(source / package, BUILD / "pi-source" / package, dirs_exist_ok=True)
        patch_pi(BUILD / "pi-source")
    if harness == "hermes":
        archive = BUILD / "hermes-source.tar.gz"
        if not archive.exists():
            with urllib.request.urlopen(f"https://codeload.github.com/NousResearch/hermes-agent/tar.gz/{HERMES_REVISION}", timeout=60) as response:
                archive.write_bytes(response.read())
        if hashlib.sha256(archive.read_bytes()).hexdigest() != HERMES_HASH:
            raise SystemExit("Hermes source checksum mismatch")
        with tarfile.open(archive) as source:
            source.extractall(BUILD, filter="data")
    (BUILD / "provenance.json").write_text(json.dumps({
        "fabric_revision": REVISION, "source_sha256": SOURCE_HASH,
        "fabric_launcher_sha256": hashlib.sha256((ROOT / "image/fabric/fabric.py").read_bytes()).hexdigest(),
        "harness": harness, "version": {"deepagents": "0.7.13", "hermes": "0.21.0", "openclaw": "2026.9.4", "claude": "0.2.120", "codex": "0.144.4", "mini-swe-agent": "2.4.6", "nooa": "0.0.10", "nooa-bench": "0.0.10", "remote-agent": "0.4.0", "pi": "0.84.2"}[harness],
        **({"openclaw_image": "ghcr.io/openclaw/openclaw@sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101",
            "adapter": "NemoClaw adapter; not supplied by upstream Fabric",
            "adapter_sha256": hashlib.sha256((ROOT / "image/fabric/openclaw_adapter.py").read_bytes()).hexdigest()}
           if harness == "openclaw" else {}),
        **({"hermes_revision": HERMES_REVISION, "hermes_source_sha256": HERMES_HASH,
            "local_patch_sha256": hashlib.sha256((ROOT / "image/fabric/patch_hermes.py").read_bytes()).hexdigest()}
           if harness == "hermes" else {}),
        **({"local_pi_model_sources": {
            name: hashlib.sha256((ROOT / "image/fabric" / name).read_bytes()).hexdigest()
            for name in ("patch_pi.py", "pi-model.ts", "pi-probe.ts", "pi_host.py", "fabric.py")}}
           if harness == "pi" else {}),
        "requirements_sha256": hashlib.sha256(lock.encode()).hexdigest(),
    }, indent=2) + "\n")
    (BUILD / ".dockerignore").write_text("*\n!Dockerfile\n!pi-source/\n!pi-source/**\n!wheels/\n!wheels/**\n!requirements.txt\n!fabric.py\n!pi_host.py\n!provenance.json\n!openclaw_adapter.py\n!openclaw.fabric-adapter.json\n!hermes-agent-" + HERMES_REVISION + "/\n!hermes-agent-" + HERMES_REVISION + "/**\n")
    run("docker", "build", "-t", image_tag, str(BUILD))
    run("docker", "image", "inspect", image_tag, "--format", "{{index .RepoDigests 0}}")


if __name__ == "__main__":
    main()
