# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Register released Deep Agents profiles for NemoClaw-managed model keys."""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
from collections.abc import Callable, MutableMapping
from pathlib import Path
from typing import Any

EXPECTED_DCODE_VERSION = "0.1.34"
EXPECTED_DEEPAGENTS_VERSION = "0.7.0a6"
EXPECTED_NATIVE_PROFILE_SHA256 = (
    "c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7"
)
EXPECTED_BOOTSTRAP_SHA256 = (
    "005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf"
)

CANONICAL_PROFILE_KEY = "nvidia:nvidia/nemotron-3-ultra-550b-a55b"
MANAGED_PROFILE_KEYS = (
    "openai:nvidia/nemotron-3-ultra-550b-a55b",
    "openai:nvidia/nvidia/nemotron-3-ultra",
)

# invalidState: Deep Agents resolves pre-built ChatOpenAI models under `openai:`
# keys, while its native Ultra profile is registered under an NVIDIA key.
# sourceBoundary: NemoClaw owns only these two managed inference aliases; the
# prompt, tool overrides, middleware, bootstrap, and canonical profile remain
# byte-identical Deep Agents artifacts.
# whyPrivateRead: Deep Agents exposes public profile registration and plugin
# hooks but no public getter/alias API. The exact version/source gates constrain
# this single registry read; all writes use the public registration function.
# regressionTest: focused fixtures cover discovery, hashes, canonical identity,
# rollback, partial/conflicting state, and idempotence; the isolated real-wheel
# validator covers middleware, graph, dispatch, and unrelated-model behavior.
# removalCondition: remove this package only if a future reviewed dependency
# already provides both exact mappings; no external contribution is required.


def _fail(message: str) -> RuntimeError:
    return RuntimeError(f"NemoClaw Deep Agents profile plugin: {message}")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _require_version(distribution: str, expected: str) -> None:
    try:
        actual = importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError as exc:
        raise _fail(f"required distribution {distribution!r} is not installed") from exc
    if actual != expected:
        raise _fail(
            f"expected {distribution}=={expected}, found {actual}; dependency drift "
            "requires revalidating the managed profile adapter"
        )


def _deepagents_root() -> Path:
    _require_version("deepagents", EXPECTED_DEEPAGENTS_VERSION)
    try:
        distribution = importlib.metadata.distribution("deepagents")
    except importlib.metadata.PackageNotFoundError as exc:
        raise _fail("required distribution 'deepagents' is not installed") from exc

    spec = importlib.util.find_spec("deepagents")
    if spec is None or spec.submodule_search_locations is None:
        raise _fail("could not locate the installed deepagents package")
    roots = tuple(Path(entry) for entry in spec.submodule_search_locations)
    if len(roots) != 1:
        raise _fail(f"expected one deepagents package root, found {len(roots)}")
    root = roots[0]
    if root.is_symlink() or not root.is_dir():
        raise _fail(f"deepagents package root is not a trusted directory: {root}")
    distribution_root = Path(distribution.locate_file("deepagents"))
    if distribution_root.is_symlink() or not distribution_root.is_dir():
        raise _fail(
            "deepagents distribution root is not a trusted directory: "
            f"{distribution_root}"
        )
    # Bind the import to its reviewed distribution so sys.path shadows fail closed.
    try:
        matches_distribution = root.samefile(distribution_root)
    except OSError as exc:
        raise _fail("could not verify the imported deepagents package root") from exc
    if not matches_distribution:
        raise _fail(
            "imported deepagents package does not match the reviewed distribution"
        )
    return root


def _require_source(path: Path, label: str, expected_sha256: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise _fail(f"{label} is not a trusted regular file: {path}")
    source = path.read_bytes()
    if _sha256(source) != expected_sha256:
        raise _fail(f"{label} does not match the reviewed Deep Agents 0.7.0a6 wheel")
    compile(source, str(path), "exec")


def _register_aliases(
    registry: MutableMapping[str, Any],
    register_profile: Callable[[str, Any], None],
) -> None:
    native_profile = registry.get(CANONICAL_PROFILE_KEY)
    if native_profile is None:
        raise _fail(f"canonical profile {CANONICAL_PROFILE_KEY!r} is not registered")

    existing = tuple(key in registry for key in MANAGED_PROFILE_KEYS)
    if all(existing):
        if all(registry[key] is native_profile for key in MANAGED_PROFILE_KEYS):
            return
        raise _fail("managed aliases conflict with the reviewed canonical profile")
    if any(existing):
        raise _fail("managed aliases are in a partial registration state")

    try:
        for key in MANAGED_PROFILE_KEYS:
            register_profile(key, native_profile)
        if not all(registry.get(key) is native_profile for key in MANAGED_PROFILE_KEYS):
            raise _fail(
                "managed alias registration did not preserve canonical identity"
            )
    except Exception:
        for key in MANAGED_PROFILE_KEYS:
            registry.pop(key, None)
        raise


def register() -> None:
    """Register NemoClaw model aliases through Deep Agents' plugin hook."""
    _require_version("deepagents-code", EXPECTED_DCODE_VERSION)

    package_root = _deepagents_root()
    _require_source(
        package_root / "profiles" / "harness" / "_nvidia_nemotron_3_ultra.py",
        "native Nemotron profile source",
        EXPECTED_NATIVE_PROFILE_SHA256,
    )
    _require_source(
        package_root / "profiles" / "_builtin_profiles.py",
        "built-in profile bootstrap",
        EXPECTED_BOOTSTRAP_SHA256,
    )

    from deepagents.profiles import register_harness_profile  # noqa: PLC0415
    from deepagents.profiles.harness.harness_profiles import (  # noqa: PLC0415
        _HARNESS_PROFILES,
    )

    _register_aliases(_HARNESS_PROFILES, register_harness_profile)


__all__ = ["register"]
