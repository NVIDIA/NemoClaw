# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Terminate an isolated platform operation if its provider loses custody."""

import os
import signal
import sys
import threading


def start():
    """Watch the request pipe after its first line; the parent must keep it open."""
    process = os.getpid()
    if os.name == "posix" and os.getpgrp() != process:
        # Never signal the operator's shell or another caller's process group.
        raise RuntimeError("parent custody requires an isolated process group")
    pipe = sys.stdin.fileno()

    def lost_parent():
        try:
            # There is no second request. EOF, an unexpected byte, or a broken
            # pipe all terminate custody without exposing any input or output.
            # Use the descriptor directly so an idle daemon never holds a
            # BufferedReader lock while Python finalizes a successful helper.
            os.read(pipe, 1)
        finally:
            if os.name == "posix" and os.getpgrp() == process:
                os.killpg(process, signal.SIGKILL)
            # Windows descendants are held by the Rust parent's JobObject.
            os._exit(1)

    threading.Thread(target=lost_parent, name="parent-custody", daemon=True).start()
