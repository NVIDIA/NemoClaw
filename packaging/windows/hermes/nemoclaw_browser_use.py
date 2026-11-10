# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Use the installed Browser Use module entry instead of uv's path trampoline."""

import hashlib
import importlib.util
import os
from pathlib import Path, PureWindowsPath
import re
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


def _personal_workers(root, environment):
    """A build probe uses its read-only controller stage, never an installed mount."""
    nonce = environment.get("NEMOCLAW_PERSONAL_BROWSER_SESSION", "")
    if (
        environment.get("GITHUB_ACTIONS") != "true"
        or environment.get("NEMOCLAW_AGENT_RUNTIME")
        or not re.fullmatch(r"[a-f0-9]{24}", nonce)
        or not re.fullmatch(r"[A-Z]:\\NemoClawHermesProbe-[a-f0-9]{12}", str(root))
        or not re.fullmatch(r"[a-f0-9]{64}", environment.get("NEMOCLAW_PERSONAL_BROWSER_BOOTSTRAP_SHA256", ""))
    ):
        raise ValueError("Personal browser bootstrap has no current build identity")
    workers = PureWindowsPath(root).parent / ("NemoClawPersonalNode-" + nonce[:12]) / "workers"
    if str(workers) != environment.get("NEMOCLAW_WORKER_ROOT"):
        raise ValueError("Personal browser bootstrap differs from its fixed controller stage")
    return Path(str(workers))


def _install_pipe_bootstrap(root, native):
    if "NEMOCLAW_HERMES_BROWSER_PIPE_PORT" not in os.environ:
        return
    python = native._regular_file(root / PYTHON, root)
    if not native._same_path(Path(sys.executable), python):
        return
    personal = "NEMOCLAW_PERSONAL_BROWSER_SESSION" in os.environ
    workers = _personal_workers(root, os.environ) if personal else root.parent / "workers"
    declared = os.environ.get("NEMOCLAW_WORKER_ROOT")
    if not declared or not native._same_path(Path(declared), workers):
        native._refuse("the contained Browser Use worker root differs from its runtime.")
    bootstrap = native._regular_file(
        workers / "hermes-browser-bootstrap.pyc", workers, native._runtime_volume_mount(root)
    )
    if personal:
        if bootstrap.stat().st_size > 1024 * 1024 or hashlib.sha256(bootstrap.read_bytes()).hexdigest() != os.environ["NEMOCLAW_PERSONAL_BROWSER_BOOTSTRAP_SHA256"]:
            native._refuse("the Personal Browser Use bootstrap differs from its declared bytes.")
    spec = importlib.util.spec_from_file_location("_nemoclaw_browser_bootstrap", bootstrap)
    if spec is None or spec.loader is None:
        native._refuse("the contained Browser Use bootstrap is unavailable.")
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception:
        native._refuse("the contained Browser Use bootstrap could not be loaded.")


def adapt(module, root, native):
    """Change only Hermes' CLI resolver; upstream runs stdin/env/args itself."""
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
    module._find_cli = owned_cli
    return {
        "classification": "owned-browser-use-module-launch",
        "command": command,
        "modulePath": str(root / CLI),
        "moduleSha256": CLI_SHA256,
        "entryPointsSha256": ENTRY_POINTS_SHA256,
        "trampolineBypassed": True,
        "runtimeBytesModified": False,
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
    try:
        _install_pipe_bootstrap(root, native)
    except Exception:
        native._refuse("the contained Browser Use startup could not be initialized.")
    _installed_root = root
    if _installed_root != root:
        native._refuse("the Browser Use startup runtime was not retained.")
