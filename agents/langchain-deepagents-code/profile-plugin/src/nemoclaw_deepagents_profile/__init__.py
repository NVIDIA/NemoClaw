# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Register released Deep Agents profiles for NemoClaw-managed model keys."""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import re
import threading
from collections.abc import Awaitable, Callable, MutableMapping
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
_INVALID_EXECUTE_COMMAND = re.compile(r"\[\s*content\s*\]", re.IGNORECASE)
_REGISTRATION_LOCK = threading.Lock()

# invalidState: Deep Agents resolves pre-built ChatOpenAI models under `openai:`
# keys, while its native Ultra profile is registered under an NVIDIA key.
# sourceBoundary: NemoClaw owns only these two managed inference aliases and one
# exact malformed-tool-call guard layered onto them; the prompt, tool overrides,
# bootstrap, canonical profile, and upstream source remain byte-identical Deep
# Agents artifacts.
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


def _managed_profile_overlay() -> Any:
    """Build the NemoClaw-only middleware layered onto managed Ultra aliases."""
    from deepagents.profiles.harness.harness_profiles import (  # noqa: PLC0415
        HarnessProfile,
    )
    from langchain.agents.middleware.types import AgentMiddleware  # noqa: PLC0415
    from langchain_core.messages import ToolMessage  # noqa: PLC0415

    class NemoClawExecutePlaceholderGuardMiddleware(AgentMiddleware):
        """Reject Ultra's literal execute placeholder before shell dispatch."""

        name = "NemoClawExecutePlaceholderGuardMiddleware"

        @staticmethod
        def _reject(request: Any) -> ToolMessage | None:
            tool_call = request.tool_call
            name = tool_call.get("name")
            if name != "execute":
                return None
            args = tool_call.get("args")
            command = args.get("command") if isinstance(args, dict) else None
            if not isinstance(command, str) or _INVALID_EXECUTE_COMMAND.fullmatch(
                command.strip()
            ) is None:
                return None
            return ToolMessage(
                content=(
                    "Error: execute received the placeholder '[content]' instead of "
                    "a concrete shell command. Provide the complete command and do "
                    "not retry the placeholder."
                ),
                name=name,
                tool_call_id=tool_call.get("id"),
                status="error",
            )

        def wrap_tool_call(
            self,
            request: Any,
            handler: Callable[[Any], Any],
        ) -> Any:
            """Reject the placeholder or delegate the original request unchanged."""
            rejected = self._reject(request)
            if rejected is not None:
                return rejected
            return handler(request)

        async def awrap_tool_call(
            self,
            request: Any,
            handler: Callable[[Any], Awaitable[Any]],
        ) -> Any:
            """Apply the same guard on the asynchronous tool-dispatch path."""
            rejected = self._reject(request)
            if rejected is not None:
                return rejected
            return await handler(request)

    return HarnessProfile(
        extra_middleware=[NemoClawExecutePlaceholderGuardMiddleware()]
    )


def _register_aliases(
    registry: MutableMapping[str, Any],
    register_profile: Callable[[str, Any], None],
    overlay: Any,
) -> None:
    native_profile = registry.get(CANONICAL_PROFILE_KEY)
    if native_profile is None:
        raise _fail(f"canonical profile {CANONICAL_PROFILE_KEY!r} is not registered")

    existing = tuple(key in registry for key in MANAGED_PROFILE_KEYS)
    if all(existing):
        managed_profile = registry[MANAGED_PROFILE_KEYS[0]]
        native_middleware = tuple(getattr(native_profile, "extra_middleware", ()))
        managed_middleware = tuple(getattr(managed_profile, "extra_middleware", ()))
        preserves_native_middleware = (
            len(managed_middleware) == len(native_middleware) + 1
            and all(
                managed_item is native_item
                for managed_item, native_item in zip(
                    managed_middleware, native_middleware, strict=False
                )
            )
        )
        guard = managed_middleware[-1] if preserves_native_middleware else None
        if (
            managed_profile is not native_profile
            and all(registry[key] is managed_profile for key in MANAGED_PROFILE_KEYS)
            and guard is not None
            and type(guard).__name__
            == "NemoClawExecutePlaceholderGuardMiddleware"
            and type(guard).__module__ == __name__
        ):
            return
        raise _fail("managed aliases conflict with the reviewed managed profile")
    if any(existing):
        raise _fail("managed aliases are in a partial registration state")

    try:
        first_key, second_key = MANAGED_PROFILE_KEYS
        register_profile(first_key, native_profile)
        register_profile(first_key, overlay)
        managed_profile = registry.get(first_key)
        if managed_profile is None or managed_profile is native_profile:
            raise _fail("managed profile overlay was not applied")
        register_profile(second_key, managed_profile)
        if registry.get(CANONICAL_PROFILE_KEY) is not native_profile:
            raise _fail("canonical profile changed during managed registration")
        if not all(
            registry.get(key) is managed_profile for key in MANAGED_PROFILE_KEYS
        ):
            raise _fail("managed alias registration did not preserve managed identity")
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

    # Plugin discovery can race when several managed agents initialize at once.
    # The registry is the source of truth; this lock only makes its multi-key
    # transaction atomic and stores no parallel registration state.
    with _REGISTRATION_LOCK:
        _register_aliases(
            _HARNESS_PROFILES,
            register_harness_profile,
            _managed_profile_overlay(),
        )


__all__ = ["register"]
