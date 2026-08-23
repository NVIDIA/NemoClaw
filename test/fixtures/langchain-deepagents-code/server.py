# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Minimal pinned server lifecycle fixture for the managed package patch tests."""

from __future__ import annotations

import os
import subprocess
import sys
import threading


def _build_server_env():
    return dict(os.environ)


class ServerProcess:
    def __init__(self, cmd, work_dir, env):
        self.cmd = cmd
        self.work_dir = work_dir
        self.env = env
        self.outputs = []
        self._process = None
        self._persistent_env_overrides = {}
        self._env_overrides = {}
        self._state_lock = threading.RLock()

    async def start(self):
        with self._state_lock:
            cmd = self.cmd
            work_dir = self.work_dir
            env = self.env
            env.update(self._persistent_env_overrides)
            env.update(self._env_overrides)
            self._log_file = subprocess.PIPE
            self._process = subprocess.Popen(  # noqa: S603
                cmd,
                cwd=str(work_dir),
                env=env,
                stdout=self._log_file,
                stderr=subprocess.STDOUT,
                start_new_session=(sys.platform != "win32"),
            )
            process = self._process
            output, _ = process.communicate(timeout=10)
            if process.returncode != 0:
                raise RuntimeError(output.decode())
            self.outputs.append(output.decode())

    async def restart(self):
        with self._state_lock:
            process = self._process
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            await self.start()
