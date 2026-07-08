# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Register the native Nemotron 3 Ultra profile for NemoClaw model aliases.

Deep Agents 0.7.0a6 ships the profile from langchain-ai/deepagents PR #4192.
NemoClaw patches only the built-in bootstrap so its two managed OpenAI-compatible
model identities resolve that official profile too.

Remove this alias bridge when Deep Agents natively recognizes the managed
OpenAI-compatible aliases.
"""

# invalidState: the released native profile recognizes NVIDIA and hosted-provider
# identities, but NemoClaw's managed ChatOpenAI identities use openai: keys.
# sourceBoundary: Deep Agents owns the native profile and bootstrap; NemoClaw owns
# only the two openai: aliases required by its inference.local route.
# whyNotSourceFix: the aliases describe NemoClaw's managed model identity and the
# released SDK has no supported configuration hook for bootstrap-time aliases.
# regressionTest: exact wheel source/bootstrap hashes, failure-state tests,
# build-time graph/dispatch validation, and the typed DCode E2E target cover it.
# removalCondition: both managed ChatOpenAI aliases resolve the native Ultra
# profile without this patch; any DCode, Deep Agents, or source drift fails build.

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import os
from pathlib import Path
from stat import S_IMODE

EXPECTED_DCODE_VERSION = "0.1.34"
EXPECTED_DEEPAGENTS_VERSION = "0.7.0a6"
EXPECTED_NATIVE_PROFILE_SHA256 = (
    "c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7"
)
EXPECTED_BOOTSTRAP_SHA256 = (
    "005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf"
)
EXPECTED_PATCHED_BOOTSTRAP_SHA256 = (
    "9d9e817143b330fd45345fcfa8276ea6fe5d6bc5a396f0438b0899a450e4744b"
)

PATCH_MARKER = "# NemoClaw managed OpenAI-compatible Nemotron 3 Ultra aliases."
CANONICAL_PROFILE_KEY = "nvidia:nvidia/nemotron-3-ultra-550b-a55b"
MANAGED_PROFILE_KEYS = (
    "openai:nvidia/nemotron-3-ultra-550b-a55b",
    "openai:nvidia/nvidia/nemotron-3-ultra",
)

REGISTRY_IMPORT_ANCHOR = (
    "from deepagents.profiles.harness.harness_profiles import _HARNESS_PROFILES\n"
)
REGISTRY_IMPORT_PATCH = (
    "from deepagents.profiles.harness.harness_profiles import (\n"
    "    _HARNESS_PROFILES,\n"
    "    _register_harness_profile_impl,\n"
    ")\n"
)
REGISTER_ANCHOR = "        _nvidia_nemotron_3_ultra.register()\n"
REGISTER_PATCH = f'''        _nvidia_nemotron_3_ultra.register()\n        {PATCH_MARKER}\n        _nemotron_ultra_profile = _HARNESS_PROFILES[\n            "{CANONICAL_PROFILE_KEY}"\n        ]\n        _register_harness_profile_impl(\n            "{MANAGED_PROFILE_KEYS[0]}", _nemotron_ultra_profile\n        )\n        _register_harness_profile_impl(\n            "{MANAGED_PROFILE_KEYS[1]}", _nemotron_ultra_profile\n        )\n'''


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
        raise fail(
            f"expected {distribution}=={expected}, found {actual}; dependency drift "
            "requires reviewing whether upstream now recognizes both managed aliases "
            "and removing this bridge when it does"
        )


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
            "deepagents built-in profile bootstrap does not match the reviewed 0.7.0a6 source"
        )
    text = original.decode("utf-8")
    for label, anchor in (
        ("harness registry import", REGISTRY_IMPORT_ANCHOR),
        ("harness registration", REGISTER_ANCHOR),
    ):
        if text.count(anchor) != 1:
            raise fail(f"expected exactly one {label} anchor")
    text = text.replace(REGISTRY_IMPORT_ANCHOR, REGISTRY_IMPORT_PATCH)
    text = text.replace(REGISTER_ANCHOR, REGISTER_PATCH)
    compile(text, "deepagents/profiles/_builtin_profiles.py", "exec")
    return text.encode("utf-8")


def atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.nemoclaw-tmp")
    if temporary.exists() or temporary.is_symlink():
        raise fail(f"temporary patch path already exists: {temporary}")
    try:
        previous_umask = os.umask(0o022)
        try:
            temporary.write_bytes(data)
        finally:
            os.umask(previous_umask)
        if S_IMODE(temporary.stat().st_mode) != 0o644:
            raise fail(f"unexpected temporary patch mode: {temporary}")
        temporary.replace(path)
    finally:
        if temporary.exists() and not temporary.is_symlink():
            temporary.unlink()


def main() -> None:
    require_version("deepagents-code", EXPECTED_DCODE_VERSION)
    require_version("deepagents", EXPECTED_DEEPAGENTS_VERSION)

    package_root = deepagents_root()
    bootstrap_path = package_root / "profiles" / "_builtin_profiles.py"
    native_profile_path = (
        package_root / "profiles" / "harness" / "_nvidia_nemotron_3_ultra.py"
    )
    native_profile = require_regular_file(
        native_profile_path, "native Nemotron profile source"
    )
    if sha256(native_profile) != EXPECTED_NATIVE_PROFILE_SHA256:
        raise fail("native Nemotron profile source does not match Deep Agents 0.7.0a6")
    compile(native_profile, str(native_profile_path), "exec")

    bootstrap = require_regular_file(
        bootstrap_path, "deepagents built-in profile bootstrap"
    )
    bootstrap_hash = sha256(bootstrap)

    if bootstrap_hash == EXPECTED_BOOTSTRAP_SHA256:
        updated_bootstrap = patched_bootstrap(bootstrap)
        if sha256(updated_bootstrap) != EXPECTED_PATCHED_BOOTSTRAP_SHA256:
            raise fail("internal patched-bootstrap digest is inconsistent")
        atomic_write(bootstrap_path, updated_bootstrap)
        print("Registered the native Nemotron 3 Ultra profile for managed aliases.")
        return

    if bootstrap_hash == EXPECTED_PATCHED_BOOTSTRAP_SHA256:
        print("Nemotron 3 Ultra managed-alias bridge is already applied.")
        return

    raise fail("partial, conflicting, or drifted Nemotron profile alias patch state")


if __name__ == "__main__":
    main()
