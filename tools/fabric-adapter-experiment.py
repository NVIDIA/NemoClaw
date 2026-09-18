# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Test a built Fabric harness image with real adapters and offline model fixtures."""

import argparse
import subprocess
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--harness",
    required=True,
    choices=(
        "deepagents",
        "openclaw",
        "hermes",
        "claude",
        "codex",
        "mini-swe-agent",
        "nooa",
        "nooa-bench",
        "remote-agent",
        "pi",
    ),
)
parser.add_argument("--hermes-dashboard", choices=("enabled", "disabled"), default="enabled")
parser.add_argument("--hermes-tui", choices=("enabled", "disabled"), default="enabled")
parser.add_argument(
    "--hermes-relay", action="store_true", help="Exercise in-process Hermes Relay tracing"
)
parser.add_argument(
    "--interfaces",
    action="store_true",
    help="Exercise the native dashboard with sandbox-local authentication",
)
parser.add_argument(
    "--inference-api",
    choices=("openai-completions", "openai-responses", "anthropic-messages"),
    help="Exercise explicit API selection; OpenClaw also exercises route tuning",
)
parser.add_argument("--image", help="Explicit locally built image reference")
parser.add_argument(
    "--pi-catalog",
    action="store_true",
    help="Exercise Pi catalog models instead of custom metadata",
)
args = parser.parse_args()
h = args.harness
if args.hermes_relay and (h != "hermes" or args.inference_api is None):
    parser.error("--hermes-relay requires --harness hermes and --inference-api")


def openssl(*args):
    subprocess.run(
        ["openssl", *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


with tempfile.TemporaryDirectory(prefix="nemoclaw-fixture-") as directory:
    certs = Path(directory)
    certs.chmod(0o755)

    openssl(
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(certs / "ca.key"),
        "-out",
        str(certs / "ca.crt"),
        "-days",
        "1",
        "-subj",
        "/CN=Fabric fixture CA",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
    )
    openssl(
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(certs / "fixture.key"),
        "-out",
        str(certs / "fixture.csr"),
        "-subj",
        "/CN=inference.local",
    )
    (certs / "extensions").write_text(
        "subjectAltName=DNS:inference.local\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n"
    )
    openssl(
        "x509",
        "-req",
        "-in",
        str(certs / "fixture.csr"),
        "-CA",
        str(certs / "ca.crt"),
        "-CAkey",
        str(certs / "ca.key"),
        "-CAcreateserial",
        "-out",
        str(certs / "fixture.crt"),
        "-days",
        "1",
        "-extfile",
        str(certs / "extensions"),
    )
    (certs / "fixture.key").chmod(0o644)
    image = subprocess.check_output(
        ["docker", "image", "inspect", args.image or f"nc-fabric:{h}", "--format", "{{.Id}}"],
        text=True,
    ).strip()
    name = "nc-fixture-" + str(uuid.uuid4())
    cmd = [
        "docker",
        "run",
        "--name",
        name,
        "--rm",
        "--runtime=runc",
        "--network",
        "none",
        *(["--user", "0", "--cap-add", "NET_ADMIN"] if h == "openclaw" else []),
        "--add-host",
        "inference.local:" + ("8.8.4.4" if h == "openclaw" else "127.0.0.1"),
        "-e",
        f"FABRIC_HERMES_DASHBOARD={args.hermes_dashboard}",
        "-e",
        f"FABRIC_HERMES_TUI={args.hermes_tui}",
        "-e",
        f"FABRIC_TEST_INTERFACES={int(args.interfaces)}",
        "-e",
        f"FABRIC_INFERENCE_API={args.inference_api or ''}",
        "-e",
        f"FABRIC_PI_CATALOG={int(args.pi_catalog)}",
        "-e",
        "HOME=/sandbox",
        "-e",
        "TMPDIR=/sandbox/tmp",
        "-e",
        "ADAPTER_PYTHON=/opt/fabric/bin/python",
        "-e",
        f"FABRIC_HERMES_RELAY={int(args.hermes_relay)}",
        "-e",
        "PYTHONPATH=/opt/nemoclaw",
        "-e",
        "OPENAI_API_KEY=fixture-only",
        "-e",
        "SSL_CERT_FILE=/certs/ca.crt",
        "-e",
        "REQUESTS_CA_BUNDLE=/certs/ca.crt",
        "-e",
        "NODE_EXTRA_CA_CERTS=/certs/ca.crt",
        "-e",
        "LITELLM_LOCAL_MODEL_COST_MAP=True",
        "-v",
        f"{certs}:/certs:ro",
        "-v",
        f"{ROOT / 'test/fabric_adapters.py'}:/test.py:ro",
        "--entrypoint",
        "/opt/fabric/bin/python",
        image,
        "/test.py",
        h,
    ]
    try:
        result = subprocess.run(cmd, timeout=600)
    finally:
        subprocess.run(
            ["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    raise SystemExit(result.returncode)
