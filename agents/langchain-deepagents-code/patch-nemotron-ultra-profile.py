# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Backport the Nemotron 3 Ultra harness profile into the pinned Deep Agents.

The vendored module is byte-for-byte source from langchain-ai/deepagents PR
#4192 at head 72fd0bba115df5ae35a549f58d3dd564f0bf0592, merged as
d5a60ece7379c37c81edcef2cd6c2811ddc90c9a. NemoClaw keeps the upstream file
unchanged and adds only the two managed OpenAI-compatible aliases here.

Remove the source overlay and bootstrap registration when Deep Agents Code pins
a Deep Agents release containing that merge. Keep the alias bridge until the
managed ChatOpenAI resolution checks pass without it.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import os
from pathlib import Path

EXPECTED_DCODE_VERSION = "0.1.30"
EXPECTED_DEEPAGENTS_VERSION = "0.7.0a3"
EXPECTED_SOURCE_SHA256 = (
    "c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7"
)
EXPECTED_BOOTSTRAP_SHA256 = (
    "afe22b56d4d2e9fa6bc804bb4af27f5d47b6cb82d345afecebab74933214f389"
)
EXPECTED_PATCHED_BOOTSTRAP_SHA256 = (
    "e8da631665bc1a1cb461dc2aab435bf60dc8c297af3832af0923c4c4215bddae"
)

SOURCE_PATH = Path(__file__).with_name("nemotron-ultra-harness-profile.py")
PATCH_MARKER = "# NemoClaw Nemotron 3 Ultra profile bridge (deepagents PR #4192)."
CANONICAL_PROFILE_KEY = "nvidia:nvidia/nemotron-3-ultra-550b-a55b"
MANAGED_PROFILE_KEYS = (
    "openai:nvidia/nemotron-3-ultra-550b-a55b",
    "openai:nvidia/nvidia/nemotron-3-ultra",
)

HARNESS_IMPORT_ANCHOR = "    _openai_codex,\n"
HARNESS_IMPORT_PATCH = "    _nvidia_nemotron_3_ultra,\n    _openai_codex,\n"
REGISTRY_IMPORT_ANCHOR = (
    "from deepagents.profiles.harness.harness_profiles import _HARNESS_PROFILES\n"
)
REGISTRY_IMPORT_PATCH = (
    "from deepagents.profiles.harness.harness_profiles import (\n"
    "    _HARNESS_PROFILES,\n"
    "    _register_harness_profile_impl,\n"
    ")\n"
)
REGISTER_ANCHOR = "        _openai_codex.register()\n"
REGISTER_PATCH = f'''        {PATCH_MARKER}\n        _nvidia_nemotron_3_ultra.register()\n        _nemotron_ultra_profile = _HARNESS_PROFILES[\n            "{CANONICAL_PROFILE_KEY}"\n        ]\n        _register_harness_profile_impl(\n            "{MANAGED_PROFILE_KEYS[0]}", _nemotron_ultra_profile\n        )\n        _register_harness_profile_impl(\n            "{MANAGED_PROFILE_KEYS[1]}", _nemotron_ultra_profile\n        )\n        _openai_codex.register()\n'''


def fail(message: str) -> SystemExit:
    """Build a consistent fail-closed error."""
    return SystemExit(f"ERROR: {message}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require_version(distribution: str, expected: str) -> None:
    try:
        actual = importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError as exc:
        raise fail(f"required distribution {distribution!r} is not installed") from exc
    if actual != expected:
        raise fail(f"expected {distribution}=={expected}, found {actual}")


def deepagents_root() -> Path:
    spec = importlib.util.find_spec("deepagents")
    if spec is None or spec.submodule_search_locations is None:
        raise fail("could not locate the installed deepagents package")
    roots = tuple(Path(entry) for entry in spec.submodule_search_locations)
    if len(roots) != 1:
        raise fail(f"expected one deepagents package root, found {len(roots)}")
    root = roots[0]
    if root.is_symlink() or not root.is_dir():
        raise fail(f"deepagents package root is not a trusted directory: {root}")
    return root


def require_regular_file(path: Path, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise fail(f"{label} is not a trusted regular file: {path}")
    return path.read_bytes()


def patched_bootstrap(original: bytes) -> bytes:
    if sha256(original) != EXPECTED_BOOTSTRAP_SHA256:
        raise fail(
            "deepagents built-in profile bootstrap does not match the reviewed 0.7.0a3 source"
        )
    text = original.decode("utf-8")
    for label, anchor in (
        ("harness import", HARNESS_IMPORT_ANCHOR),
        ("harness registry import", REGISTRY_IMPORT_ANCHOR),
        ("harness registration", REGISTER_ANCHOR),
    ):
        if text.count(anchor) != 1:
            raise fail(f"expected exactly one {label} anchor")
    text = text.replace(HARNESS_IMPORT_ANCHOR, HARNESS_IMPORT_PATCH)
    text = text.replace(REGISTRY_IMPORT_ANCHOR, REGISTRY_IMPORT_PATCH)
    text = text.replace(REGISTER_ANCHOR, REGISTER_PATCH)
    compile(text, "deepagents/profiles/_builtin_profiles.py", "exec")
    return text.encode("utf-8")


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    temporary = path.with_name(f".{path.name}.nemoclaw-tmp")
    if temporary.exists() or temporary.is_symlink():
        raise fail(f"temporary patch path already exists: {temporary}")
    try:
        temporary.write_bytes(data)
        os.chmod(temporary, mode)
        temporary.replace(path)
    finally:
        if temporary.exists() and not temporary.is_symlink():
            temporary.unlink()


def main() -> None:
    require_version("deepagents-code", EXPECTED_DCODE_VERSION)
    require_version("deepagents", EXPECTED_DEEPAGENTS_VERSION)

    source = require_regular_file(SOURCE_PATH, "vendored Nemotron profile source")
    if sha256(source) != EXPECTED_SOURCE_SHA256:
        raise fail(
            "vendored Nemotron profile source hash does not match upstream PR #4192"
        )
    compile(source, str(SOURCE_PATH), "exec")

    package_root = deepagents_root()
    bootstrap_path = package_root / "profiles" / "_builtin_profiles.py"
    harness_dir = package_root / "profiles" / "harness"
    target_path = harness_dir / "_nvidia_nemotron_3_ultra.py"
    if harness_dir.is_symlink() or not harness_dir.is_dir():
        raise fail(f"deepagents harness directory is not trusted: {harness_dir}")

    bootstrap = require_regular_file(
        bootstrap_path, "deepagents built-in profile bootstrap"
    )
    bootstrap_hash = sha256(bootstrap)
    target_exists = target_path.exists() or target_path.is_symlink()

    if bootstrap_hash == EXPECTED_BOOTSTRAP_SHA256 and not target_exists:
        updated_bootstrap = patched_bootstrap(bootstrap)
        if sha256(updated_bootstrap) != EXPECTED_PATCHED_BOOTSTRAP_SHA256:
            raise fail("internal patched-bootstrap digest is inconsistent")
        atomic_write(target_path, source, 0o444)
        atomic_write(bootstrap_path, updated_bootstrap, 0o444)
        print("Patched deepagents 0.7.0a3 with the Nemotron 3 Ultra harness profile.")
        return

    if bootstrap_hash == EXPECTED_PATCHED_BOOTSTRAP_SHA256 and target_exists:
        installed_source = require_regular_file(
            target_path, "installed Nemotron profile source"
        )
        if sha256(installed_source) != EXPECTED_SOURCE_SHA256:
            raise fail(
                "installed Nemotron profile source conflicts with the reviewed backport"
            )
        print("Nemotron 3 Ultra harness profile patch is already applied.")
        return

    raise fail("partial, conflicting, or drifted Nemotron profile patch state")


if __name__ == "__main__":
    main()
