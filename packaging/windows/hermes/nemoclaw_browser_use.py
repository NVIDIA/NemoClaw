# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Windows-owned Browser Use entrypoint and browser acceleration compatibility."""

import hashlib
import os
from pathlib import Path
import sys

MODULE = "tools.browser_use_cli"
RELATIVE = "tools/browser_use_cli.py"
ENTRY_POINTS = (
    "tools/browser-use/Lib/site-packages/browser_use-0.13.10.dist-info/entry_points.txt"
)
ENTRY_POINTS_SHA256 = "444f604c01aadb261d692bf944e9ebc2e39398ef77dcf0a32d550eb25e32e0e1"
CLI = "tools/browser-use/Lib/site-packages/browser_use/cli.py"
CLI_SHA256 = "9a52306f028230fa471b0887e81b0ab4eccc15dc26be4b0b152bb001ba2977ef"
PYTHON = "tools/browser-use/Scripts/python.exe"
_installed_root = None


def adapt(module, root, native):
    """Keep upstream launch ownership with the admitted Windows compatibility flags."""
    if root != native._active_root or module.__name__ != MODULE:
        native._refuse("the Browser Use adapter has no matching admitted runtime.")
    expected = native._regular_file(root / "hermes-agent" / RELATIVE, root)
    if native._regular_file(Path(module.__file__), root) != expected:
        native._refuse("the Browser Use policy module is outside this runtime.")
    if not callable(getattr(module, "_find_cli", None)):
        native._refuse("the Browser Use resolver interface is unsupported.")
    for relative, digest in ((ENTRY_POINTS, ENTRY_POINTS_SHA256), (CLI, CLI_SHA256)):
        file = native._regular_file(root / relative, root)
        try:
            actual = hashlib.sha256(file.read_bytes()).hexdigest()
        except OSError:
            native._refuse("the installed Browser Use module entry is unreadable.")
        if actual != digest:
            native._refuse("the installed Browser Use module entry differs.")

    def owned_cli():
        python = native._regular_file(root / PYTHON, root)
        native._regular_file(root / CLI, root)
        return [str(python), "-I", "-B", "-m", "browser_use.cli"]

    command = owned_cli()
    # agent-browser0.26 splits AGENT_BROWSER_ARGS on commas/newlines, not spaces.
    # Preserve every supplied argument and append only this browser-only flag.
    arguments = os.environ.get("AGENT_BROWSER_ARGS", "")
    tokens = [
        part.strip() for line in arguments.split("\n") for part in line.split(",")
    ]
    if "--disable-gpu" not in tokens:
        os.environ["AGENT_BROWSER_ARGS"] = (
            arguments + ("," if arguments else "") + "--disable-gpu"
        )
    module._find_cli = owned_cli
    return {
        "classification": "owned-browser-use-module-launch",
        "command": command,
        "modulePath": str(root / CLI),
        "moduleSha256": CLI_SHA256,
        "entryPointsSha256": ENTRY_POINTS_SHA256,
        "trampolineBypassed": True,
        "runtimeBytesModified": False,
        "browserArgumentPolicy": {
            "environment": "AGENT_BROWSER_ARGS",
            "requiredFlag": "--disable-gpu",
            "otherArgumentsPreserved": True,
            "scope": "browser graphics acceleration only",
        },
    }


def install():
    """Companion owned .pth entry, after the existing native startup adapter."""
    global _installed_root
    if os.name != "nt":
        return
    import nemoclaw_native_windows as native

    root = native._active_root
    if _installed_root is not None:
        if root != _installed_root:
            native._refuse("the Browser Use startup runtime changed.")
        return
    if (
        root is None
        or MODULE in sys.modules
        or MODULE in native._MODULES
        or not callable(native._adapt_module)
    ):
        native._refuse("the Browser Use startup adapter must follow native admission.")
    previous = native._adapt_module

    def adapt_module(module, runtime, bash):
        previous(module, runtime, bash)
        if module.__name__ == MODULE:
            adapt(module, runtime, native)

    # Reuse the existing origin-checked loader rather than adding another finder.
    native._MODULES[MODULE] = RELATIVE
    native._adapt_module = adapt_module
    _installed_root = root
