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
import time
import urllib.parse

root = pathlib.Path(os.environ["NEMOCLAW_TEST_REMOTE"])
control = json.loads((root / "control.json").read_text())
if control.get("transport_failure"):
    sys.exit(255)
if "python3" in sys.argv:
    if control.get("capacity_failure"):
        sys.exit(1)
    with (root / "capacity_reads").open("a") as reads:
        reads.write("read\n")
    total = control.get("total_capacity_gib", 128) * 1024 * 1024
    memory = f"MemTotal: {total} kB\nMemAvailable: 125829120 kB\nMemFree: 115343360 kB\n"
    if control.get("low_capacity"):
        memory = f"MemTotal: {total} kB\nMemAvailable: 1048576 kB\nMemFree: 1048576 kB\n"
    print(json.dumps({"daemon": control.get("daemon", "remote-engine"), "architecture": "aarch64",
        "memory": memory, "compute_capability": "12.1\n", "gpu_memory": "[N/A], [N/A]\n",
        "gpu": "NVIDIA GB10, 580.0\n", "processes": "", "disk_free": 2**40}))
    sys.exit(0)
if (sys.argv[-3:] != ["docker", "system", "dial-stdio"]
        and sys.argv[-1] != "docker system dial-stdio"):
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
if method == "POST" and path.endswith("/wait"):
    # Docker wait completes after stop/removal. Do not hold the mutation lock
    # while another SSH connection performs that operation.
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        with (root / "lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            waiting = json.loads((root / "engine.json").read_text()).get("container")
        if not waiting or not waiting["State"]["Running"]:
            break
        time.sleep(0.01)
with (root / "lock").open("w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = json.loads((root / "engine.json").read_text())
    fixture = json.loads((root / "fixture.json").read_text())
    code, value, extra = 200, None, {}
    if method in ("HEAD", "GET") and path == "/_ping":
        extra.update({"API-Version": "1.47", "OSType": "linux", "Docker-Experimental": "false"})
        value = b"" if method == "HEAD" else b"OK"
    elif method == "GET" and path == "/version":
        value = {"Version": "27.5.1", "ApiVersion": "1.47", "MinAPIVersion": "1.24",
            "Os": "linux", "Arch": "arm64", "KernelVersion": "fixture", "GoVersion": "go1.23"}
    elif method == "GET" and path == "/info":
        value = {"ID": control.get("daemon", "remote-engine"), "DockerRootDir": "/srv/nemoclaw-fixture/docker",
            "OSType": "linux", "Architecture": "aarch64", "ServerVersion": "27.5.1"}
    elif method == "GET" and path == "/images/json":
        value = [] if state.get("image_missing") else [{
            "Id": fixture["image"]["Id"], "RepoTags": fixture.get("image_refs", []),
            "RepoDigests": fixture.get("image_refs", []), "Created": 1, "Size": 1,
            "Labels": fixture["image"]["Config"]["Labels"]}]
    elif method == "GET" and path.startswith("/images/"):
        value = None if state.get("image_missing") else {**fixture["image"],
            "RepoTags": fixture.get("image_refs", []), "RepoDigests": fixture.get("image_refs", [])}
    elif method == "POST" and path == "/images/create":
        state["pulls"] = state.get("pulls", 0) + 1
        state["effects"] += 1
        if control.get("pull_failure"):
            value = {"errorDetail": {"message": "registry unavailable"}}
        else:
            state["image_missing"] = False
            value = {"status": "Downloading", "id": "abcdef", "progressDetail": {"current": 50, "total": 100}}
    elif method == "GET" and path.startswith("/volumes/"):
        value = state.get("volume")
    elif method == "GET" and path == "/networks":
        value = [state["network"]] if state.get("network") else []
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
            if name == "/data/status.json" and item and control.get("startup_failure"):
                item = {**item, "phase": "stopped", "detail": "intentional protocol fixture startup failure"}
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
    elif method == "GET" and path == "/containers/json":
        container = state.get("container")
        value = [] if not container else [{"Id":container["Id"], "Names":[container["Name"]],
            "Image":container["Config"]["Image"], "ImageID":container["Image"],
            "Labels":container["Config"].get("Labels", {}), "State":"running" if container["State"]["Running"] else "exited",
            "Status":"Up" if container["State"]["Running"] else "Exited", "Created":1}]
    elif method == "GET" and path.startswith("/containers/"):
        value = state.get("container")
        if value:
            value = {**value, "State":{**value["State"],
                "Status":"running" if value["State"]["Running"] else "exited"}}
            if not value["State"]["Running"]:
                # Docker retains requested ports in HostConfig while stopped,
                # but the active NetworkSettings port map is empty.
                value["NetworkSettings"] = {**value["NetworkSettings"], "Ports":{}}
    elif method == "POST" and path == "/volumes/create":
        request = json.loads(body)
        value = {**request, "Driver": "local", "Scope": "local", "Options": {},
            "Mountpoint": "/srv/nemoclaw-fixture/docker/volumes/fixture/_data", "CreatedAt": "2026-09-15T00:00:00Z"}
        state["volume"] = value
        state["effects"] += 1
    elif method == "POST" and path == "/networks/create" and control.get("network_create_failure"):
        code, value = 500, {"message":"intentional protocol fixture network creation failure"}
    elif method == "POST" and path == "/networks/create":
        request = json.loads(body)
        state["network"] = {**request, "Id": "remote-network", "Internal": False, "EnableIPv6": False,
            "Scope":"local", "Containers":{}, "Options":request.get("Options") or {},
            "IPAM":{**request.get("IPAM",{}), "Driver":"default"}}
        value = {"Id": "remote-network", "Warning": ""}
        state["effects"] += 1
    elif method == "POST" and path == "/containers/create" and control.get("create_failure"):
        code, value = 500, {"message":"intentional protocol fixture container creation failure"}
    elif method == "POST" and path == "/containers/create":
        request = json.loads(body)
        request["HostConfig"].setdefault("RestartPolicy", {"Name":"no", "MaximumRetryCount":0})
        request["HostConfig"].setdefault("LogConfig", {"Type":"json-file", "Config":{}})
        request.setdefault("Hostname", "remote-container")
        request.setdefault("WorkingDir", "")
        request.setdefault("User", "")
        container_id = "remote-container" if state["creates"] == 0 else f"remote-container-{state['creates'] + 1}"
        state["container"] = {"Id": container_id, "Name": "/" + query["name"][0],
            "Image": fixture["image"]["Id"], "Config": request, "HostConfig": request["HostConfig"],
            "State": {"Running": False, "Status":"created", "StartedAt": "2026-09-15T00:00:00Z", "ExitCode":0},
            "NetworkSettings":{"Ports":request["HostConfig"].get("PortBindings", {}),
                "Networks":{state["network"]["Name"]:{"NetworkID":"remote-network", "IPAddress":"172.30.119.2", "Gateway":"172.30.119.1", "IPPrefixLen":24, "Aliases":[], "Links":[]}}},
            "Mounts": [{"Type": "volume", "Name": state["volume"]["Name"], "Destination": "/data", "RW": True}]}
        value = {"Id": container_id, "Warnings": []}
        state["effects"] += 1
        state["creates"] += 1
        code = 201
    elif method == "POST" and path.endswith("/start"):
        state["container"]["State"]["Running"] = True
        state["container"]["State"]["Status"] = "running"
        state["effects"] += 1
        code, value = 204, b""
    elif method == "POST" and path.endswith("/stop"):
        state["container"]["State"]["Running"] = False
        state["container"]["State"]["Status"] = "exited"
        state["effects"] += 1
        code, value = 204, b""
    elif method == "POST" and path.endswith("/wait"):
        container = state.get("container")
        if container and container["State"]["Running"]:
            code, value = 500, {"message":"fixture wait timed out before stop"}
        else:
            value = {"StatusCode":container["State"].get("ExitCode", 0) if container else 0, "Error":None}
    elif method == "DELETE" and path.startswith("/networks/"):
        state["network"] = None
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
response = f"HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {len(value)}\r\nConnection: close\r\n"
response += "".join(f"{key}: {value}\r\n" for key, value in extra.items()) + "\r\n"
sys.stdout.buffer.write(response.encode() + value)
sys.stdout.buffer.flush()
