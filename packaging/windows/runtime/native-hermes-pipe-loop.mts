// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function hermesPipeLoopPythonSource(): string[] {
  return [
    String.raw`def _new_native_hermes_loop():
    import _winapi
    import asyncio
    import threading
    from asyncio import base_events
    from asyncio.windows_events import IocpProactor, ProactorEventLoop
    from asyncio.windows_utils import PipeHandle
    if sys.platform != 'win32' or sys.version_info[:3] != (3, 11, 16):
        raise RuntimeError('Hermes pipe loops require the exact shipping Windows Python 3.11.16')

    class WakeWriter(PipeHandle):
        def __init__(self, handle):
            super().__init__(handle)
            self.lock = threading.Lock()

        def send(self, data):
            with self.lock:
                if self._handle is None:
                    raise OSError('Hermes event-loop wakeup is closed')
                count, error = _winapi.WriteFile(self._handle, data)
                if error:
                    raise OSError('Hermes event-loop wakeup failed')
                return count

        def close(self):
            with self.lock:
                super().close()

    class MainThreadProactor(IocpProactor):
        def select(self, timeout=None):
            # Windows signal wakeup FDs require a socket. Keep the existing Python
            # signal handlers, checking them within 100ms without changing a global FD.
            return super().select(0.1 if timeout is None else min(timeout, 0.1))

    class NativePipeLoop(ProactorEventLoop):
        def __init__(self):
            # Pinned BaseProactor initialization, without its socketpair/set_wakeup_fd.
            base_events.BaseEventLoop.__init__(self)
            self._proactor = self._selector = None
            self._self_reading_future = None
            self._accept_futures = {}
            self._ssock = self._csock = None
            self._native_self_pipe_open = False
            try:
                proactor = MainThreadProactor() if threading.current_thread() is threading.main_thread() else IocpProactor()
                self._proactor = self._selector = proactor
                proactor.set_loop(self)
                self._make_self_pipe()
            except BaseException:
                if self._proactor is not None:
                    self._proactor.close()
                    self._proactor = self._selector = None
                if self._ssock is None and self._csock is None:
                    base_events.BaseEventLoop.close(self)
                raise

        def _make_self_pipe(self):
            address = '\\\\.\\pipe\\LOCAL\\Hermes-Wakeup-' + os.urandom(16).hex()
            try:
                self._ssock = PipeHandle(_winapi.CreateNamedPipe(address,
                    _winapi.PIPE_ACCESS_INBOUND | _winapi.FILE_FLAG_OVERLAPPED | _winapi.FILE_FLAG_FIRST_PIPE_INSTANCE,
                    0x00000008, 1, 0, 8192, _winapi.NMPWAIT_WAIT_FOREVER, _winapi.NULL))
                self._csock = WakeWriter(_winapi.CreateFile(address, _winapi.GENERIC_WRITE, 0, _winapi.NULL,
                    _winapi.OPEN_EXISTING, 0, _winapi.NULL))
                _winapi.ConnectNamedPipe(self._ssock.fileno(), overlapped=True).GetOverlappedResult(True)
                # PIPE_NOWAIT applies only to one-byte wakeups. The reader remains
                # IOCP-overlapped; a full buffer already contains a pending wakeup.
                _winapi.SetNamedPipeHandleState(self._csock.fileno(), 0x00000001, None, None)
                self._internal_fds += 1
                self._native_self_pipe_open = True
            except BaseException:
                self._close_self_pipe()
                raise

        def _close_self_pipe(self):
            if self._self_reading_future is not None:
                self._self_reading_future.cancel()
                self._self_reading_future = None
            errors = []
            for name in ('_ssock', '_csock'):
                handle = getattr(self, name)
                if handle is not None:
                    try:
                        handle.close()
                        setattr(self, name, None)
                    except OSError as error:
                        errors.append(error)
            if errors:
                raise RuntimeError('Hermes event-loop pipe closure remains unconfirmed') from errors[0]
            if self._native_self_pipe_open:
                self._internal_fds -= 1
                self._native_self_pipe_open = False

        def close(self):
            if self.is_running():
                raise RuntimeError('Cannot close a running Hermes pipe loop')
            if self.is_closed():
                return
            self._stop_accept_futures()
            self._close_self_pipe()
            if self._proactor is not None:
                self._proactor.close()
                self._proactor = self._selector = None
            base_events.BaseEventLoop.close(self)

    return NativePipeLoop()`,
  ];
}
