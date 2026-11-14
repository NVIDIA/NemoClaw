# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Windows compatibility loaded only by the staged Deep Agents Python runtime."""

import os
import sys
import tempfile
from pathlib import Path


if os.name == "nt":
    _original_path_mkdir = Path.mkdir

    def _mkdir_with_inherited_windows_dacl(
        path: Path,
        mode: int = 0o777,
        parents: bool = False,
        exist_ok: bool = False,
    ) -> None:
        del mode
        _original_path_mkdir(path, 0o777, parents=parents, exist_ok=exist_ok)

    def _preserve_inherited_windows_dacl(*_args: object, **_kwargs: object) -> None:
        """Keep the MXC-approved inherited DACL instead of applying a POSIX mode."""

    def _mkdtemp_with_inherited_windows_dacl(
        suffix: str | bytes | None = None,
        prefix: str | bytes | None = None,
        dir: str | bytes | None = None,
    ) -> str | bytes:
        prefix, suffix, dir, output_type = tempfile._sanitize_params(prefix, suffix, dir)
        names = tempfile._get_candidate_names()
        if output_type is bytes:
            names = map(os.fsencode, names)
        for _ in range(tempfile.TMP_MAX):
            name = next(names)
            candidate = os.path.join(dir, prefix + name + suffix)
            sys.audit("tempfile.mkdtemp", candidate)
            try:
                os.mkdir(candidate, 0o777)
            except FileExistsError:
                continue
            return os.path.abspath(candidate)
        raise FileExistsError("No usable temporary directory name found")

    def _mkstemp_inner_with_inherited_windows_dacl(
        dir: str | bytes,
        prefix: str | bytes,
        suffix: str | bytes,
        flags: int,
        output_type: type[str] | type[bytes],
    ) -> tuple[int, str | bytes]:
        dir = os.path.abspath(dir)
        names = tempfile._get_candidate_names()
        if output_type is bytes:
            names = map(os.fsencode, names)
        for _ in range(tempfile.TMP_MAX):
            name = next(names)
            candidate = os.path.join(dir, prefix + name + suffix)
            sys.audit("tempfile.mkstemp", candidate)
            try:
                # Windows access remains governed by the inherited DACL. Keep
                # the portable mode restrictive so static analysis and any
                # non-Windows reuse cannot interpret this as world-writable.
                file_descriptor = os.open(candidate, flags, 0o600)
            except FileExistsError:
                continue
            return file_descriptor, candidate
        raise FileExistsError("No usable temporary file name found")

    Path.mkdir = _mkdir_with_inherited_windows_dacl  # type: ignore[method-assign]
    Path.chmod = _preserve_inherited_windows_dacl  # type: ignore[method-assign]
    tempfile.mkdtemp = _mkdtemp_with_inherited_windows_dacl
    tempfile._mkstemp_inner = _mkstemp_inner_with_inherited_windows_dacl
