# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Exercise the shipped SSH collector against mocked host commands and files."""
import contextlib
import io
import json
import runpy
import sys
from types import SimpleNamespace
from unittest.mock import mock_open, patch


def collect(machine, name):
    commands = []

    def output(args, **kwargs):
        assert kwargs == {"timeout": 10, "stderr": -3}
        commands.append(args)
        if args == ("docker", "context", "inspect"):
            return b'[{"Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock"}}}]'
        if args == ("docker", "info", "--format", "{{json .}}"):
            return json.dumps({"OSType": "linux", "Architecture": machine, "DockerRootDir": "/docker", "ID": "fixture"}).encode()
        assert args[0] == "nvidia-smi" and args[2] == "--format=csv,noheader,nounits"
        return {
            "--query-gpu=name,driver_version": f"{name}, 610.0\n".encode(),
            "--query-gpu=memory.total,memory.free,compute_cap": b"81920, 71680, 10.3\n",
            "--query-compute-apps=pid": b"",
        }[args[1]]

    captured = io.StringIO()
    with (
        patch("platform.system", return_value="Linux"),
        patch("platform.machine", return_value=machine),
        patch.dict("os.environ", {}, clear=True),
        patch("os.statvfs", return_value=SimpleNamespace(f_bavail=1000, f_frsize=4096)),
        patch("builtins.open", mock_open(read_data="MemTotal: 512000000 kB\nMemAvailable: 400000000 kB\nMemFree: 300000000 kB\n")),
        patch("subprocess.check_output", side_effect=output),
        contextlib.redirect_stdout(captured),
    ):
        runpy.run_path(sys.argv[1], run_name="__main__")
    return json.loads(captured.getvalue()), commands


for machine, name in [("aarch64", "NVIDIA GB10"), ("aarch64", "NVIDIA GB300"), ("aarch64", "NVIDIA H100"), ("x86_64", "NVIDIA H100")]:
    result, commands = collect(machine, name)
    dedicated = name != "NVIDIA GB10"
    assert (result["gpu_memory"] is not None) == dedicated
    assert any("--query-gpu=memory.total,memory.free,compute_cap" in command for command in commands) == dedicated
    assert result["gpu"].startswith(name)
