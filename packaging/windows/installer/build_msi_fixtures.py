# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Prepare small, explicitly unqualified MSI transaction fixtures."""

import argparse
import hashlib
import json
from pathlib import Path
import uuid
import xml.etree.ElementTree as ET

from author_runtime_msi import NAMESPACE, author, element
from build_runtime_manifest import build
from assign_runtime_namespace import assign

NAMESPACE_GUID = uuid.UUID("b90129a5-8564-43de-b5e4-99617eec329d")


def prepare(
    output: Path,
    node: Path,
    node_license: Path,
    node_version: str,
    helper: Path,
    revision: str,
):
    if output.exists():
        raise ValueError("The MSI fixture output must be fresh.")
    output.mkdir(parents=True)
    helper_hash = hashlib.sha256(helper.read_bytes()).hexdigest()
    fixtures = []
    for index, label in enumerate(
        ("first", "upgrade", "deferred-failure", "commit-failure"), start=1
    ):
        directory = output / label
        content = directory / "content"
        content.mkdir(parents=True)
        (content / "payload.txt").write_text(
            "Controlled MSI transaction fixture: " + label + "\n"
        )
        (content / "empty").mkdir()
        (content / "NODE-LICENSE.txt").write_bytes(node_license.read_bytes())
        component_identity = hashlib.sha256(
            (
                helper_hash
                + "|"
                + hashlib.sha256(node.read_bytes()).hexdigest()
                + "|"
                + hashlib.sha256(node_license.read_bytes()).hexdigest()
                + "|"
                + label
            ).encode()
        ).hexdigest()
        namespace = assign(directory / "namespace.json", revision, component_identity)
        runtime_id = namespace["runtimeId"]
        encoded, identity = build(content, node, revision, node_version, runtime_id)
        manifest = directory / "runtime.manifest"
        manifest.write_bytes(encoded)
        ready = directory / "runtime.ready"
        ready.write_bytes(
            (
                "NEMOCLAW_RUNTIME_V1\n"
                + "\n".join(
                    identity[name]
                    for name in (
                        "runtimeId",
                        "manifestSha256",
                        "sourceRevision",
                        "nodeSha256",
                        "nodeVersion",
                    )
                )
                + "\n"
            ).encode("ascii")
        )
        transactions, _ = author(identity, helper, helper_hash)
        include = ET.fromstring(transactions)
        if label == "deferred-failure":
            element(
                include,
                "CustomAction",
                Id="FixtureDeferredFailure",
                Directory="System64Folder",
                ExeCommand='"[System64Folder]cmd.exe" /d /c exit 42',
                Execute="deferred",
                Impersonate="no",
                Return="check",
            )
            element(
                include.find("{" + NAMESPACE + "}InstallExecuteSequence"),
                "Custom",
                Action="FixtureDeferredFailure",
                Condition="NOT Installed",
                Sequence="6504",
            )
        if label == "commit-failure":
            action = next(
                item
                for item in include.findall("{" + NAMESPACE + "}CustomAction")
                if item.get("Id") == "NativeRuntimeCommitInstall"
            )
            action.set(
                "ExeCommand",
                action.get("ExeCommand") + " --fixture-fail-before-admission",
            )
        ET.indent(include, space="  ")
        authoring = directory / "transactions.wxi"
        authoring.write_text(ET.tostring(include, encoding="unicode") + "\n")
        wix = ET.Element("{" + NAMESPACE + "}Wix")
        fragment = element(wix, "Fragment")
        bins = element(fragment, "DirectoryRef", Id="BinFolder")
        shared = element(
            bins,
            "Component",
            Id="FixtureSharedNode",
            Guid="F2481BB4-AB62-4EEA-8DB7-E33FA94FEF0B",
            Bitness="always64",
        )
        element(
            shared,
            "File",
            Id="FixtureNode",
            Name="node.exe",
            Source=str(node.resolve()),
            KeyPath="yes",
        )
        root = element(fragment, "DirectoryRef", Id="INSTALLFOLDER")
        runtimes = element(root, "Directory", Id="FixtureRuntimes", Name="runtimes")
        version = element(
            runtimes,
            "Directory",
            Id="FixtureRuntimeVersion",
            Name=identity["runtimeId"],
        )
        component = element(
            version,
            "Component",
            Id="FixtureContent",
            Guid=str(uuid.uuid5(NAMESPACE_GUID, identity["runtimeId"])),
            Bitness="always64",
        )
        for name, path in (
            ("payload.txt", content / "payload.txt"),
            ("NODE-LICENSE.txt", content / "NODE-LICENSE.txt"),
            ("runtime.manifest", manifest),
            ("runtime.ready", ready),
        ):
            attributes = {
                "Id": "FixtureFile" + name.replace(".", "").replace("-", ""),
                "Name": name,
                "Source": str(path.resolve()),
            }
            if name == "payload.txt":
                attributes["KeyPath"] = "yes"
            element(component, "File", **attributes)
        empty = element(version, "Directory", Id="FixtureEmptyDirectory", Name="empty")
        empty_component = element(
            empty,
            "Component",
            Id="FixtureEmpty",
            Guid=str(uuid.uuid5(NAMESPACE_GUID, identity["runtimeId"] + "/empty")),
            Bitness="always64",
        )
        element(empty_component, "CreateFolder")
        group = element(
            element(wix, "Fragment"), "ComponentGroup", Id="PayloadComponents"
        )
        for name in ("FixtureSharedNode", "FixtureContent", "FixtureEmpty"):
            element(group, "ComponentRef", Id=name)
        ET.indent(wix, space="  ")
        payload = directory / "payload.wxs"
        payload.write_text(ET.tostring(wix, encoding="unicode") + "\n")
        fixtures.append(
            {
                "label": label,
                "version": "1.0." + str(index),
                "identity": identity,
                "authoring": str(authoring.resolve()),
                "payloadAuthoring": str(payload.resolve()),
                "msi": str((directory / ("boundary-" + label + ".msi")).resolve()),
            }
        )
    receipt = {
        "schemaVersion": 1,
        "classification": "msi-boundary-fixtures",
        "completeRuntime": False,
        "installedAcceptance": False,
        "helperSha256": helper_hash,
        "fixtures": fixtures,
    }
    (output / "fixtures.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--node-license", type=Path, required=True)
    parser.add_argument("--node-version", required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    args = parser.parse_args()
    prepare(
        args.output,
        args.node,
        args.node_license,
        args.node_version,
        args.helper,
        args.source_revision,
    )
