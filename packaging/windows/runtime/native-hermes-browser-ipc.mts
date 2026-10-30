// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function hermesBrowserIpcPythonSource(): string[] {
  return [
    String.raw`def _install_native_browser_ipc(session_id):
    import _winapi
    import asyncio
    import hashlib
    import json
    import math
    import re
    import secrets
    import stat
    import threading
    import time
    from browser_harness import _ipc as ipc

    if sys.platform != 'win32' or not re.fullmatch(r'[0-9a-f]{10}', session_id):
        raise RuntimeError('Browser IPC requires Windows and its native session identity')
    existing = getattr(ipc, '_native_pipe_ipc', None)
    if existing is not None:
        if existing[0] != session_id:
            raise RuntimeError('Browser IPC session cannot change after bootstrap')
        return existing[1:]
    clients, servers = set(), {}
    # CPython 3.11 returns this status but doesn't export its Win32 constant.
    ERROR_IO_INCOMPLETE = 996

    def prefix(name):
        file = ipc.port_path(name)
        identity = os.path.normcase(os.path.abspath(str(file))).encode('utf-8')
        return '\\\\.\\pipe\\LOCAL\\Hermes-Browser-' + session_id + '-' + hashlib.sha256(identity).hexdigest()[:24]

    def read_record(name):
        file = ipc.port_path(name)
        with file.open('rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                raise OSError('Browser IPC endpoint record is not a bounded regular file')
            data = stream.read(4097)
        if len(data) > 4096:
            raise OSError('Browser IPC endpoint record exceeds its bound')
        try:
            value = json.loads(data)
            if (not isinstance(value, dict) or set(value) != {'schemaVersion', 'transport', 'pipe', 'token'}
                    or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1
                    or value['transport'] != 'native-hermes-browser-pipe'
                    or not isinstance(value['pipe'], str)
                    or value['pipe'] != prefix(name)
                    or not isinstance(value['token'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['token'])):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise OSError('Browser IPC endpoint identity is invalid') from None
        return value, data

    def timeout_value(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('Browser IPC requires a finite positive timeout')
        return float(value)

    def milliseconds(deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Browser IPC operation timed out')
        return min(2147483647, max(1, math.ceil(remaining * 1000)))

    class PipeClient:
        def __init__(self, timeout):
            self.timeout = timeout_value(timeout)
            self.handle = None
            self.pending = None
            self.lock = threading.RLock()
            clients.add(self)

        def open(self, address):
            deadline = time.monotonic() + self.timeout
            while True:
                milliseconds(deadline)
                try:
                    self.handle = _winapi.CreateFile(address, _winapi.GENERIC_READ | _winapi.GENERIC_WRITE,
                        0, _winapi.NULL, _winapi.OPEN_EXISTING, _winapi.FILE_FLAG_OVERLAPPED, _winapi.NULL)
                    # Stream reads preserve the existing newline-delimited JSON protocol.
                    _winapi.SetNamedPipeHandleState(self.handle, 0, None, None)
                    return
                except OSError as error:
                    if self.handle is not None or getattr(error, 'winerror', None) != _winapi.ERROR_PIPE_BUSY:
                        raise
                    try:
                        _winapi.WaitNamedPipe(address, milliseconds(deadline))
                    except OSError as wait_error:
                        if getattr(wait_error, 'winerror', None) == _winapi.ERROR_SEM_TIMEOUT:
                            raise TimeoutError('Browser IPC connection timed out') from None
                        raise

        def settimeout(self, value):
            with self.lock:
                self.timeout = timeout_value(value)

        def close(self):
            with self.lock:
                if self.pending is not None:
                    self.pending.cancel()
                    if _winapi.WaitForSingleObject(self.pending.event, 5000) != _winapi.WAIT_OBJECT_0:
                        raise RuntimeError('Browser IPC overlapped operation remains owned')
                    try:
                        _, error = self.pending.GetOverlappedResult(False)
                    except OSError as failure:
                        error = getattr(failure, 'winerror', None)
                        if type(error) is not int: raise
                    if error == ERROR_IO_INCOMPLETE:
                        raise RuntimeError('Browser IPC overlapped operation remains incomplete')
                    self.pending = None
                if self.handle is not None:
                    _winapi.CloseHandle(self.handle)
                    self.handle = None
                clients.discard(self)

        def operate(self, kind, value, deadline):
            if self.handle is None or self.pending is not None:
                raise OSError('Browser IPC connection is closed or still owns an operation')
            try:
                milliseconds(deadline)
                operation, error = kind(self.handle, value, overlapped=True)
                self.pending = operation
                if error == _winapi.ERROR_IO_PENDING:
                    if _winapi.WaitForSingleObject(operation.event, milliseconds(deadline)) != _winapi.WAIT_OBJECT_0:
                        raise TimeoutError('Browser IPC operation timed out')
                try:
                    count, error = operation.GetOverlappedResult(False)
                except OSError as failure:
                    failure_code = getattr(failure, 'winerror', None)
                    if type(failure_code) is int and failure_code != ERROR_IO_INCOMPLETE:
                        self.pending = None
                    raise
                if error == ERROR_IO_INCOMPLETE:
                    raise OSError('Browser IPC operation is incomplete')
                self.pending = None
                if error:
                    raise OSError('Browser IPC operation failed')
                return operation, count
            except BaseException:
                self.close()
                raise

        def sendall(self, data):
            with self.lock:
                deadline = time.monotonic() + self.timeout
                view = memoryview(data)
                while view:
                    chunk = view[:8192]
                    _, count = self.operate(_winapi.WriteFile, chunk, deadline)
                    if count != len(chunk):
                        self.close()
                        raise OSError('Browser IPC write was incomplete')
                    view = view[count:]

        def recv(self, size):
            with self.lock:
                if type(size) is not int or not 0 < size <= 65536:
                    raise ValueError('Browser IPC read size is outside its bound')
                try:
                    operation, count = self.operate(_winapi.ReadFile, size, time.monotonic() + self.timeout)
                except BrokenPipeError:
                    return b''
                return operation.getbuffer()[:count]

    def connect(name, timeout=1.0):
        value, _ = read_record(name)
        client = PipeClient(timeout)
        try:
            client.open(value['pipe'])
        except BaseException:
            client.close()
            raise
        return client, value['token']

    async def settled(futures):
        if not futures:
            return []
        done, pending = await asyncio.wait(set(futures), timeout=5)
        if pending:
            raise RuntimeError('Browser IPC closure remains pending')
        return [asyncio.CancelledError() if future.cancelled() else future.exception() for future in done]

    class ServerOwner:
        def __init__(self, name, handler):
            self.name, self.handler = name, handler
            self.listeners, self.accepts = [], []
            self.connections, self.tasks = set(), set()
            self.record = None
            self.closing = False
            self.task = asyncio.current_task()

        def protocol(self):
            owner = self
            reader = asyncio.StreamReader(limit=65536)

            async def handle(reader, writer):
                try:
                    if not owner.closing:
                        await owner.handler(reader, writer)
                finally:
                    writer.close()
                    await writer.wait_closed()

            def connected(reader, writer):
                task = asyncio.create_task(handle(reader, writer))
                owner.tasks.add(task)
                def finished(task):
                    if not task.cancelled(): task.exception()
                    owner.tasks.discard(task)
                task.add_done_callback(finished)

            class Protocol(asyncio.StreamReaderProtocol):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    self.native_transport = None
                    owner.connections.add(self)

                def connection_made(self, transport):
                    self.native_transport = transport
                    super().connection_made(transport)
                    if owner.closing: transport.close()

                def connection_lost(self, error):
                    super().connection_lost(error)
                    owner.connections.discard(self)

                def _get_close_waiter(self, stream):
                    return asyncio.shield(super()._get_close_waiter(stream))

            return Protocol(reader, client_connected_cb=connected)

        async def close(self):
            retry = self.closing
            self.closing = True
            for listener in self.listeners:
                if not listener.closed():
                    if listener._accept_pipe_future is not None:
                        self.accepts.append(listener._accept_pipe_future)
                    listener.close()
            if self.accepts:
                results = await settled(self.accepts)
                if any(isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError) for result in results):
                    raise RuntimeError('Browser IPC listener closure failed')
            for task in list(self.tasks):
                task.cancel()
            for connection in list(self.connections):
                if connection.native_transport is not None:
                    if retry: connection.native_transport.abort()
                    else: connection.native_transport.close()
            if self.tasks:
                await settled(self.tasks)
            if self.connections:
                await settled([asyncio.StreamReaderProtocol._get_close_waiter(connection, None)
                               for connection in list(self.connections)])
            if self.connections or self.tasks or any(not listener.closed() for listener in self.listeners):
                raise RuntimeError('Browser IPC server closure remains unconfirmed')

    async def serve(name, handler):
        if servers:
            raise RuntimeError('Browser IPC already owns a daemon listener')
        # CPython's first pipe instance prevents a second daemon binding this identity.
        address = prefix(name)
        owner = ServerOwner(name, handler)
        servers[name] = owner
        ipc._server_token = secrets.token_hex(32)
        try:
            loop = asyncio.get_running_loop()
            owner.listeners = await loop.start_serving_pipe(owner.protocol, address)
            if not owner.listeners:
                raise RuntimeError('Browser IPC pipe listener did not bind')
            owner.record = (json.dumps({'schemaVersion': 1, 'transport': 'native-hermes-browser-pipe',
                'pipe': address, 'token': ipc._server_token}) + '\n').encode('utf-8')
            file = ipc.port_path(name)
            temporary = file.with_name(file.name + '.tmp-' + secrets.token_hex(8))
            try:
                with temporary.open('xb') as output:
                    output.write(owner.record)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, file)
            finally:
                try: temporary.unlink()
                except FileNotFoundError: pass
            await asyncio.Event().wait()
        finally:
            await owner.close()
            servers.pop(name, None)
            ipc._server_token = None

    def cleanup_endpoint(name):
        if name in servers:
            raise RuntimeError('Browser IPC listener still owns its endpoint record')
        ipc.port_path(name)
        # Retain the bounded record. Only a new exclusive pipe owner replaces it;
        # an old client/server must never unlink a newer daemon's endpoint record.

    def sock_addr(name):
        try: return read_record(name)[0]['pipe']
        except (OSError, ValueError): return 'native-pipe:' + ipc._runtime_stem(name)

    async def close_owned():
        for client in list(clients):
            client.close()
        for name, owner in list(servers.items()):
            if not owner.task.done():
                if owner.task is asyncio.current_task():
                    raise RuntimeError('Browser IPC cannot join its own server task')
                owner.task.cancel()
                await settled([owner.task])
            if name not in servers:
                continue
            await owner.close()
            servers.pop(name, None)
        if clients or servers:
            raise RuntimeError('Browser IPC still owns native handles')
        ipc._server_token = None

    ipc.connect, ipc.serve = connect, serve
    ipc.sock_addr, ipc.cleanup_endpoint = sock_addr, cleanup_endpoint
    ipc._native_pipe_ipc = (session_id, close_owned, clients, servers)
    return ipc._native_pipe_ipc[1:]`,
  ];
}
