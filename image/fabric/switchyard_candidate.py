# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate the dormant Hermes, Relay, and Switchyard release candidate."""

import argparse
import hashlib
import json
import tarfile
import tomllib
from pathlib import Path, PurePosixPath

ARCHIVE_FILES = {
    "ATTRIBUTIONS-Rust.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "config.schema.json",
    "libswitchyard_nemo_relay_plugin.so",
    "notices/protocol/LICENSE",
    "notices/protocol/NOTICE",
    "notices/switchyard-translation/LICENSE",
    "notices/switchyard-translation/NOTICE",
    "relay-plugin.toml",
}
ARCHIVE_DIRECTORIES = {
    "switchyard-plugin",
    "switchyard-plugin/notices",
    "switchyard-plugin/notices/protocol",
    "switchyard-plugin/notices/switchyard-translation",
}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def require_keys(value: dict, expected: set[str], subject: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{subject} has unsupported fields")


def version_tuple(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise ValueError("candidate versions must use three numeric components")
    return tuple(int(part) for part in parts)


def relay_is_compatible(version: str, requirement: str) -> bool:
    clauses = [part.strip() for part in requirement.split(",")]
    if len(clauses) != 2 or not clauses[0].startswith(">=") or not clauses[1].startswith("<"):
        raise ValueError("plugin Relay compatibility range is unsupported")
    selected = version_tuple(version)
    return version_tuple(clauses[0][2:]) <= selected < version_tuple(clauses[1][1:])


def archive_members(archive: tarfile.TarFile) -> dict[str, tarfile.TarInfo]:
    members = {}
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError("plugin archive contains an unsafe path")
        if not member.isfile() and not member.isdir():
            raise ValueError("plugin archive contains a link or special file")
        if member.isdir():
            if str(path) not in ARCHIVE_DIRECTORIES:
                raise ValueError("plugin archive contains an unexpected directory")
        else:
            if len(path.parts) < 2 or path.parts[0] != "switchyard-plugin":
                raise ValueError("plugin archive has an unexpected root")
            relative = str(PurePosixPath(*path.parts[1:]))
            if relative in members:
                raise ValueError("plugin archive contains duplicate files")
            members[relative] = member
    if set(members) != ARCHIVE_FILES:
        raise ValueError("plugin archive layout does not match the released contract")
    return members


def member_bytes(archive: tarfile.TarFile, members: dict[str, tarfile.TarInfo], name: str) -> bytes:
    source = archive.extractfile(members[name])
    if source is None:
        raise ValueError(f"plugin archive cannot read {name}")
    return source.read()


def validate_hermes(lock: dict, project_path: Path, resolved_path: Path) -> None:
    expected = {
        "version",
        "tag",
        "tag_object",
        "tag_verified",
        "commit",
        "pyproject_sha256",
        "uv_lock_sha256",
        "relay_requirement",
        "relay_python_minimum",
        "relay_version",
        "relay_wheels",
    }
    require_keys(lock, expected, "Hermes candidate")
    require_keys(lock["relay_wheels"], {"linux/arm64", "linux/amd64"}, "Relay wheels")
    if digest(project_path) != lock["pyproject_sha256"]:
        raise ValueError("Hermes project digest does not match the candidate")
    if digest(resolved_path) != lock["uv_lock_sha256"]:
        raise ValueError("Hermes lock digest does not match the candidate")
    project = tomllib.loads(project_path.read_text(encoding="utf-8"))
    resolved = tomllib.loads(resolved_path.read_text(encoding="utf-8"))
    relay_dependencies = [
        item for item in project["project"]["dependencies"] if item.startswith("nemo-relay")
    ]
    if len(relay_dependencies) != 1:
        raise ValueError("Hermes must declare exactly one Relay dependency")
    dependency = relay_dependencies[0]
    requirement, separator, marker_value = dependency.partition(";")
    if requirement != f"nemo-relay{lock['relay_requirement']}" or not separator:
        raise ValueError("Hermes Relay requirement differs from the candidate")
    marker = f"python_version >= '{lock['relay_python_minimum']}'"
    if marker not in marker_value:
        raise ValueError("Hermes Relay Python marker differs from the candidate")
    packages = [item for item in resolved["package"] if item["name"] == "nemo-relay"]
    if len(packages) != 1 or packages[0]["version"] != lock["relay_version"]:
        raise ValueError("Hermes does not lock the candidate Relay version")
    wheels = packages[0]["wheels"]
    markers = {"linux/arm64": "aarch64", "linux/amd64": "x86_64"}
    for platform, expected_hash in lock["relay_wheels"].items():
        matches = [
            item
            for item in wheels
            if item["hash"] == f"sha256:{expected_hash}" and markers[platform] in item["url"]
        ]
        if len(matches) != 1:
            raise ValueError(f"Hermes lock is missing the {platform} candidate Relay wheel")


def validate_manifest(manifest: dict, lock: dict, library_sha256: str) -> None:
    require_keys(
        manifest,
        {
            "manifest_version",
            "plugin",
            "compat",
            "defaults",
            "capabilities",
            "config_schema",
            "source",
            "integrity",
            "load",
        },
        "plugin manifest",
    )
    expected = {
        "manifest_version": 1,
        "plugin": {"id": lock["id"], "kind": "rust_dynamic"},
        "compat": {"relay": lock["relay_compatibility"], "native_api": lock["native_api"]},
        "defaults": {"enabled": False},
        "capabilities": {"items": ["plugin_native", "config_schema"]},
        "config_schema": {"path": "config.schema.json"},
        "source": {"artifact": "libswitchyard_nemo_relay_plugin.so"},
        "integrity": {"sha256": f"sha256:{library_sha256}"},
        "load": {
            "library": "libswitchyard_nemo_relay_plugin.so",
            "symbol": "nemo_relay_register_plugin",
        },
    }
    if manifest != expected:
        raise ValueError("plugin manifest differs from the candidate contract")


def validate_bundle(lock: dict, platform: str, archive_path: Path) -> str:
    platform_lock = lock["platforms"][platform]
    require_keys(
        platform_lock,
        {
            "metadata_platform",
            "archive",
            "archive_sha256",
            "metadata",
            "metadata_sha256",
            "library_sha256",
            "relay_binary_sha256",
            "build_job",
            "build_image",
            "rust_target",
            "tool_versions",
        },
        f"{platform} candidate",
    )
    if archive_path.name != platform_lock["archive"]:
        raise ValueError(f"{platform} archive name differs from the candidate")
    if platform_lock["metadata"] != f"{platform_lock['archive']}.json":
        raise ValueError(f"{platform} metadata name differs from the released contract")
    if type(platform_lock["build_job"]) is not int or platform_lock["build_job"] <= 0:
        raise ValueError(f"{platform} build job is invalid")
    if digest(archive_path) != platform_lock["archive_sha256"]:
        raise ValueError(f"{platform} archive digest differs from the candidate")
    metadata_path = archive_path.with_name(platform_lock["metadata"])
    if digest(metadata_path) != platform_lock["metadata_sha256"]:
        raise ValueError(f"{platform} metadata digest differs from the candidate")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    expected_metadata = {
        "name": "switchyard-plugin",
        "version": lock["version"],
        "platform": platform_lock["metadata_platform"],
        "repository_commit": lock["producer_commit"],
        "repository_dirty": False,
        "source_commit": lock["source_commit"],
        "relay": {
            "sha": lock["relay_commit"],
            "tag": lock["relay_version"],
            "binary_sha256": platform_lock["relay_binary_sha256"],
            "version_output": f"nemo-relay {lock['relay_version']}",
        },
        "local_host_override": False,
        "toolchains": {"python": "3.11", "rust": "1.96.1"},
        "build_image": platform_lock["build_image"],
        "rust_target": platform_lock["rust_target"],
        "dynamic_musl_host": False,
        "tool_versions": platform_lock["tool_versions"],
        "sha256": platform_lock["archive_sha256"],
        "verified": True,
    }
    if metadata != expected_metadata:
        raise ValueError(f"{platform} producer metadata differs from the candidate")
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive_members(archive)
        library = member_bytes(archive, members, "libswitchyard_nemo_relay_plugin.so")
        library_sha256 = hashlib.sha256(library).hexdigest()
        if library_sha256 != platform_lock["library_sha256"]:
            raise ValueError(f"{platform} library digest differs from the candidate")
        manifest = tomllib.loads(member_bytes(archive, members, "relay-plugin.toml").decode())
        validate_manifest(manifest, lock, library_sha256)
        schema = member_bytes(archive, members, "config.schema.json")
        if hashlib.sha256(schema).hexdigest() != lock["config_schema_sha256"]:
            raise ValueError(f"{platform} schema digest differs from the candidate")
        parsed_schema = json.loads(schema)
        if parsed_schema.get("additionalProperties") is not False or parsed_schema.get("oneOf") != [
            {"required": ["switchyard_config_path"]},
            {"required": ["switchyard_config"]},
        ]:
            raise ValueError("plugin schema does not require one Switchyard deployment source")
    return hashlib.sha256(schema).hexdigest()


def validate_candidate(
    lock_path: Path,
    hermes_project: Path,
    hermes_lock: Path,
    bundles: dict[str, Path],
) -> dict:
    candidate = json.loads(lock_path.read_text(encoding="utf-8"))
    require_keys(
        candidate,
        {"schema_version", "selection", "activation_enabled", "hermes", "relay", "plugin"},
        "candidate",
    )
    if (
        candidate["schema_version"] != 1
        or candidate["selection"] != "candidate-only"
        or candidate["activation_enabled"] is not False
    ):
        raise ValueError("Switchyard candidate must remain unselected and inactive")
    validate_hermes(candidate["hermes"], hermes_project, hermes_lock)
    relay = candidate["relay"]
    require_keys(
        relay,
        {"version", "tag", "tag_object", "tag_verified", "commit"},
        "Relay candidate",
    )
    if relay["tag_verified"] is not True:
        raise ValueError("Relay candidate requires a verified release tag")
    if relay["version"] != candidate["hermes"]["relay_version"]:
        raise ValueError("Hermes and Relay candidate versions differ")
    plugin = candidate["plugin"]
    require_keys(
        plugin,
        {
            "id",
            "version",
            "release_tag",
            "producer_repository",
            "producer_commit",
            "producer_commit_verified",
            "producer_workflow_run",
            "producer_workflow_attempt",
            "producer_workflow_conclusion",
            "source_repository",
            "source_commit",
            "relay_compatibility",
            "native_api",
            "config_schema_sha256",
            "platforms",
        },
        "plugin candidate",
    )
    if set(plugin["platforms"]) != {"linux/arm64", "linux/amd64"}:
        raise ValueError("Switchyard candidate requires both supported Linux platforms")
    if not relay_is_compatible(relay["version"], plugin["relay_compatibility"]):
        raise ValueError("plugin is incompatible with the candidate Relay version")
    if (
        plugin["producer_commit_verified"] is not True
        or plugin["producer_workflow_conclusion"] != "success"
        or type(plugin["producer_workflow_run"]) is not int
        or plugin["producer_workflow_run"] <= 0
        or type(plugin["producer_workflow_attempt"]) is not int
        or plugin["producer_workflow_attempt"] <= 0
    ):
        raise ValueError("plugin producer workflow identity is invalid")
    plugin_context = {
        **plugin,
        "relay_version": relay["version"],
        "relay_commit": relay["commit"],
    }
    if set(bundles) != set(plugin["platforms"]):
        raise ValueError("every candidate platform must be supplied exactly once")
    schemas = {
        validate_bundle(plugin_context, platform, path) for platform, path in bundles.items()
    }
    if schemas != {plugin["config_schema_sha256"]}:
        raise ValueError("candidate platforms do not share one plugin schema")
    return {
        "schema_version": 1,
        "selection": candidate["selection"],
        "activation_enabled": candidate["activation_enabled"],
        "hermes": {
            "version": candidate["hermes"]["version"],
            "commit": candidate["hermes"]["commit"],
            "tag_verified": candidate["hermes"]["tag_verified"],
        },
        "relay": {"version": relay["version"], "commit": relay["commit"]},
        "plugin": {
            "id": plugin["id"],
            "version": plugin["version"],
            "producer_commit": plugin["producer_commit"],
            "source_commit": plugin["source_commit"],
            "platforms": sorted(bundles),
        },
    }


def parse_bundle(value: str) -> tuple[str, Path]:
    platform, separator, path = value.partition("=")
    if not separator or not platform or not path:
        raise argparse.ArgumentTypeError("bundle must be PLATFORM=ARCHIVE")
    return platform, Path(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--hermes-pyproject", type=Path, required=True)
    parser.add_argument("--hermes-lock", type=Path, required=True)
    parser.add_argument("--bundle", action="append", type=parse_bundle, required=True)
    arguments = parser.parse_args()
    bundles = dict(arguments.bundle)
    if len(bundles) != len(arguments.bundle):
        parser.error("duplicate bundle platform")
    print(
        json.dumps(
            validate_candidate(
                arguments.lock,
                arguments.hermes_pyproject,
                arguments.hermes_lock,
                bundles,
            ),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
