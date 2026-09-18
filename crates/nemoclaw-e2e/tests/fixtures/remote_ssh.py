#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Deterministic SSH boundary: isolated Docker state and fixed host measurements."""
import base64
import fcntl
import io
import json
import os
import pathlib
import sys
import tarfile
import urllib.parse

root = pathlib.Path(os.environ["NEMOCLAW_TEST_REMOTE"])
control = json.loads((root / "control.json").read_text())
if control.get("transport_failure"):
    sys.exit(255)
if "python3" in sys.argv:
    if control.get("capacity_failure"):
        sys.exit(1)
    memory = "MemTotal: 134217728 kB\nMemAvailable: 125829120 kB\nMemFree: 115343360 kB\n"
    if control.get("low_capacity"):
        memory = "MemTotal: 134217728 kB\nMemAvailable: 1048576 kB\nMemFree: 1048576 kB\n"
    print(json.dumps({"daemon": control.get("daemon", "remote-engine"), "architecture": "aarch64",
        "memory": memory,
        "gpu": "NVIDIA GB10, 580.0\n", "processes": "", "disk_free": 2**40}))
    sys.exit(0)
if sys.argv[-3:] != ["docker", "system", "dial-stdio"]:
    raise ValueError("unexpected SSH command")
stream = sys.stdin.buffer
method, target, _ = stream.readline().decode().strip().split()
headers = {}
while line := stream.readline().decode().strip():
    key, value = line.split(":", 1)
    headers[key.lower()] = value.strip()
body = stream.read(int(headers.get("content-length", "0")))
url = urllib.parse.urlsplit(target)
path = urllib.parse.unquote(url.path)
if path.startswith("/v1."):
    path = "/" + path.split("/", 2)[2]
query = urllib.parse.parse_qs(url.query)
with (root / "lock").open("w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = json.loads((root / "engine.json").read_text())
    fixture = json.loads((root / "fixture.json").read_text())
    code, value, extra = 200, None, {}
    if method == "GET" and path == "/info":
        value = {"ID": control.get("daemon", "remote-engine"), "DockerRootDir": "/srv/nemoclaw-fixture/docker"}
    elif method == "GET" and path.startswith("/images/"):
        value = None if state.get("image_missing") else fixture["image"]
    elif method == "POST" and path == "/images/create":
        state["pulls"] = state.get("pulls", 0) + 1
        state["effects"] += 1
        if control.get("pull_failure"):
            value = {"errorDetail": {"message": "registry unavailable"}}
        else:
            state["image_missing"] = False
            value = {"status": "complete"}
    elif method == "GET" and path.startswith("/volumes/"):
        value = state.get("volume")
    elif method == "GET" and path == "/networks":
        value = []
    elif method == "GET" and path.startswith("/networks/"):
        value = state.get("network")
    elif path.endswith("/archive"):
        name = query["path"][0]
        if name.endswith(".nemoclaw-partial"):
            code = 404
        elif method == "HEAD":
            item = fixture["stats"].get(name)
            if item is None:
                code = 404
            else:
                extra["X-Docker-Container-Path-Stat"] = base64.b64encode(json.dumps(item).encode()).decode()
                value = b""
        elif method == "GET":
            item = fixture["files"].get(name)
            if item is None:
                code = 404
            else:
                data = item["raw"].encode() if isinstance(item, dict) and "raw" in item else json.dumps(item).encode()
                result = io.BytesIO()
                with tarfile.open(fileobj=result, mode="w") as archive:
                    entry = tarfile.TarInfo(pathlib.PurePosixPath(name).name)
                    entry.size = len(data)
                    archive.addfile(entry, io.BytesIO(data))
                value = result.getvalue()[:((len(data) + 511) // 512 + 3) * 512]
    elif method == "GET" and path.startswith("/containers/"):
        value = state.get("container")
    elif method == "POST" and path == "/volumes/create":
        request = json.loads(body)
        value = {**request, "Driver": "local", "Scope": "local", "Options": {},
            "Mountpoint": "/srv/nemoclaw-fixture/docker/volumes/fixture/_data", "CreatedAt": "2026-09-15T00:00:00Z"}
        state["volume"] = value
        state["effects"] += 1
    elif method == "POST" and path == "/networks/create":
        request = json.loads(body)
        state["network"] = {**request, "Id": "remote-network", "Internal": False, "EnableIPv6": False}
        value = {"Id": "remote-network", "Warning": ""}
        state["effects"] += 1
    elif method == "POST" and path == "/containers/create":
        request = json.loads(body)
        state["container"] = {"Id": "remote-container", "Name": "/" + query["name"][0],
            "Image": "sha256:runtime", "Config": request, "HostConfig": request["HostConfig"],
            "State": {"Running": False, "StartedAt": "2026-09-15T00:00:00Z"},
            "Mounts": [{"Type": "volume", "Name": state["volume"]["Name"], "Destination": "/data", "RW": True}]}
        value = {"Id": "remote-container", "Warnings": []}
        state["effects"] += 1
        state["creates"] += 1
        code = 201
    elif method == "POST" and path.endswith("/start"):
        state["container"]["State"]["Running"] = not control.get("startup_failure", False)
        state["effects"] += 1
        code, value = 204, b""
    elif method == "POST" and path.endswith("/stop"):
        state["container"]["State"]["Running"] = False
        state["effects"] += 1
        code, value = 204, b""
    elif method == "DELETE" and path.startswith("/containers/"):
        state["container"] = None
        state["effects"] += 1
        code, value = 204, b""
    else:
        raise ValueError((method, path))
    if value is None:
        code, value = 404, {"message": "absent"}
    if not isinstance(value, bytes):
        value = json.dumps(value).encode()
    (root / "engine.json").write_text(json.dumps(state))
response = f"HTTP/1.1 {code} Fixture\r\nContent-Length: {len(value)}\r\nConnection: close\r\n"
response += "".join(f"{key}: {value}\r\n" for key, value in extra.items()) + "\r\n"
sys.stdout.buffer.write(response.encode() + value)
sys.stdout.buffer.flush()
