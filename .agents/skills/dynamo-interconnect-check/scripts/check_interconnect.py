#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Read-only checks that a Dynamo deployment's interconnect is disagg-ready.

A deployment can come up and answer ``/v1/models`` while disaggregated serving
is silently wrong, because nothing has exercised the NIXL/UCX transport that
moves KV cache between prefill and decode workers. This tool inspects the three
things that decide whether that transport will actually work:

* ``env``  - the NIXL/UCX/NCCL transport env vars set on a recipe or pod
* ``node`` - host/pod RDMA + GPUDirect + NVLink capabilities (read-only)
* ``nixl`` - a best-effort NIXL reachability probe between two pods

Everything is read-only and degrades gracefully when a tool, pod, or cluster is
not available, emitting structured JSON instead of crashing.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

# Tunables and conventional return codes (kept here to avoid magic numbers).
DEFAULT_PROBE_TIMEOUT_SEC = 20
# POSIX-conventional return codes used when the wrapper itself fails before
# the probed binary can produce a real one.
RETURNCODE_COMMAND_NOT_FOUND = 127  # binary not found in PATH or pod

# Transport-relevant env vars, grouped by subsystem. ``disagg`` marks the ones
# whose absence most often makes multi-node disaggregated serving fall back to a
# slow or incorrect transport. Names are distinctive enough to match anywhere in
# a manifest without false positives.
ENV_CATALOG: dict[str, dict[str, str]] = {
    "UCX_TLS": {
        "group": "nixl/ucx",
        "disagg": "yes",
        "why": "Selects UCX transports; must include rc/ib and cuda_ipc for "
        "RDMA + NVLink, or NIXL silently falls back to TCP.",
    },
    "UCX_NET_DEVICES": {
        "group": "nixl/ucx",
        "disagg": "yes",
        "why": "Pins UCX to the right IB HCA/port (e.g. mlx5_0:1); wrong or "
        "unset device degrades to the management NIC.",
    },
    "UCX_IB_GPU_DIRECT_RDMA": {
        "group": "nixl/ucx",
        "disagg": "yes",
        "why": "Enables GPUDirect RDMA so KV moves NIC<->GPU without staging "
        "through host memory.",
    },
    "UCX_RNDV_SCHEME": {
        "group": "nixl/ucx",
        "disagg": "no",
        "why": "Rendezvous scheme tuning for large transfers.",
    },
    "NIXL_PLUGIN_DIR": {
        "group": "nixl/ucx",
        "disagg": "no",
        "why": "Where NIXL loads backend plugins from; only needed for a "
        "non-default install layout.",
    },
    "NCCL_IB_HCA": {
        "group": "nccl",
        "disagg": "yes",
        "why": "IB HCAs NCCL may use for tensor/expert parallel collectives.",
    },
    "NCCL_SOCKET_IFNAME": {
        "group": "nccl",
        "disagg": "yes",
        "why": "Control-plane NIC for NCCL bootstrap; a wrong guess stalls "
        "rendezvous.",
    },
    "NCCL_IB_DISABLE": {
        "group": "nccl",
        "disagg": "yes",
        "why": "Must be 0/unset to use InfiniBand; =1 forces NCCL onto sockets.",
    },
    "NCCL_NET_GDR_LEVEL": {
        "group": "nccl",
        "disagg": "no",
        "why": "GPUDirect RDMA aggressiveness for NCCL.",
    },
    "NCCL_P2P_LEVEL": {
        "group": "nccl",
        "disagg": "no",
        "why": "NVLink/PCIe peer-to-peer level for intra-node collectives.",
    },
    "NCCL_IB_GID_INDEX": {
        "group": "nccl",
        "disagg": "no",
        "why": "RoCE/EFA GID index; needed on RoCE fabrics, not classic IB.",
    },
}


@dataclass
class Check:
    """One read-only probe result.

    ``status`` is one of ok / warn / fail / skipped / unknown so callers can
    triage without parsing free text.
    """

    name: str
    status: str
    detail: str


def run(cmd: list[str], timeout: int = DEFAULT_PROBE_TIMEOUT_SEC) -> dict[str, Any]:
    """Run a command read-only, never raising on failure or a missing binary."""
    try:
        proc = subprocess.run(
            cmd, text=True, capture_output=True, timeout=timeout, check=False
        )
        return {"rc": proc.returncode, "out": proc.stdout, "err": proc.stderr}
    except FileNotFoundError as exc:
        return {"rc": 127, "out": "", "err": str(exc)}
    except subprocess.TimeoutExpired:
        return {"rc": 124, "out": "", "err": f"timed out after {timeout}s"}


def exec_prefix(namespace: str | None, pod: str, container: str | None) -> list[str]:
    """Build the ``kubectl exec`` prefix for running a probe inside a pod."""
    cmd = ["kubectl", "exec", pod]
    if namespace:
        cmd += ["-n", namespace]
    if container:
        cmd += ["-c", container]
    return cmd + ["--"]


def read_text(path: Path) -> str:
    """Read a manifest as text, tolerating undecodable bytes."""
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(errors="replace")


def find_env_value(text: str, var: str) -> str | None:
    """Return the value set for ``var`` in a manifest, or None if only named.

    Handles both the Kubernetes ``- name: VAR\\n  value: V`` shape and a plain
    ``VAR=V`` shape. Returns "" when the var is present but the value is dynamic
    (valueFrom / secretKeyRef) or not on the same line.
    """
    kv = re.search(rf"(?m)^\s*-?\s*name:\s*{re.escape(var)}\s*$", text)
    if kv:
        tail = text[kv.end() : kv.end() + 200]
        val = re.search(r"^\s*value:\s*[\"']?([^\"'\n]+)", tail)
        return val.group(1).strip() if val else ""
    inline = re.search(rf"(?m)\b{re.escape(var)}=([^\s\"']+)", text)
    if inline:
        return inline.group(1)
    return None


def check_env(target: Path) -> list[Check]:
    """Assess transport env vars across one manifest or a recipe directory."""
    if target.is_dir():
        files = sorted(target.rglob("*.yaml")) + sorted(target.rglob("*.yml"))
    elif target.is_file():
        files = [target]
    else:
        return [Check("env", "fail", f"no manifest found at {target}")]
    if not files:
        return [Check("env", "fail", f"no YAML manifests under {target}")]

    text = "\n".join(read_text(f) for f in files)
    checks: list[Check] = []
    missing_disagg: list[str] = []
    for var, meta in ENV_CATALOG.items():
        value = find_env_value(text, var)
        if value is None:
            if meta["disagg"] == "yes":
                missing_disagg.append(var)
            continue
        shown = value if value else "<set via valueFrom/dynamic>"
        checks.append(Check(f"env:{var}", "ok", f"{shown}  ({meta['why']})"))

    if missing_disagg:
        checks.append(
            Check(
                "env:disagg-transport",
                "warn",
                "disagg-critical vars not set in manifest: "
                + ", ".join(missing_disagg)
                + ". Fine if baked into the image/entrypoint; verify with the "
                "`node` and `nixl` checks. See references/interconnect-env-vars.md.",
            )
        )
    if not checks:
        checks.append(
            Check(
                "env",
                "warn",
                "no NIXL/UCX/NCCL transport env vars found in the manifest(s)",
            )
        )
    return checks


# Read-only capability probes: (check name, argv, how to read the result).
NODE_PROBES: list[tuple[str, list[str]]] = [
    ("ib-devices", ["ls", "/dev/infiniband"]),
    ("ibv-devinfo", ["ibv_devinfo", "-l"]),
    ("ib-link", ["ibstat"]),
    ("gpudirect-peermem", ["sh", "-c", "lsmod | grep -E 'nvidia_peermem|nv_peer_mem'"]),
    ("gdrcopy", ["ls", "/dev/gdrdrv"]),
    ("gpu-topology", ["nvidia-smi", "topo", "-m"]),
]


def classify_node_probe(name: str, res: dict[str, Any]) -> Check:
    """Turn a raw probe result into a triaged Check."""
    out = (res["out"] or "").strip()
    if res["rc"] == RETURNCODE_COMMAND_NOT_FOUND:
        return Check(name, "skipped", "tool/path not present in this environment")
    if res["rc"] != 0:
        return Check(name, "warn", (res["err"] or "non-zero exit").strip()[:200])
    if name == "ib-link":
        state = "ok" if re.search(r"State:\s*Active|LinkUp", out) else "warn"
        detail = "at least one port Active" if state == "ok" else "no Active IB port"
        return Check(name, state, detail)
    if name == "gpu-topology":
        link = "ok" if re.search(r"\bNV\d+\b", out) else "warn"
        detail = "NVLink (NV#) present" if link == "ok" else "no NVLink links in topo"
        return Check(name, link, detail)
    if name in {"ib-devices", "ibv-devinfo"}:
        return Check(name, "ok" if out else "warn", out[:200] or "no devices listed")
    if name == "gpudirect-peermem":
        return Check(name, "ok" if out else "warn", out[:120] or "module not loaded")
    if name == "gdrcopy":
        return Check(name, "ok", out[:120])
    return Check(name, "ok", out[:200])


def check_node(
    namespace: str | None, pod: str | None, container: str | None
) -> list[Check]:
    """Run RDMA/GPUDirect/NVLink capability probes locally or inside a pod."""
    prefix = exec_prefix(namespace, pod, container) if pod else []
    where = f"pod {pod}" if pod else "local host"
    checks = [Check("node:target", "ok", where)]
    for name, argv in NODE_PROBES:
        checks.append(classify_node_probe(name, run(prefix + argv)))
    return checks


def check_nixl(
    namespace: str | None, pod: str | None, container: str | None
) -> list[Check]:
    """Best-effort NIXL transport probe; needs a real multi-pod GPU/IB cluster.

    Looks for a NIXL test/bench binary inside the pod and reports how to run a
    pairwise RDMA/NVLink check. A correct cross-pod transfer test cannot be
    synthesized without two scheduled GPU pods on the fabric, so this surfaces
    the exact next command rather than asserting a false pass.
    """
    if not pod:
        return [
            Check(
                "nixl",
                "skipped",
                "pass --pod (and --namespace) to probe NIXL inside a worker; a "
                "real prefill<->decode transfer test needs two GPU pods on the "
                "fabric. See references/interconnect-env-vars.md.",
            )
        ]
    prefix = exec_prefix(namespace, pod, container)
    probe = run(
        prefix
        + [
            "sh",
            "-c",
            "command -v nixlbench nixl_test 2>/dev/null; ls /usr/local/nixl 2>/dev/null",
        ]
    )
    found = (probe["out"] or "").strip()
    if probe["rc"] == RETURNCODE_COMMAND_NOT_FOUND or not found:
        return [
            Check(
                "nixl:binary",
                "warn",
                "no nixlbench/nixl_test found in the pod; install or exec the "
                "NIXL test harness to validate RDMA/NVLink reachability between "
                "a prefill and a decode pod.",
            )
        ]
    return [
        Check(
            "nixl:binary",
            "ok",
            f"found NIXL tooling: {found}. Run a pairwise transfer between a "
            "prefill and decode pod to confirm the transport (see references).",
        )
    ]


def summarize(checks: list[Check]) -> dict[str, Any]:
    """Roll the checks up into a verdict on disagg transport readiness."""
    counts = {s: sum(c.status == s for c in checks) for s in ("ok", "warn", "fail")}
    if counts["fail"]:
        verdict = "transport blockers found; disagg will not be correct"
    elif counts["warn"]:
        verdict = "potential transport gaps; verify before trusting disagg"
    else:
        verdict = "no transport gaps detected by read-only checks"
    return {
        "checks": [asdict(c) for c in checks],
        "counts": counts,
        "verdict": verdict,
    }


def main() -> int:
    """CLI entry point. Returns 0 on no failures, 1 when any check failed."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    env_p = sub.add_parser("env", help="Assess transport env vars in a recipe/manifest")
    env_p.add_argument("target", help="deploy.yaml or recipe directory")

    for name, helptext in [
        ("node", "Check RDMA/GPUDirect/NVLink capabilities (local or in a pod)"),
        ("nixl", "Best-effort NIXL RDMA/NVLink reachability probe"),
    ]:
        p = sub.add_parser(name, help=helptext)
        p.add_argument("--namespace", "-n")
        p.add_argument("--pod", help="Probe inside this pod via kubectl exec")
        p.add_argument("--container", "-c")

    args = parser.parse_args()
    if args.command == "env":
        checks = check_env(Path(args.target))
    elif args.command == "node":
        checks = check_node(args.namespace, args.pod, args.container)
    else:
        checks = check_nixl(args.namespace, args.pod, args.container)

    result = summarize(checks)
    print(json.dumps(result, indent=2))
    return 1 if result["counts"]["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
