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
        self._persistent_env_overrides = dict(env)
        self._env_overrides = {}
        self._state_lock = threading.RLock()

    async def start(self):
        with self._state_lock:
            cmd = self.cmd
            work_dir = self.work_dir
            env = _server_env_with_overrides(
                self._persistent_env_overrides, self._env_overrides
            )
            self._log_file = subprocess.PIPE
            self._process = self._launch_process(cmd, work_dir, env)
            process = self._process
            output, _ = process.communicate(timeout=10)
            if process.returncode != 0:
                raise RuntimeError(output.decode())
            self.outputs.append(output.decode())

    def _launch_process(self, cmd, work_dir, env):
        reader, writer = os.pipe()
        try:
            return subprocess.Popen(
                cmd,
                cwd=str(work_dir),
                env=env,
                stdout=self._log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                creationflags=0,
                pass_fds=(reader,),
            )
        finally:
            os.close(reader)
            os.close(writer)

    async def restart(self):
        with self._state_lock:
            process = self._process
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            await self.start()


def _server_env_with_overrides(persistent, overrides):
    env = _build_server_env()
    env.update(persistent)
    env.update(overrides)
    return env
