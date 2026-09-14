#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Preserve explicit Hermes auxiliary output limits on managed inference.

Hermes v0.20.6 drops ``max_tokens`` from auxiliary OpenAI-compatible
requests unless the provider belongs to a small allowlist. This removes the
64-token limit from session-title generation on NemoClaw's managed Ollama
route. A thinking model can then occupy Ollama's only inference slot until it
fills the context window, which blocks the user's first prompt.

The source fix belongs in Hermes. This pinned image patch keeps the caller's
explicit limit only for ``inference.local``. Other custom endpoints retain
Hermes's compatibility behavior.
"""

from __future__ import annotations

import argparse
from pathlib import Path

UNPATCHED = """        if (
            _is_anthropic_compat_endpoint(provider, _effective_base)
            or _nous_on_messages
            or _is_nvidia_nim
            or _is_moa
            or _is_gemini_native
        ):"""

PATCHED = """        if (
            _is_anthropic_compat_endpoint(provider, _effective_base)
            or _nous_on_messages
            or _is_nvidia_nim
            or _is_moa
            or _is_gemini_native
            or base_url_host_matches(_effective_base, "inference.local")
        ):"""


def patch_file(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    unpatched_count = source.count(UNPATCHED)
    patched_count = source.count(PATCHED)

    if unpatched_count == 0 and patched_count == 1:
        return
    if unpatched_count != 1 or patched_count != 0:
        raise SystemExit(
            "ERROR: Hermes auxiliary max_tokens condition changed; "
            f"found {unpatched_count} unpatched and {patched_count} patched blocks"
        )

    path.write_text(source.replace(UNPATCHED, PATCHED), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        default="/opt/hermes/agent/auxiliary_client.py",
        help="Hermes auxiliary client module to patch",
    )
    args = parser.parse_args()
    patch_file(Path(args.path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
