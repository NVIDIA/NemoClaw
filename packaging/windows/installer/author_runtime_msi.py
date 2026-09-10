# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Build-only authoring for the dormant immutable MSI transaction prototype."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

NAMESPACE = "http://wixtoolset.org/schemas/v4/wxs"
ET.register_namespace("", NAMESPACE)
# WiX5.0.2 CustomAction.Target is a 255-character Formatted column.
TARGET_LIMIT = 255
IDENTITY_PROPERTIES = {
    "runtimeId": "NemoClawRuntimeId",
    "manifestSha256": "NemoClawManifestSha256",
    "sourceRevision": "NemoClawSourceRevision",
    "nodeSha256": "NemoClawNodeSha256",
    "nodeVersion": "NemoClawNodeVersion",
}


def element(parent, name, **attributes):
    return ET.SubElement(parent, "{" + NAMESPACE + "}" + name, attributes)


def validate_identity(record):
    expected = {
        "runtimeId",
        "manifestSha256",
        "sourceRevision",
        "nodeSha256",
        "nodeVersion",
    }
    if type(record) is not dict or set(record) != expected:
        raise ValueError(
            "The MSI runtime identity must have exactly the sealed tuple fields."
        )
    for name, length in (
        ("runtimeId", 64),
        ("manifestSha256", 64),
        ("sourceRevision", 40),
        ("nodeSha256", 64),
    ):
        if type(record[name]) is not str or not re.fullmatch(
            "[a-f0-9]{" + str(length) + "}", record[name]
        ):
            raise ValueError("The MSI runtime tuple contains an invalid identity.")
    if type(record["nodeVersion"]) is not str or not re.fullmatch(
        r"(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})",
        record["nodeVersion"],
    ):
        raise ValueError("The shared Node version is not exact.")
    return record


def verify_helper(helper: Path, expected_sha256: str):
    if (
        not re.fullmatch("[a-f0-9]{64}", expected_sha256)
        or helper.is_symlink()
        or not helper.is_file()
    ):
        raise ValueError(
            "The embedded transaction helper requires an exact regular-file identity."
        )
    data = helper.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("The embedded transaction helper bytes changed.")
    if len(data) < 64 or data[:2] != b"MZ":
        raise ValueError("The transaction helper is not a Windows executable.")
    pe = int.from_bytes(data[60:64], "little")
    if (
        pe + 6 > len(data)
        or data[pe : pe + 4] != b"PE\0\0"
        or data[pe + 4 : pe + 6] != b"\x64\xaa"
    ):
        raise ValueError("The transaction helper is not native Windows ARM64.")
    return {"sha256": expected_sha256, "bytes": len(data), "architecture": "arm64"}


def author(identity, helper: Path, expected_sha256: str):
    identity = validate_identity(identity)
    helper_record = verify_helper(helper, expected_sha256)
    include = ET.Element("{" + NAMESPACE + "}Include")
    element(
        include,
        "Launch",
        Condition="NOT RollbackDisabled",
        Message="Windows Installer rollback must be enabled before maintaining this runtime.",
    )
    element(
        include,
        "Binary",
        Id="NativeRuntimeTransaction",
        SourceFile=str(helper.resolve()),
    )
    # Database defaults exist in both UI and server sessions. Mixed-case names
    # are private MSI properties, so command-line public properties cannot replace
    # this sealed identity. No UI setter or SecureCustomProperties transport is used.
    for field, name in IDENTITY_PROPERTIES.items():
        element(include, "Property", Id=name, Value=identity[field])
    tuple_args = " ".join("[" + name + "]" for name in IDENTITY_PROPERTIES.values())
    root = "NOT UPGRADINGPRODUCTCODE"
    installing = root + ' AND NOT (REMOVE ~= "ALL")'
    removing = root + ' AND REMOVE ~= "ALL"'
    actions = [
        (
            "NativeRuntimeRollback",
            "rollback",
            "rollback " + identity["runtimeId"],
            root,
            1501,
        ),
        (
            "NativeRuntimeBeginInstall",
            "deferred",
            "begin-install " + tuple_args + ' "[ProductCode]"',
            installing,
            1502,
        ),
        (
            "NativeRuntimeBeginRemove",
            "deferred",
            "begin-remove " + identity["runtimeId"] + ' "[ProductCode]"',
            removing,
            1503,
        ),
        (
            "NativeRuntimeJoinRemoval",
            "deferred",
            "join-remove " + identity["runtimeId"] + ' "[UPGRADINGPRODUCTCODE]"',
            "UPGRADINGPRODUCTCODE",
            1504,
        ),
        ("NativeRuntimeVerify", "deferred", "verify " + tuple_args, installing, 6501),
        (
            "NativeRuntimeCommitInstall",
            "commit",
            "commit-install " + identity["runtimeId"],
            installing,
            6502,
        ),
        (
            "NativeRuntimeCommitRemove",
            "commit",
            "commit-remove " + identity["runtimeId"],
            removing,
            6503,
        ),
    ]
    for name, execute, arguments, _condition, _sequence in actions:
        command = "--runtime-msi " + arguments
        if len(command) > TARGET_LIMIT:
            raise ValueError("A native MSI command exceeds CustomAction.Target.")
        element(
            include,
            "CustomAction",
            Id=name,
            BinaryRef="NativeRuntimeTransaction",
            ExeCommand=command,
            Execute=execute,
            Impersonate="no",
            Return="check",
        )
    sequence = element(include, "InstallExecuteSequence")
    for name, _execute, _arguments, condition, order in actions:
        element(
            sequence, "Custom", Action=name, Condition=condition, Sequence=str(order)
        )
    # Flush retirement while the transaction remains open. MajorUpgrade places
    # RemoveExistingProducts just after this, before ProcessComponents (1600).
    element(sequence, "InstallExecute", Sequence="1505")
    ET.indent(include, space="  ")
    xml = ET.tostring(include, encoding="unicode") + "\n"
    return xml, {
        "schemaVersion": 1,
        "classification": "dormant-msi-transaction-authoring",
        "runtime": identity,
        "helper": helper_record,
        "identityTransport": "database-private-properties",
        "targetColumnLimit": TARGET_LIMIT,
        "maximumAuthoredTargetLength": max(
            len("--runtime-msi " + row[2]) for row in actions
        ),
        "installedExecution": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--helper-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.receipt.exists():
        raise ValueError("The authoring and receipt outputs must be fresh.")
    xml, receipt = author(
        json.loads(args.identity.read_text()), args.helper, args.helper_sha256
    )
    receipt["authoringSha256"] = hashlib.sha256(xml.encode()).hexdigest()
    args.output.write_text(xml, encoding="utf-8")
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
