# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fixed read-only collection on the SSH execution host; no user-supplied hooks."""
import json
import os
import platform
import subprocess


def run(*args):
    value = subprocess.check_output(args, timeout=10, stderr=subprocess.DEVNULL)
    if len(value) > 65536:
        raise ValueError("incomplete bounded observation")
    return value.decode()


if platform.system() != "Linux":
    raise ValueError("Linux required")
context = json.loads(run("docker", "context", "inspect"))[0]
endpoint = os.environ.get("DOCKER_HOST") or context["Endpoints"]["docker"]["Host"]
if not endpoint.startswith("unix:///") or not context["Endpoints"]["docker"]["Host"].startswith("unix:///"):
    raise ValueError("Docker daemon is not on the observed SSH host")
info = json.loads(run("docker", "info", "--format", "{{json .}}"))
if info["OSType"] != "linux" or info["Architecture"] not in ("arm64", "aarch64", "amd64", "x86_64"):
    raise ValueError("Linux ARM64 or AMD64 daemon required")
architecture = {"aarch64": "arm64", "x86_64": "amd64"}
if architecture.get(info["Architecture"], info["Architecture"]) != architecture.get(platform.machine(), platform.machine()):
    raise ValueError("daemon architecture differs from the observed host")
root = info["DockerRootDir"]
if not os.path.isabs(root):
    raise ValueError("absolute daemon storage root required")
stat = os.statvfs(root)
with open("/proc/meminfo") as source:
    memory = source.read(65537)
if len(memory) > 65536:
    raise ValueError("incomplete memory observation")
gpu = run("nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader,nounits")
print(json.dumps({
    "daemon": info["ID"], "architecture": platform.machine(), "memory": memory,
    "gpu": gpu,
    "compute_capability": run("nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader,nounits"),
    "gpu_memory": run("nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"),
    "processes": run("nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader,nounits"),
    "disk_free": stat.f_bavail * stat.f_frsize,
}))
