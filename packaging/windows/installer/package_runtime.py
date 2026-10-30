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
from author_runtime_msi import (
    IDENTITY_PROPERTIES, NAMESPACE, author, element, validate_identity, verify_helper,
)
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
BOOT_RESTORE_FILE = "bin/NemoClawRuntimeRestore.exe"
BOOT_RESTORE_SERVICE = "NemoClawRuntimeRestore"


def validate_launcher_capabilities(native, launcher_sha256):
    """Validate the build observation; command declarations do not authorize invocation."""
    message = "The actual launcher does not report the connected immutable guardian."
    if (
        not isinstance(native, dict)
        or set(native) != {"schemaVersion", "launcherSha256", "capabilities"}
        or type(native["schemaVersion"]) is not int
        or native["schemaVersion"] != 1
        or native["launcherSha256"] != launcher_sha256
    ):
        raise ValueError(message)
    value = native["capabilities"]
    fields = {"schemaVersion", "kind", "immutableRuntime", "guardianEnabled"}
    if (
        not isinstance(value, dict)
        or set(value) not in (fields, fields | {"supportedCommands"})
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1
        or value["kind"] != "native-runtime-capabilities"
        or value["immutableRuntime"] is not True
        or value["guardianEnabled"] is not True
        or ("supportedCommands" in value
            and value["supportedCommands"] != ["native-state-inspection-v1"])
    ):
        raise ValueError(message)
    # An older package can still be composed. It cannot claim inspection support.
    return value.get("supportedCommands", []).copy()


def exact_copy(source: Path, destination: Path, *, excluded_entries=frozenset()):
    before = inventory(source)
    selected = [
        row for row in before
        if row["path"].split("/", 1)[0] not in excluded_entries
    ]
    destination.mkdir()
    try:
        for row in selected:
            output = destination / row["path"]
            if row["kind"] == "directory":
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source / row["path"], output)
        if inventory(source) != before or inventory(destination) != selected:
            raise ValueError("A package input changed during its exact build copy.")
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise


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
        "bundledLocalInferenceAvailable": assembly.get("localInference") is not None,
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


def update_support_catalog(support, document):
    statuses = {row["agent"]: row["status"] for row in document["agents"]}
    if {row.get("id") for row in support.get("agents", [])} != set(LAYOUT):
        raise ValueError("The host agent catalog is incomplete.")
    for row in support["agents"]:
        row["selectable"] = statuses[row["id"]] in ("qualified", "unqualified")
        if statuses[row["id"]] == "not-included":
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
    return support


def validate_runtime_image(runtime_image: Path, receipt: Path, identity: dict):
    ordinary(runtime_image, False)
    image = read_json(receipt)
    if (
        image.get("classification") != "finished-runtime-application-image"
        or image.get("status") != "built-detached-and-verified"
        or image.get("runtimeId") != identity["runtimeId"]
        or image.get("manifestSha256") != identity["manifestSha256"]
        or image.get("customerExtractionRequired") is not False
        or image.get("runtimeLaunchCopiesRequired") is not False
        or image.get("mountedReadOnly") is not True
        or image.get("payloadObjects") != 1
        or image.get("image", {}).get("sha256") != hash_file(runtime_image)[1]
        or image.get("image", {}).get("bytes") != runtime_image.stat().st_size
    ):
        raise ValueError("The finished runtime application image differs from its seal.")
    return image


def recompose_reviewed(payload: Path, assembly: Path, selection: Path, output: Path):
    """Apply a trusted controller's reviewed decision without rebuilding runtime bytes.

    As with compose(), authentication and independent review belong to the caller.
    The new payload still needs a rebuilt native UI, MSI, Burn and final acceptance.
    """
    ordinary(payload, True)
    ordinary(output.parent, True)
    if output.exists() or output.is_symlink() or output.resolve().is_relative_to(payload.resolve()):
        raise ValueError("The reviewed package payload must be fresh and separate.")
    record = read_json(assembly)
    inputs = read_json(payload / "immutable-package-inputs.json")
    identity = validate_identity(record["runtime"])
    agents = record.get("agents")
    if (
        record.get("classification") != "windows-immutable-runtime-assembly"
        or record.get("buildCompleteForSelectedAgents") is not True
        or record.get("deliveryContract") != "finished-native-app-v1"
        or not isinstance(agents, list)
        or len(agents) != 1
        or not isinstance(agents[0], dict)
        or agents[0].get("agent") not in ("openclaw", "hermes")
        or inputs.get("schemaVersion") != 1
        or inputs.get("classification") != "immutable-package-inputs"
        or inputs.get("deliveryContract") not in {"finished-native-app-v1", "finished-native-image-v1"}
        or inputs.get("runtime") != identity
        or inputs.get("assemblyReceiptSha256") != hash_file(assembly)[1]
        or inputs.get("availabilityEvidence") != []
        or inputs.get("customerBuildRequired") is not False
        or inputs.get("runtimeLaunchCopiesRequired") is not False
        or inputs.get("installedAcceptance") is not False
        or inputs.get("completePackage") is not False
    ):
        raise ValueError("Recomposition requires the original unqualified single-agent payload.")
    unqualified, _ = availability(record, None)
    if read_json(payload / "runtime-package-availability.json") != unqualified:
        raise ValueError("The original runtime availability is not unqualified.")
    document, references = availability(record, read_json(selection))
    if [row["agent"] for row in references] != [agents[0]["agent"]]:
        raise ValueError("The reviewed decision must qualify the included runtime.")
    if inputs["deliveryContract"] == "finished-native-image-v1":
        image_base = payload / "images" / identity["runtimeId"]
        image = validate_runtime_image(image_base.with_suffix(".vhdx"), image_base.with_suffix(".json"), identity)
        if inputs.get("runtimeImage") != image["image"]:
            raise ValueError("The original package image binding changed before recomposition.")
        runtime_root = payload / "runtimes" / identity["runtimeId"]
        ordinary(runtime_root, True)
        if any(runtime_root.iterdir()):
            raise ValueError("An image package must retain an empty runtime mount point.")
    else:
        verify_seal(payload / "runtimes" / identity["runtimeId"], identity)
    if hash_file(payload / "bin/node.exe")[1] != identity["nodeSha256"]:
        raise ValueError("The package shared Node differs from the runtime seal.")
    validate_launcher_capabilities(inputs.get("launcher"), hash_file(payload / "bin/NemoClaw.exe")[1])
    support = update_support_catalog(read_json(payload / "agent-support.json"), document)
    before = inventory(payload)
    mutable = {
        "agent-support.json", "runtime-package-availability.json", "immutable-package-inputs.json"
    }
    preserved = [
        row for row in before
        if row["path"] not in mutable and row["path"].split("/", 1)[0] != "native-ui"
    ]
    # The bootstrapper embeds availability; copying the old UI would retain
    # its disabled selection even after the runtime was independently reviewed.
    exact_copy(payload, output, excluded_entries=mutable | {"native-ui"})
    try:
        write_json(output / "runtime-package-availability.json", document)
        write_json(output / "agent-support.json", support)
        write_json(output / "immutable-package-inputs.json", {
            **inputs, "availabilityEvidence": references,
        })
        after = [row for row in inventory(output) if row["path"] not in mutable]
        if after != preserved or inventory(payload) != before:
            raise ValueError("Reviewed recomposition changed immutable package bytes.")
        return identity
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)
        raise


def compose(
    host: Path,
    assembled: Path,
    launcher: Path,
    capabilities: Path,
    output: Path,
    selection: Path | None,
    runtime_image: Path | None = None,
    runtime_image_receipt: Path | None = None,
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
    if (runtime_image is None) != (runtime_image_receipt is None):
        raise ValueError("The runtime image and its receipt must be supplied together.")
    image = None
    if runtime_image is not None:
        image = validate_runtime_image(runtime_image, runtime_image_receipt, identity)
    else:
        verify_seal(assembled / relative, identity)
    if hash_file(host / "bin/node.exe")[1] != identity["nodeSha256"]:
        raise ValueError("The package shared Node differs from the runtime seal.")
    native = read_json(capabilities, 4096)
    validate_launcher_capabilities(native, hash_file(launcher)[1])
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
        (output / "runtimes" / identity["runtimeId"]).mkdir(parents=True)
        if image is None:
            exact_copy(assembled / "runtimes", output / "runtime-copy")
            # The complete runtime subtree moves once inside the build staging root.
            # No node.exe is added here; the stable common bin remains the sole owner.
            (output / "runtimes" / identity["runtimeId"]).rmdir()
            (output / "runtime-copy" / identity["runtimeId"]).rename(output / relative)
            (output / "runtime-copy").rmdir()
        else:
            (output / "images").mkdir()
            installed_image = output / "images" / (identity["runtimeId"] + ".vhdx")
            shutil.move(runtime_image, installed_image)
            if hash_file(installed_image)[1] != image["image"]["sha256"]:
                raise ValueError("The runtime application image changed during its staging move.")
            write_json(output / "images" / (identity["runtimeId"] + ".json"), image)
        shutil.copy2(launcher, output / "bin/NemoClaw.exe")
        # Native setup and agent launch use the compiled NemoClaw executable.
        # The generic CLI and its separate app/dependency trees are build inputs only.
        (output / "bin/nemoclaw.cmd").unlink(missing_ok=True)
        (output / "bin/openclaw.cmd").unlink(missing_ok=True)
        if image is None:
            verify_seal(output / relative, identity)
        write_json(output / "runtime-package-availability.json", document)
        support = update_support_catalog(read_json(host / "agent-support.json"), document)
        write_json(output / "agent-support.json", support)
        write_json(
            output / "immutable-package-inputs.json",
            {
                "schemaVersion": 1,
                "classification": "immutable-package-inputs",
                "runtime": identity,
                "launcher": native,
                **({"hermesBundleUpgradeProtocol": "superseded-retirement-v1"}
                   if [row["agent"] for row in record["agents"]] == ["hermes"] else {}),
                "availabilityEvidence": references,
                "inputPayloadReceiptSha256": hash_file(
                    host / "runtime-payload-receipt.json"
                )[1],
                "assemblyReceiptSha256": hash_file(assembled / "assembly.json")[1],
                "deliveryContract": "finished-native-image-v1" if image else "finished-native-app-v1",
                **({"runtimeImage": image["image"]} if image else {}),
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


def payload_authoring(
    payload: Path,
    output: Path,
    cabinet_source: Path | None = None,
    cabinet_runtime_source: Path | None = None,
    transaction_helper: Path | None = None,
):
    explicit_cabinet_source = cabinet_source is not None
    if cabinet_runtime_source is not None and not explicit_cabinet_source:
        raise ValueError("The runtime cabinet alias requires the payload cabinet alias.")
    cabinet_source = payload if cabinet_source is None else cabinet_source
    if (
        not cabinet_source.is_absolute()
        or cabinet_source.resolve(strict=True) != payload.resolve(strict=True)
    ):
        raise ValueError("The cabinet source alias does not resolve to the verified payload.")
    inputs = read_json(payload / "immutable-package-inputs.json")
    image_contract = inputs.get("deliveryContract") == "finished-native-image-v1"
    validate_identity(inputs["runtime"])
    runtime_relative = Path("runtimes") / inputs["runtime"]["runtimeId"]
    runtime_root = payload / runtime_relative
    if cabinet_runtime_source is not None and (
        not cabinet_runtime_source.is_absolute()
        or cabinet_runtime_source.resolve(strict=True) != runtime_root.resolve(strict=True)
    ):
        raise ValueError(
            "The cabinet runtime alias does not resolve to the verified runtime."
        )
    rows = inventory(payload)
    restore = payload / BOOT_RESTORE_FILE
    if image_contract:
        if transaction_helper is None:
            raise ValueError("The image package requires its pinned native startup helper.")
        digest = hash_file(transaction_helper)[1]
        verify_helper(transaction_helper, digest)
        if restore.exists():
            verify_helper(restore, digest)
        else:
            with restore.open("xb") as stream:
                stream.write(transaction_helper.read_bytes())
            verify_helper(restore, digest)
        verify_helper(transaction_helper, digest)
        rows = inventory(payload)
    elif restore.exists():
        raise ValueError("A loose runtime package cannot contain an image startup helper.")
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
        service_files = [name for name in files if name == BOOT_RESTORE_FILE]
        files = [name for name in files if name != BOOT_RESTORE_FILE]
        groups = [files[i : i + 64] for i in range(0, len(files), 64)] or [[]]
        if service_files:
            groups.append(service_files)
        for index, group in enumerate(groups):
            key = (
                BOOT_RESTORE_FILE if group == [BOOT_RESTORE_FILE]
                else directory + ":" + str(index) + ":" + "|".join(group)
            )
            identifier = stable_id("Cmp_", key)
            component = element(
                node,
                "Component",
                Id=identifier,
                Guid=str(uuid.uuid5(COMPONENT_NAMESPACE, key)),
                Bitness="always64",
            )
            components.append(identifier)
            if not group or (directory == "" and index == 0):
                # Register the root for RemoveFolders, after child directories.
                # RemoveFolder runs during RemoveFiles while those still exist.
                element(component, "CreateFolder")
            for number, relative in enumerate(group):
                source = cabinet_source / relative
                if cabinet_runtime_source is not None and Path(relative).is_relative_to(
                    runtime_relative
                ):
                    source = cabinet_runtime_source / Path(relative).relative_to(
                        runtime_relative
                    )
                element(
                    component,
                    "File",
                    Id=stable_id("File_", relative),
                    Name=Path(relative).name,
                    Source=str(
                        source.absolute()
                        if explicit_cabinet_source
                        else source.resolve()
                    ),
                    KeyPath="yes" if number == 0 else "no",
                )
            if group == [BOOT_RESTORE_FILE]:
                # MSI formats private tuple properties, avoiding the 255-character
                # authored argument limit while preserving the complete identity.
                arguments = "--runtime-boot-service " + " ".join(
                    "[" + name + "]" for name in IDENTITY_PROPERTIES.values()
                )
                element(
                    component, "ServiceInstall", Id=BOOT_RESTORE_SERVICE,
                    Name=BOOT_RESTORE_SERVICE, DisplayName="NemoClaw Runtime Restore",
                    Description="Restores the verified read-only runtime after Windows starts.",
                    Type="ownProcess", Start="auto", ErrorControl="normal",
                    Account="LocalSystem", Vital="yes", Arguments=arguments,
                )
                # Admission remains the transaction's responsibility. Do not start
                # the service during an MSI transaction with a retired selector.
                element(
                    component, "ServiceControl", Id=BOOT_RESTORE_SERVICE + "Control",
                    Name=BOOT_RESTORE_SERVICE, Stop="both", Remove="uninstall", Wait="yes",
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
    prepare.add_argument("--runtime-image", type=Path)
    prepare.add_argument("--runtime-image-receipt", type=Path)
    reviewed = sub.add_parser("recompose-reviewed")
    for name in ("payload", "assembly", "reviewed-availability", "output"):
        reviewed.add_argument("--" + name, type=Path, required=True)
    build_parser = sub.add_parser("author")
    for name in ("payload", "output", "transaction-helper", "transaction-output"):
        build_parser.add_argument("--" + name, type=Path, required=True)
    build_parser.add_argument("--cabinet-source", type=Path)
    build_parser.add_argument("--cabinet-runtime-source", type=Path)
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
                    args.runtime_image,
                    args.runtime_image_receipt,
                )
            )
        )
    elif args.action == "recompose-reviewed":
        print(json.dumps(recompose_reviewed(
            args.payload, args.assembly, args.reviewed_availability, args.output
        )))
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
        if inputs.get("deliveryContract") == "finished-native-image-v1":
            image = args.payload / "images" / (inputs["runtime"]["runtimeId"] + ".vhdx")
            if inputs.get("runtimeImage", {}).get("sha256") != hash_file(image)[1]:
                raise ValueError("The authored runtime image changed after composition.")
        else:
            verify_seal(
                args.payload / "runtimes" / inputs["runtime"]["runtimeId"],
                inputs["runtime"],
            )
        stats = payload_authoring(
            args.payload,
            args.output,
            args.cabinet_source,
            args.cabinet_runtime_source,
            args.transaction_helper,
        )
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
