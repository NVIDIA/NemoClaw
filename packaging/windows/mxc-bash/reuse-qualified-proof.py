# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Rebind one passed Bash proof only when every producer input is byte-identical."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil

BASELINE = "07fa1d24fe86e63ffda93d421bea249fed2427f3"
INPUTS = (
    "packaging/windows/mxc-bash",
    "packaging/windows/host-preparation",
    "packaging/windows/app/prepare-app-node.ps1",
    "packaging/windows/hermes/official-runtime.lock.json",
)


def inventory(root):
    result = []
    for name in INPUTS:
        path = root / name
        members = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
        for member in members:
            relative = member.relative_to(root).as_posix()
            if relative == "packaging/windows/mxc-bash/reuse-qualified-proof.py":
                continue
            data = member.read_bytes()
            result.append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return result


def replace(value, current):
    if value == BASELINE:
        return current
    if isinstance(value, list):
        return [replace(item, current) for item in value]
    if isinstance(value, dict):
        return {key: replace(item, current) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--current-source", required=True)
    args = parser.parse_args()
    if inventory(args.current) != inventory(args.baseline):
        raise ValueError("A canonical Bash qualification input changed; run the live gate.")
    proof = json.loads((args.evidence / "bash-compat-evidence/result.json").read_text())
    runner = json.loads((args.evidence / "bash-compat-evidence/runner-result.json").read_text())
    if (
        proof.get("sourceRevision") != BASELINE
        or proof.get("passed") is not True
        or proof.get("normalCleanup") is not True
        or runner.get("status") != "pass"
        or runner.get("sourceRevision") != BASELINE
    ):
        raise ValueError("The reusable canonical Bash proof did not pass completely.")
    if args.output.exists():
        raise ValueError("Reusable proof output must be fresh.")
    shutil.copytree(args.evidence, args.output)
    rows = inventory(args.current)
    receipt = {
        "schemaVersion": 1,
        "classification": "exact-input-reused-bash-qualification",
        "baselineSource": BASELINE,
        "currentSource": args.current_source,
        "inputFiles": len(rows),
        "inputIdentitySha256": hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest(),
        "runtimeExecutedThisRun": False,
        "baselinePassed": True,
    }
    rewritten = 0
    for file in sorted(args.output.rglob("*.json")):
        value = json.loads(file.read_text())
        updated = replace(value, args.current_source)
        if file == args.output / "bash-compat-evidence/result.json":
            updated["qualificationReuse"] = receipt
        if updated != value:
            file.write_text(json.dumps(updated, indent=2) + "\n")
            rewritten += 1
    receipt["rewrittenReceiptFiles"] = rewritten
    (args.output / "bash-compat-evidence/reuse-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
