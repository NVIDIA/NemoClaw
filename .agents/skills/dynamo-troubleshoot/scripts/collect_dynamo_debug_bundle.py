#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Collect a read-only Dynamo Kubernetes debug bundle without secrets."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# Tunables and conventional return codes (kept here to avoid magic numbers).
DEFAULT_KUBECTL_TIMEOUT_SEC = 30
DEFAULT_LOG_TAIL_LINES = 200
# POSIX-conventional return codes used when the wrapper itself fails before
# kubectl can produce a real one.
RETURNCODE_COMMAND_NOT_FOUND = 127  # `kubectl` not installed
RETURNCODE_TIMED_OUT = 124  # subprocess timeout

# `kubectl describe` and pod logs can echo secret env values (HF tokens,
# bearer tokens, passwords). Scrub them before anything is written to disk so
# the bundle honors its no-secrets contract.
_SECRET_KV_RE = re.compile(
    r"(?i)([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|"
    r"CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)(\S+)"
)
_BEARER_RE = re.compile(r"(?i)(bearer\s+)([A-Za-z0-9._\-]+)")
_HF_TOKEN_RE = re.compile(r"\bhf_[A-Za-z0-9]{8,}\b")


def redact(text: str) -> str:
    if not text:
        return text
    text = _SECRET_KV_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}<redacted>", text)
    text = _BEARER_RE.sub(lambda m: f"{m.group(1)}<redacted>", text)
    text = _HF_TOKEN_RE.sub("<redacted-hf-token>", text)
    return text


def run(cmd: list[str], timeout: int) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            cmd, text=True, capture_output=True, timeout=timeout, check=False
        )
        return {
            "cmd": cmd,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    except FileNotFoundError as exc:
        return {
            "cmd": cmd,
            "returncode": RETURNCODE_COMMAND_NOT_FOUND,
            "stdout": "",
            "stderr": str(exc),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "cmd": cmd,
            "returncode": RETURNCODE_TIMED_OUT,
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or f"Timed out after {timeout}s",
        }


def write_result(outdir: Path, name: str, result: dict[str, Any]) -> None:
    safe = name.replace("/", "_").replace(" ", "_")
    (outdir / f"{safe}.txt").write_text(
        "$ "
        + " ".join(result["cmd"])
        + "\n\n"
        + "RETURN_CODE="
        + str(result["returncode"])
        + "\n\n"
        + "STDOUT\n"
        + redact(str(result["stdout"]))
        + "\n\n"
        + "STDERR\n"
        + redact(str(result["stderr"]))
        + "\n",
        encoding="utf-8",
    )


def kubectl_json(args: list[str], timeout: int) -> Any | None:
    result = run(["kubectl", *args, "-o", "json"], timeout)
    if result["returncode"] != 0:
        return None
    try:
        return json.loads(result["stdout"])
    except json.JSONDecodeError:
        return None


def pod_names(namespace: str, selector: str | None, timeout: int) -> list[str]:
    args = ["get", "pods", "-n", namespace]
    if selector:
        args.extend(["-l", selector])
    body = kubectl_json(args, timeout)
    if not body:
        return []
    return [
        item.get("metadata", {}).get("name")
        for item in body.get("items", [])
        if item.get("metadata", {}).get("name")
    ]


def container_names(namespace: str, pod: str, timeout: int) -> list[tuple[str, str]]:
    body = kubectl_json(["get", "pod", pod, "-n", namespace], timeout)
    if not body:
        return []
    specs = body.get("spec", {})
    containers: list[tuple[str, str]] = []
    for kind, field in [
        ("init", "initContainers"),
        ("container", "containers"),
    ]:
        for item in specs.get(field, []):
            if item.get("name"):
                containers.append((kind, item["name"]))
    return containers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--namespace", "-n", required=True)
    parser.add_argument(
        "--deployment-name", help="DynamoGraphDeployment name, if known"
    )
    parser.add_argument(
        "--selector", help="Optional pod selector, for example app=my-app"
    )
    parser.add_argument(
        "--outdir",
        default=None,
        help="Output dir; defaults to a private mkdtemp dynamo-debug-* directory",
    )
    parser.add_argument("--tail", type=int, default=DEFAULT_LOG_TAIL_LINES)
    parser.add_argument("--timeout", type=int, default=DEFAULT_KUBECTL_TIMEOUT_SEC)
    args = parser.parse_args()

    if args.outdir:
        outdir = Path(args.outdir).expanduser().resolve()
        outdir.mkdir(parents=True, exist_ok=True)
    else:
        # mkdtemp gives an unpredictable name with 0700 perms, unlike a
        # guessable /tmp/dynamo-debug-<timestamp> path on a shared host.
        outdir = Path(tempfile.mkdtemp(prefix="dynamo-debug-")).resolve()

    commands: list[tuple[str, list[str]]] = [
        ("context", ["kubectl", "config", "current-context"]),
        ("nodes", ["kubectl", "get", "nodes", "-o", "wide"]),
        ("storageclass", ["kubectl", "get", "storageclass"]),
        ("namespace", ["kubectl", "get", "namespace", args.namespace, "-o", "yaml"]),
        (
            "dgd",
            [
                "kubectl",
                "get",
                "dynamographdeployment",
                "-n",
                args.namespace,
                "-o",
                "wide",
            ],
        ),
        ("pods", ["kubectl", "get", "pods", "-n", args.namespace, "-o", "wide"]),
        ("services", ["kubectl", "get", "svc", "-n", args.namespace, "-o", "wide"]),
        ("pvc", ["kubectl", "get", "pvc", "-n", args.namespace, "-o", "wide"]),
        ("jobs", ["kubectl", "get", "jobs", "-n", args.namespace, "-o", "wide"]),
        (
            "events",
            [
                "kubectl",
                "get",
                "events",
                "-n",
                args.namespace,
                "--sort-by=.lastTimestamp",
            ],
        ),
    ]
    if args.deployment_name:
        commands.append(
            (
                "describe_dgd",
                [
                    "kubectl",
                    "describe",
                    "dynamographdeployment",
                    args.deployment_name,
                    "-n",
                    args.namespace,
                ],
            )
        )

    summary: dict[str, Any] = {
        "outdir": str(outdir),
        "namespace": args.namespace,
        "commands": [],
    }
    for name, cmd in commands:
        result = run(cmd, args.timeout)
        write_result(outdir, name, result)
        summary["commands"].append(
            {"name": name, "cmd": cmd, "returncode": result["returncode"]}
        )

    pods = pod_names(args.namespace, args.selector, args.timeout)
    summary["pods"] = pods
    for pod in pods:
        result = run(
            ["kubectl", "describe", "pod", pod, "-n", args.namespace], args.timeout
        )
        write_result(outdir, f"describe_pod_{pod}", result)
        for kind, container in container_names(args.namespace, pod, args.timeout):
            result = run(
                [
                    "kubectl",
                    "logs",
                    pod,
                    "-c",
                    container,
                    "-n",
                    args.namespace,
                    f"--tail={args.tail}",
                ],
                args.timeout,
            )
            write_result(outdir, f"logs_{kind}_{pod}_{container}", result)
            previous_result = run(
                [
                    "kubectl",
                    "logs",
                    pod,
                    "-c",
                    container,
                    "-n",
                    args.namespace,
                    "--previous",
                    f"--tail={args.tail}",
                ],
                args.timeout,
            )
            write_result(
                outdir, f"logs_previous_{kind}_{pod}_{container}", previous_result
            )

    (outdir / "summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
