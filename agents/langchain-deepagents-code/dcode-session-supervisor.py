# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Reap processes started by one managed Deep Agents Code terminal session."""

from __future__ import annotations

import ctypes
import errno
import os
import signal
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path

_PR_SET_CHILD_SUBREAPER = 36
_TERM_GRACE_SECONDS = 3.0
_KILL_GRACE_SECONDS = 1.0
_POLL_SECONDS = 0.05


def _enable_child_subreaper() -> None:
    """Adopt orphaned LangGraph descendants when the DCode process exits."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(_PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def _direct_children() -> set[int]:
    children: set[int] = set()
    try:
        entries = os.scandir("/proc")
    except OSError:
        return children
    with entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            try:
                stat = Path(f"/proc/{entry.name}/stat").read_text(encoding="utf-8")
                closing = stat.rfind(")")
                fields = stat[closing + 2 :].split()
                if closing != -1 and len(fields) >= 2 and int(fields[1]) == os.getpid():
                    children.add(int(entry.name))
            except (FileNotFoundError, PermissionError, ValueError, OSError):
                continue
    return children


def _reap_exited_children() -> None:
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        except InterruptedError:
            continue
        if pid == 0:
            return


def _signal_children(children: set[int], sig: signal.Signals) -> None:
    for pid in children:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            continue
        except PermissionError:
            print(
                f"dcode: cannot signal managed session descendant pid={pid}",
                file=sys.stderr,
            )


def _cleanup_adopted_descendants() -> None:
    """Terminate and reap every descendant associated with this launch."""
    deadline = time.monotonic() + _TERM_GRACE_SECONDS
    signaled: set[int] = set()
    while True:
        _reap_exited_children()
        children = _direct_children()
        if not children:
            return
        new_children = children - signaled
        if new_children:
            _signal_children(new_children, signal.SIGTERM)
            signaled.update(new_children)
        if time.monotonic() >= deadline:
            _signal_children(children, signal.SIGKILL)
            break
        time.sleep(_POLL_SECONDS)

    kill_deadline = time.monotonic() + 1.0
    while time.monotonic() < kill_deadline:
        _reap_exited_children()
        children = _direct_children()
        if not children:
            return
        _signal_children(children, signal.SIGKILL)
        time.sleep(_POLL_SECONDS)
    _reap_exited_children()


def _exit_code(returncode: int) -> int:
    return returncode if returncode >= 0 else 128 + abs(returncode)


def _wait_after_disconnect(child: subprocess.Popen[bytes]) -> int:
    """Bound shutdown even when the direct DCode child ignores disconnect."""
    try:
        return child.wait(timeout=_TERM_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        child.terminate()
    try:
        return child.wait(timeout=_KILL_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        child.kill()
        return child.wait()


def run(argv: Sequence[str]) -> int:
    if not argv:
        print("dcode session supervisor requires a command.", file=sys.stderr)
        return 64
    if sys.platform != "linux":
        print(
            "dcode: session supervision requires a Linux OpenShell sandbox.",
            file=sys.stderr,
        )
        return 1

    _enable_child_subreaper()
    child: subprocess.Popen[bytes] | None = None
    pending_signals: list[int] = []
    disconnect_received = False

    def forward(sig: int, _frame: object) -> None:
        nonlocal disconnect_received
        disconnect_received = True
        if child is None:
            pending_signals.append(sig)
            return
        try:
            os.kill(child.pid, sig)
        except (ProcessLookupError, PermissionError):
            # The child may exit between signal delivery and this forwarding
            # attempt; cleanup below still reaps any adopted descendants.
            pass

    # Terminal-generated SIGINT already reaches every member of the foreground
    # process group. Keep the supervisor alive to reap descendants without
    # delivering a second Ctrl-C to DCode. OpenShell may target only the direct
    # launcher for disconnect/termination signals, so those are forwarded.
    signal.signal(signal.SIGINT, lambda _sig, _frame: None)
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, forward)

    try:
        child = subprocess.Popen(list(argv))
        for pending_signal in pending_signals:
            forward(pending_signal, None)
        while True:
            try:
                returncode = child.wait(timeout=_POLL_SECONDS)
                break
            except subprocess.TimeoutExpired:
                if disconnect_received:
                    returncode = _wait_after_disconnect(child)
                    break
    finally:
        _cleanup_adopted_descendants()
    return _exit_code(returncode)


if __name__ == "__main__":
    try:
        raise SystemExit(run(sys.argv[1:]))
    except OSError as error:
        if error.errno == errno.ENOSYS:
            print("dcode: Linux child-subreaper support is unavailable.", file=sys.stderr)
        else:
            print(f"dcode: session supervisor failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
