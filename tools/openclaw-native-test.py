# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run Fabric-managed OpenClaw with native channel commands and local API fixtures.
This is a disposable Docker test, not a messaging API or production provisioner.
"""

import argparse
import hashlib
import json
import os
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="nc-fabric:openclaw")
    args = parser.parse_args()
    image = run(
        "docker",
        "image",
        "inspect",
        args.image,
        "--format",
        "{{.Id}}",
        capture_output=True,
        text=True,
    ).stdout.strip()
    directory = ROOT / ".local" / ("openclaw-native-" + str(uuid.uuid4()))
    directory.mkdir(mode=0o700)
    print(directory, flush=True)
    for name in ("certs", "evidence", "native-state", "workspace"):
        (directory / name).mkdir()
    # Test UID 1000 needs access to disposable data directories.
    for name in ("native-state", "workspace"):
        os.chmod(directory / name, 0o777)
    secret = directory / "fake-token"
    secret.write_text("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk")
    os.chmod(secret, 0o644)
    run(
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=native-channel-fixture",
        "-addext",
        "subjectAltName=DNS:api.telegram.org,DNS:inference.local",
        "-keyout",
        str(directory / "certs/fixture.key"),
        "-out",
        str(directory / "certs/fixture.crt"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for phase in ("configure", "recreate"):
        sandbox = directory / ("sandbox-" + phase)
        sandbox.mkdir()
        os.chmod(sandbox, 0o777)
        run(
            "docker",
            "run",
            "--rm",
            "--runtime=runc",
            "--network",
            "none",
            "--user",
            "0",
            "--cap-add",
            "NET_ADMIN",
            "--add-host",
            "api.telegram.org:127.0.0.1",
            "--add-host",
            "inference.local:8.8.4.4",
            "--mount",
            f"type=bind,source={directory}/certs,target=/certs,readonly",
            "--mount",
            f"type=bind,source={directory}/evidence,target=/evidence",
            "--mount",
            f"type=bind,source={sandbox},target=/sandbox",
            "--mount",
            f"type=bind,source={directory}/native-state,target=/sandbox/.openclaw",
            "--mount",
            f"type=bind,source={directory}/workspace,target=/sandbox/workspace",
            "--mount",
            f"type=bind,source={secret},target=/run/native-secrets/bot-token",
            "--mount",
            f"type=bind,source={ROOT}/test/openclaw_native_messaging.py,target=/test.py,readonly",
            "--mount",
            f"type=bind,source={ROOT}/test/openclaw_cli_driver.mjs,target=/cli-driver.mjs,readonly",
            "--mount",
            f"type=bind,source={ROOT}/test/openclaw_fixture_transport.mjs,target=/fixture-transport.mjs,readonly",
            "--mount",
            f"type=bind,source={ROOT}/image/fabric/interfaces.py,target=/opt/nemoclaw/interfaces.py,readonly",
            "--mount",
            f"type=bind,source={ROOT}/image/fabric/openclaw_adapter.py,target=/opt/nemoclaw/openclaw_adapter.py,readonly",
            "--mount",
            f"type=bind,source={ROOT}/image/fabric/fabric.py,target=/opt/nemoclaw/fabric.py,readonly",
            "--entrypoint",
            "/opt/fabric/bin/python",
            image,
            "/test.py",
            phase,
        )
    proof = {
        "image_id": image,
        "network": "none",
        "external_messages": 0,
        "evidence_directory": str(directory),
        "source_sha256": {
            name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in (
                "tools/openclaw-native-test.py",
                "test/openclaw_native_messaging.py",
                "test/openclaw_cli_driver.mjs",
                "test/openclaw_fixture_transport.mjs",
                "image/fabric/openclaw_adapter.py",
                "image/fabric/interfaces.py",
                "image/fabric/fabric.py",
            )
        },
        "phases": [
            json.loads((directory / "evidence" / f"{phase}-proof.json").read_text())
            for phase in ("configure", "recreate")
        ],
    }
    (directory / "proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"passed": True, "evidence": str(directory / "proof.json")}), flush=True)


if __name__ == "__main__":
    main()
