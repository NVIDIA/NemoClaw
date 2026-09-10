# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Compose the finished Windows app; qualification is an explicit external input."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import uuid
import xml.etree.ElementTree as ET

from assemble_runtime import (
    LAYOUT,
    arm64_executable,
    inventory,
    ordinary,
    read_json,
    write_json,
)
from author_runtime_msi import NAMESPACE, author, element, validate_identity
from build_runtime_manifest import HEADER, hash_file

COMMON_DIRECTORIES = {
    "bin",
    "config",
    "mxc",
    "desktop-icons",
}
LEGACY_DIRECTORIES = {
    "qualification",
    "onboarding",
    "nemoclaw",
    "openclaw",
    "pi",
    "python",
    "hermes",
    "deepagents",
    "nemocua",
    "native-ui",
}
COMPONENT_NAMESPACE = uuid.UUID("b90129a5-8564-43de-b5e4-99617eec329d")


def exact_copy(source: Path, destination: Path):
    before = inventory(source)
    destination.mkdir()
    for row in before:
        output = destination / row["path"]
        if row["kind"] == "directory":
            output.mkdir(parents=True, exist_ok=True)
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / row["path"], output)
    if inventory(source) != before or inventory(destination) != before:
        raise ValueError("A package input changed during its exact build copy.")


def verify_seal(root: Path, identity):
    identity = validate_identity(identity)
    rows = inventory(root, generated_controls=True)
    lines = []
    for row in sorted(rows, key=lambda value: value["path"].encode("utf-8")):
        name = row["path"].encode("utf-8").hex()
        lines.append(
            "D\t-\t0\t" + name
            if row["kind"] == "directory"
            else "F\t" + row["sha256"] + "\t" + str(row["bytes"]) + "\t" + name
        )
    fields = [
        identity[name]
        for name in (
            "runtimeId",
            "manifestSha256",
            "sourceRevision",
            "nodeSha256",
            "nodeVersion",
        )
    ]
    expected = (
        "\n".join(
            [
                HEADER,
                fields[0],
                fields[2],
                fields[3],
                fields[4],
                str(len(lines)),
                *lines,
            ]
        )
        + "\n"
    ).encode("ascii")
    if (root / "runtime.manifest").read_bytes() != expected or hashlib.sha256(
        expected
    ).hexdigest() != identity["manifestSha256"]:
        raise ValueError(
            "The assembled runtime no longer matches its sealed inventory."
        )
    if (root / "runtime.ready").read_bytes() != (
        "NEMOCLAW_RUNTIME_V1\n" + "\n".join(fields) + "\n"
    ).encode("ascii"):
        raise ValueError("The version-local descriptor differs from its sealed tuple.")


def availability(assembly, selection):
    identity = validate_identity(assembly["runtime"])
    included = {record["agent"] for record in assembly["agents"]}
    qualified = set()
    references = []
    if selection is not None:
        # The trusted CI controller supplies independently reviewed evidence.
        # This build adapter binds that decision to this exact tuple; it does
        # not authenticate GitHub artifacts or manufacture qualification.
        if (
            set(selection) != {"schemaVersion", "classification", "runtime", "agents"}
            or selection["schemaVersion"] != 1
            or selection["classification"] != "reviewed-native-runtime-availability"
            or selection["runtime"] != identity
            or not isinstance(selection["agents"], list)
        ):
            raise ValueError(
                "The reviewed availability decision names a different runtime."
            )
        for row in selection["agents"]:
            if (
                set(row) != {"agent", "evidenceSha256"}
                or row["agent"] not in included
                or row["agent"] in qualified
                or row["agent"] == "hermes"
                or not isinstance(row["evidenceSha256"], str)
                or len(row["evidenceSha256"]) != 64
                or any(ch not in "0123456789abcdef" for ch in row["evidenceSha256"])
            ):
                raise ValueError(
                    "An unavailable, duplicate or unbound agent was selected."
                )
            qualified.add(row["agent"])
            references.append(row)
    document = {
        "schemaVersion": 1,
        "classification": "native-runtime-package-availability",
        "runtimeId": identity["runtimeId"],
        "manifestSha256": identity["manifestSha256"],
        "sourceRevision": identity["sourceRevision"],
        "prebuiltLocalModelAvailable": assembly.get("localModel") is not None,
        "agents": [
            {
                "agent": agent,
                "status": "qualified"
                if agent in qualified
                else "unqualified"
                if agent in included
                else "not-included",
            }
            for agent in LAYOUT
        ],
    }
    return document, references


def compose(
    host: Path,
    assembled: Path,
    launcher: Path,
    capabilities: Path,
    output: Path,
    selection: Path | None,
):
    if output.exists() or output.is_symlink():
        raise ValueError("The finished package payload must be fresh.")
    ordinary(host, True)
    ordinary(output.parent, True)
    arm64_executable(launcher)
    record = read_json(assembled / "assembly.json")
    identity = validate_identity(record["runtime"])
    if (
        record.get("classification") != "windows-immutable-runtime-assembly"
        or record.get("buildCompleteForSelectedAgents") is not True
        or record.get("deliveryContract") != "finished-native-app-v1"
    ):
        raise ValueError("The selected runtime assembly did not complete.")
    relative = "runtimes/" + identity["runtimeId"]
    verify_seal(assembled / relative, identity)
    if hash_file(host / "bin/node.exe")[1] != identity["nodeSha256"]:
        raise ValueError("The package shared Node differs from the runtime seal.")
    native = read_json(capabilities, 4096)
    if (
        set(native) != {"schemaVersion", "launcherSha256", "capabilities"}
        or native["schemaVersion"] != 1
        or native["launcherSha256"] != hash_file(launcher)[1]
        or native["capabilities"]
        != {
            "schemaVersion": 1,
            "kind": "native-runtime-capabilities",
            "immutableRuntime": True,
            "guardianEnabled": True,
        }
    ):
        raise ValueError(
            "The actual launcher does not report the connected immutable guardian."
        )
    document, references = availability(
        record, read_json(selection) if selection else None
    )
    entries = list(host.iterdir())
    for entry in entries:
        ordinary(entry, entry.is_dir())
        if entry.is_dir() and entry.name not in COMMON_DIRECTORIES | LEGACY_DIRECTORIES:
            raise ValueError(
                "The host package contains an undeclared top-level directory."
            )
    output.mkdir()
    try:
        for entry in entries:
            if entry.is_dir():
                if entry.name in COMMON_DIRECTORIES:
                    exact_copy(entry, output / entry.name)
            elif entry.name not in {
                "agent-support.json",
                "runtime-payload-receipt.json",
            }:
                shutil.copy2(entry, output / entry.name)
        (output / "runtimes").mkdir()
        exact_copy(assembled / "runtimes", output / "runtime-copy")
        # The complete runtime subtree moves once inside the build staging root.
        # No node.exe is added here; the stable common bin remains the sole owner.
        (output / "runtime-copy" / identity["runtimeId"]).rename(output / relative)
        (output / "runtime-copy").rmdir()
        shutil.copy2(launcher, output / "bin/NemoClaw.exe")
        # Native setup and agent launch use the compiled NemoClaw executable.
        # The generic CLI and its separate app/dependency trees are build inputs only.
        (output / "bin/nemoclaw.cmd").unlink(missing_ok=True)
        (output / "bin/openclaw.cmd").unlink(missing_ok=True)
        verify_seal(output / relative, identity)
        write_json(output / "runtime-package-availability.json", document)
        support = read_json(host / "agent-support.json")
        statuses = {row["agent"]: row["status"] for row in document["agents"]}
        if {row.get("id") for row in support.get("agents", [])} != set(LAYOUT):
            raise ValueError("The host agent catalog is incomplete.")
        for row in support["agents"]:
            row["selectable"] = statuses[row["id"]] != "not-included"
            if not row["selectable"]:
                row["limitation"] = "Unavailable in this preview"
            elif statuses[row["id"]] == "unqualified":
                row["limitation"] = "Preview: full runtime checks are pending."
            else:
                row.pop("limitation", None)
            if row["id"] == "hermes":
                row["version"] = "0.21.1"
                row["source"] = (
                    "https://github.com/NousResearch/hermes-agent/tree/2237be355906fbe6065ce1815711eee52b2d646e"
                )
        write_json(output / "agent-support.json", support)
        write_json(
            output / "immutable-package-inputs.json",
            {
                "schemaVersion": 1,
                "classification": "immutable-package-inputs",
                "runtime": identity,
                "launcher": native,
                "availabilityEvidence": references,
                "inputPayloadReceiptSha256": hash_file(
                    host / "runtime-payload-receipt.json"
                )[1],
                "assemblyReceiptSha256": hash_file(assembled / "assembly.json")[1],
                "deliveryContract": "finished-native-app-v1",
                "customerBuildRequired": False,
                "runtimeLaunchCopiesRequired": False,
                "installedAcceptance": False,
                "completePackage": False,
            },
        )
        return identity
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)
        raise


def stable_id(prefix: str, value: str):
    return prefix + hashlib.sha256(value.lower().encode()).hexdigest()[:32]


def payload_authoring(payload: Path, output: Path):
    rows = inventory(payload)
    wix = ET.Element("{" + NAMESPACE + "}Wix")
    fragment = element(wix, "Fragment")
    root = element(fragment, "DirectoryRef", Id="INSTALLFOLDER")
    directories = {"": root}
    components = []
    by_directory = {}
    for row in rows:
        relative = row["path"]
        if row["kind"] == "directory":
            parent = Path(relative).parent.as_posix()
            parent = "" if parent == "." else parent
            directories[relative] = element(
                directories[parent],
                "Directory",
                Id=stable_id("Dir_", relative),
                Name=Path(relative).name,
            )
        else:
            parent = Path(relative).parent.as_posix()
            by_directory.setdefault("" if parent == "." else parent, []).append(
                relative
            )
    for directory, node in directories.items():
        files = by_directory.get(directory, [])
        groups = [files[i : i + 64] for i in range(0, len(files), 64)] or [[]]
        for index, group in enumerate(groups):
            key = directory + ":" + str(index) + ":" + "|".join(group)
            identifier = stable_id("Cmp_", key)
            component = element(
                node,
                "Component",
                Id=identifier,
                Guid=str(uuid.uuid5(COMPONENT_NAMESPACE, key)),
                Bitness="always64",
            )
            components.append(identifier)
            if not group:
                element(component, "CreateFolder")
            for number, relative in enumerate(group):
                element(
                    component,
                    "File",
                    Id=stable_id("File_", relative),
                    Name=Path(relative).name,
                    Source=str((payload / relative).resolve()),
                    KeyPath="yes" if number == 0 else "no",
                )
    if len(components) >= 65536:
        raise ValueError(
            "The grouped package exceeds the Windows Installer component bound."
        )
    group = element(element(wix, "Fragment"), "ComponentGroup", Id="PayloadComponents")
    for identifier in components:
        element(group, "ComponentRef", Id=identifier)
    ET.indent(wix, space="  ")
    with output.open("x", encoding="utf-8") as stream:
        stream.write(ET.tostring(wix, encoding="unicode") + "\n")
    return {
        "files": sum(row["kind"] == "file" for row in rows),
        "components": len(components),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    prepare = sub.add_parser("compose")
    for name in (
        "host",
        "assembled",
        "launcher",
        "capabilities",
        "output",
    ):
        prepare.add_argument("--" + name, type=Path, required=True)
    prepare.add_argument("--reviewed-availability", type=Path)
    build_parser = sub.add_parser("author")
    for name in ("payload", "output", "transaction-helper", "transaction-output"):
        build_parser.add_argument("--" + name, type=Path, required=True)
    ui = sub.add_parser("bootstrapper")
    for name in ("published", "payload", "output"):
        ui.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    if args.action == "compose":
        print(
            json.dumps(
                compose(
                    args.host,
                    args.assembled,
                    args.launcher,
                    args.capabilities,
                    args.output,
                    args.reviewed_availability,
                )
            )
        )
    elif args.action == "bootstrapper":
        props = ET.parse(Path(__file__).parents[1] / "RequiredPayload.props")
        expected = {
            row.attrib["Include"].split("\\", 1)[1]
            for row in props.findall(".//NemoClawRequiredPayload")
            if row.attrib["Phase"] == "Package"
            and row.attrib["Include"].startswith("native-ui\\")
        }
        observed = {
            row["path"] for row in inventory(args.published) if row["kind"] == "file"
        }
        if observed != expected:
            raise ValueError(
                "The ARM64 bootstrapper publish differs from its exact native support set."
            )
        wix = ET.Element("{" + NAMESPACE + "}Wix")
        group = element(
            element(wix, "Fragment"), "PayloadGroup", Id="NemoClawBootstrapperPayloads"
        )
        for relative in sorted(observed):
            arm64_executable(args.published / relative)
            if relative != "NemoClaw.Bootstrapper.exe":
                element(
                    group,
                    "Payload",
                    Name=relative,
                    SourceFile=str((args.published / relative).resolve()),
                )
        exact_copy(args.published, args.payload / "native-ui")
        ET.indent(wix, space="  ")
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(ET.tostring(wix, encoding="unicode") + "\n")
    else:
        inputs = read_json(args.payload / "immutable-package-inputs.json")
        verify_seal(
            args.payload / "runtimes" / inputs["runtime"]["runtimeId"],
            inputs["runtime"],
        )
        stats = payload_authoring(args.payload, args.output)
        xml, record = author(
            inputs["runtime"],
            args.transaction_helper,
            hash_file(args.transaction_helper)[1],
        )
        with args.transaction_output.open("x", encoding="utf-8") as stream:
            stream.write(xml)
        print(json.dumps({"payload": stats, "transaction": record}))


if __name__ == "__main__":
    main()
