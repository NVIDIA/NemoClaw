# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Bind same-job Windows proof to the exact prebuilt Burn prerequisite helper."""

import argparse
import hashlib
import json
import ntpath
import re
import stat
import struct
from pathlib import Path


PROFILE = {
    "leastPrivilege": False,
    "capabilities": ["privateNetworkClientServer", "internetClient"],
    "win32kDisabled": False,
    "networkDefaultPolicy": "allow",
    "allowLocalNetwork": True,
    "childTimeoutMilliseconds": 30000,
}
READ_MASK = 0x001200A9
ACL_MASKS = {
    "S-1-5-11": READ_MASK,
    "S-1-5-18": 0x001F01FF,
    "S-1-5-32-544": 0x001F01FF,
    "S-1-15-2-1": READ_MASK,
    "S-1-15-2-2": READ_MASK,
}
IMAGE_ACL = (
    "system-and-administrators-full-authenticated-users-and-appcontainer-"
    "packages-read-execute; administrators-owned"
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_file(path, limit):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        info = part.lstat()
        require(
            not stat.S_ISLNK(info.st_mode)
            and not getattr(info, "st_file_attributes", 0) & 0x400,
            "Proof inputs cannot traverse a link or reparse point.",
        )
    info = path.stat()
    require(
        stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit,
        "Invalid proof input size/type.",
    )
    data = path.read_bytes()
    require(len(data) == info.st_size, "Proof input changed during read.")
    return data


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    data = read_file(path, 1024 * 1024)
    result = json.loads(data)
    require(type(result) is dict, "Proof input must be an object.")
    return result, sha(data)


def compare_node_acl(before, after, before_attributes, after_attributes):
    """Only exact text or the observed one-way regular-file D: -> D:AI change."""
    regular = all(
        type(value) is int and value >= 0 and value & 0x410 == 0
        for value in (before_attributes, after_attributes)
    )
    text = type(before) is str and type(after) is str and bool(before)
    exact = regular and text and before == after
    added = False
    if (
        regular
        and text
        and not exact
        and re.fullmatch(r"O:[^:()]+G:[^:()]+D:(?:\([^()]+\))+", before)
    ):
        offset = before.index("D:(") + 2
        added = after == before[:offset] + "AI" + before[offset:]
    return {
        "restored": exact or added,
        "exactRestored": exact,
        "metadataChange": "dacl-auto-inherited-added" if added else None,
    }


def verify_acl_rows(rows, *, detailed):
    expected_keys = {"sid", "mask", "inherited", "accessControlType"}
    if detailed:
        expected_keys |= {"inheritanceFlags", "propagationFlags"}
    require(
        type(rows) is list
        and len(rows) == len(ACL_MASKS)
        and all(
            type(row) is dict
            and set(row) == expected_keys
            and row.get("sid") in ACL_MASKS
            and type(row.get("mask")) is int
            and row["mask"] == ACL_MASKS[row["sid"]]
            and row.get("inherited") is False
            and row.get("accessControlType") == "Allow"
            and (
                not detailed
                or (
                    row.get("inheritanceFlags") == "ContainerInherit, ObjectInherit"
                    and row.get("propagationFlags") == "None"
                )
            )
            for row in rows
        )
        and {row["sid"] for row in rows} == set(ACL_MASKS),
        "The preauthorized runtime ACL differs from the exact package read grants.",
    )


def verify_preauthorized_runtime(record):
    require(
        type(record) is dict
        and set(record)
        == {
            "imageReceipt",
            "mountPointSddl",
            "mountPointAccess",
            "volumeRootSddl",
            "volumeRootAccess",
            "workersSddl",
            "workersAccess",
            "readMask",
            "readOnlyAttachment",
        }
        and type(record.get("workersSddl")) is str
        and bool(record["workersSddl"])
        and type(record.get("mountPointSddl")) is str
        and bool(record["mountPointSddl"])
        and type(record.get("volumeRootSddl")) is str
        and bool(record["volumeRootSddl"])
        and record.get("readMask") == READ_MASK
        and record.get("readOnlyAttachment") is True,
        "The preauthorized runtime proof is incomplete or not read-only.",
    )
    verify_acl_rows(record["mountPointAccess"], detailed=True)
    verify_acl_rows(record["volumeRootAccess"], detailed=True)
    verify_acl_rows(record["workersAccess"], detailed=True)
    image = record.get("imageReceipt")
    require(
        type(image) is dict
        and image.get("schemaVersion") == 1
        and image.get("classification") == "finished-runtime-application-image"
        and image.get("runtimeId") == "a" * 64
        and image.get("status") == "built-detached-and-verified"
        and image.get("format") == "vhdx"
        and image.get("filesystem") == "ntfs"
        and image.get("payloadObjects") == 1
        and type(image.get("source")) is dict
        and image["source"].get("files") == 3
        and type(image["source"].get("logicalBytes")) is int
        and image["source"]["logicalBytes"] > 0
        and image.get("customerExtractionRequired") is False
        and image.get("runtimeLaunchCopiesRequired") is False
        and image.get("mountedReadOnly") is True
        and type(image.get("population")) is dict
        and image.get("population")
        == {
            "status": image["population"].get("status"),
            "log": "preauthorized-runtime-image.robocopy.log",
        }
        and type(image["population"].get("status")) is int
        and 0 <= image["population"]["status"] < 8
        and image.get("innerFilesystemCompression")
        == "ntfs-inherited-before-population"
        and image.get("innerFilesystemAcl") == IMAGE_ACL
        and re.fullmatch(r"[a-f0-9]{64}", image.get("manifestSha256", "")),
        "The preauthorized runtime image receipt is invalid.",
    )
    image_file = image.get("image", {})
    require(
        type(image_file) is dict
        and image_file.get("file") == "preauthorized-runtime.vhdx"
        and type(image_file.get("bytes")) is int
        and image_file["bytes"] > 0
        and image_file.get("maximumMiB") == 4096
        and re.fullmatch(r"[a-f0-9]{64}", image_file.get("sha256", "")),
        "The preauthorized runtime image identity is invalid.",
    )
    roots = image.get("appContainerReadRoots")
    require(
        type(roots) is list
        and len(roots) == 2
        and all(
            type(root) is dict and set(root) == {"name", "sddl", "access"}
            for root in roots
        )
        and {root.get("name") for root in roots} == {".", "workers"}
        and next(root for root in roots if root["name"] == ".").get("sddl")
        == record["volumeRootSddl"]
        and next(root for root in roots if root["name"] == "workers").get("sddl")
        == record["workersSddl"],
        "The preauthorized runtime image root identity is invalid.",
    )
    for root in roots:
        verify_acl_rows(root["access"], detailed=False)


def verify(
    helper, build_receipt, proof_directory, source_root, source_revision, node_path
):
    require(re.fullmatch(r"[0-9a-f]{40}", source_revision), "Invalid source revision.")
    binary = read_file(helper, 16 * 1024 * 1024)
    require(len(binary) >= 64 and binary[:2] == b"MZ", "Helper is not a PE executable.")
    offset = struct.unpack_from("<I", binary, 0x3C)[0]
    require(
        64 <= offset <= len(binary) - 6
        and binary[offset : offset + 4] == b"PE\0\0"
        and struct.unpack_from("<H", binary, offset + 4)[0] == 0xAA64,
        "Helper is not Windows ARM64.",
    )
    helper_sha = sha(binary)
    build, build_sha = read_json(build_receipt)
    require(
        build.get("schemaVersion") == 1
        and build.get("classification") == "native-system-drive-preparation-build"
        and build.get("architecture") == "arm64"
        and build.get("rustToolchain") == "1.95.0-aarch64-pc-windows-msvc"
        and build.get("file") == "NemoClawHostPreparation.exe"
        and build.get("sha256") == helper_sha
        and build.get("bytes") == len(binary)
        and build.get("systemRootProofRequired") is True
        and build.get("mxcLaunchProofRequired") is True
        and build.get("admissionAllowed") is False,
        "Helper build receipt does not bind this exact executable.",
    )
    owner = Path(source_root) / "packaging/windows/host-preparation"
    expected = {
        path.name: sha(read_file(path, 1024 * 1024))
        for path in owner.iterdir()
        if path.suffix == ".rs"
        or path.name in {"Cargo.toml", "Cargo.lock", "build-helper.ps1"}
    }
    sources = build.get("sources")
    require(
        type(sources) is list and len(sources) == len(expected) and len(expected) >= 4,
        "Incomplete helper source inventory.",
    )
    require(
        all(
            type(row) is dict
            and row.get("file") in expected
            and row.get("sha256") == expected[row["file"]]
            for row in sources
        )
        and len({row.get("file") for row in sources}) == len(expected),
        "Helper build sources differ from this committed source.",
    )
    proof, proof_sha = read_json(Path(proof_directory) / "system-root-mxc-proof.json")
    policy, policy_sha = read_json(Path(proof_directory) / "policy.json")
    require(
        proof.get("schemaVersion") == 1
        and proof.get("classification") == "actual-system-root-and-mxc-proof"
        and proof.get("status") == "pass"
        and proof.get("sourceRevision") == source_revision
        and proof.get("helperSha256") == helper_sha
        and proof.get("requestProfile") == "existing-personal-node-compatibility"
        and proof.get("stdio") == "explicit-pipes-with-closed-input"
        and proof.get("policySha256") == policy_sha
        and proof.get("requestPolicy") == PROFILE
        and proof.get("admissionAllowed") is False,
        "Same-source system-root/MXC proof is missing or differs from the executed helper/profile.",
    )
    require(
        policy.get("version") == "0.6.0-alpha"
        and policy.get("containment") == "processcontainer"
        and policy.get("processContainer")
        == {"leastPrivilege": False, "capabilities": PROFILE["capabilities"]}
        and policy.get("ui") == {"disable": False}
        and policy.get("network")
        == {
            "defaultPolicy": "allow",
            "allowedHosts": [],
            "blockedHosts": [],
            "allowLocalNetwork": True,
        }
        and policy.get("process", {}).get("timeout") == 30000,
        "The hashed actual request differs from the existing Personal compatibility profile.",
    )
    filesystem = policy.get("filesystem", {})
    cwd = policy.get("process", {}).get("cwd", "")
    drive = proof.get("systemDriveRoot", "")
    readonly = filesystem.get("readonlyPaths", [])
    preauthorized_path = ntpath.join(
        ntpath.normpath(str(Path(proof_directory).absolute())),
        "preauthorized-runtime-mount",
        "workers",
    )
    require(
        type(filesystem) is dict
        and set(filesystem) == {"readonlyPaths", "readwritePaths"}
        and type(readonly) is list
        and len(readonly) == 2
        and type(readonly[0]) is str
        and type(readonly[1]) is str
        and re.fullmatch(r"[A-Za-z]:\\[^\r\n]+", str(node_path))
        and ntpath.basename(str(node_path)).lower() == "node.exe"
        and ntpath.normcase(readonly[0]) == ntpath.normcase(str(node_path))
        and ntpath.normcase(readonly[1]) == ntpath.normcase(preauthorized_path)
        and re.fullmatch(re.escape(drive) + r"NemoClawHostPrepProof-[a-f0-9]{12}", cwd)
        and re.fullmatch(r"[A-Za-z]:\\", drive)
        and filesystem.get("readwritePaths") == [cwd],
        "The actual filesystem grants differ from Node, the preauthorized image "
        "root, and the owned proof workspace.",
    )
    verify_preauthorized_runtime(proof.get("preauthorizedRuntime"))
    first, repeat = proof.get("first", {}), proof.get("repeat", {})
    for record in (first, repeat):
        require(
            record.get("schemaVersion") == 1
            and record.get("classification") == "nemoclaw-system-drive-metadata"
            and record.get("verified") is True
            and record.get("saclWriteRequested") is False
            and record.get("customerPathRegistryChanged") is False
            and record.get("systemDriveRoot") == proof.get("systemDriveRoot")
            and re.fullmatch(r"[A-Za-z]:\\", record.get("systemDriveRoot", "")),
            "System-root helper verification is incomplete.",
        )
    descriptor = first.get("afterDescriptorHex", "")
    require(
        first.get("writeCalls") == 1
        and type(first.get("addedAces")) is int
        and 1 <= first["addedAces"] <= 2
        and re.fullmatch(r"(?:[a-f0-9]{2})+", descriptor)
        and repeat.get("writeCalls") == 0
        and repeat.get("addedAces") == 0
        and repeat.get("beforeDescriptorHex") == descriptor
        and repeat.get("afterDescriptorHex") == descriptor,
        "First preparation and exact zero-write repeat were not proved.",
    )
    guest = proof.get("guest", {})
    require(
        guest.get("marker") == "NEMOCLAW_SYSTEM_METADATA_MXC_OK"
        and guest.get("platform") == "win32"
        and guest.get("architecture") == "arm64"
        and guest.get("node") == "22.23.2"
        and all(
            guest.get(field) is True
            for field in ("allowedRead", "preauthorizedRead", "deniedRead", "ownedWrite")
        ),
        "Actual contained Node and preauthorized-image read/deny/write controls did not pass.",
    )
    node_comparison = compare_node_acl(
        proof.get("nodeSddlBefore"),
        proof.get("nodeSddlAfter"),
        proof.get("nodeFileAttributesBefore"),
        proof.get("nodeFileAttributesAfter"),
    )
    require(
        proof.get("nodeAclRestored") is True
        and proof.get("nodeFileKind") == "regular-file"
        and node_comparison["restored"]
        and proof.get("nodeAclComparison") == node_comparison
        and bool(proof.get("rootSddlAfterPreparation"))
        and proof.get("rootSddlAfterPreparation") == proof.get("rootSddlAfterMxc")
        and proof.get("mxcStopped") is True
        and proof.get("workspaceRemoved") is True
        and proof.get("cleanupErrors") == [],
        "System-root/MXC proof did not preserve ACLs and finish owned cleanup.",
    )
    commands = proof.get("commands", [])
    labels = (
        "metadata-first",
        "metadata-repeat",
        "upstream-null-device",
        "mxc-execution",
        "owned-profile-delete",
    )
    require(
        type(commands) is list
        and [row.get("label") for row in commands] == list(labels),
        "Incomplete proof command sequence.",
    )
    require(
        all(
            row.get("exitCode") == 0 and row.get("stopped") is True for row in commands
        ),
        "A proof command did not finish successfully.",
    )
    return {
        "schemaVersion": 1,
        "classification": "same-job-system-drive-helper-build-gate",
        "sourceRevision": source_revision,
        "helperSha256": helper_sha,
        "buildReceiptSha256": build_sha,
        "proofSha256": proof_sha,
        "policySha256": policy_sha,
        "proofProducerSha256": sha(
            read_file(owner / "test-system-root-mxc.ps1", 1024 * 1024)
        ),
        "requestProfile": proof["requestProfile"],
        "nodeAclComparison": node_comparison,
        "proofCommands": [
            {key: row[key] for key in ("label", "exitCode", "elapsedMilliseconds")}
            for row in commands
        ],
        "systemDriveMetadataPreparation": True,
        "preauthorizedRuntimeReadOnly": True,
        "sameJobHostAlreadyPrepared": True,
        "installedAcceptance": False,
        "publicationApproved": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "helper",
        "build-receipt",
        "proof-directory",
        "source-root",
        "source-revision",
        "node-path",
        "output",
    ):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    result = verify(
        args.helper,
        args.build_receipt,
        args.proof_directory,
        args.source_root,
        args.source_revision,
        args.node_path,
    )
    with Path(args.output).open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
