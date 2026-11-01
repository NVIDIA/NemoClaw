// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Materialized into sealed Python workers at build time, never written by the installed app.
export function hermesInferencePipePythonSource(): string[] {
  return [
    String.raw`def _install_native_inference_pipe(port_text):
    import asyncio
    import atexit
    import concurrent.futures
    import socket
    import threading
    import time
    import httpcore
    import httpx
    from agent import process_bootstrap as bootstrap
    if sys.platform != 'win32':
        raise RuntimeError('Hermes inference pipes require native Windows')
    if not port_text.isascii() or not port_text.isdecimal() or not 1 <= int(port_text) <= 65535:
        raise RuntimeError('The declared Hermes inference pipe port is invalid')
    declared_port = int(port_text)
    existing = getattr(bootstrap, '_native_pipe_backend', None)
    if existing is not None:
        if existing[0] != declared_port:
            raise RuntimeError('Hermes inference pipe cannot change after bootstrap')
        return existing[1:]
    pipe_name = '\\\\.\\pipe\\LOCAL\\OpenShell-Loopback-' + str(declared_port)
    base_url = 'http://127.0.0.1:' + str(declared_port) + '/v1'

    class PipeProtocol(asyncio.StreamReaderProtocol):
        def __init__(self, reader):
            super().__init__(reader)
            self.transport = None
            self.ready = asyncio.get_running_loop().create_future()
            self.closed = asyncio.get_running_loop().create_future()

        def connection_made(self, transport):
            self.transport = transport
            super().connection_made(transport)
            self.ready.set_result(None)

        def connection_lost(self, error):
            super().connection_lost(error)
            if not self.closed.done():
                self.closed.set_result(None)

    class PipeStream:
        def __init__(self, reader, protocol, owner):
            self.reader = reader
            self.protocol = protocol
            self.loop = asyncio.get_running_loop()
            self.writer = asyncio.StreamWriter(protocol.transport, protocol, reader, self.loop)
            self.owner = owner
            owner.streams.add(self)

        async def read(self, max_bytes, timeout=None):
            try:
                async with asyncio.timeout(timeout):
                    return await self.reader.read(max_bytes)
            except BaseException as error:
                await self.aclose()
                if isinstance(error, TimeoutError): raise httpcore.ReadTimeout() from error
                if isinstance(error, OSError): raise httpcore.ReadError() from error
                raise

        async def write(self, buffer, timeout=None):
            try:
                async with asyncio.timeout(timeout):
                    for offset in range(0, len(buffer), 65536):
                        self.writer.write(buffer[offset:offset + 65536])
                        await self.writer.drain()
            except BaseException as error:
                await self.aclose()
                if isinstance(error, TimeoutError): raise httpcore.WriteTimeout() from error
                if isinstance(error, OSError): raise httpcore.WriteError() from error
                raise

        async def aclose(self):
            self.protocol.transport.abort()
            # Keep ownership until connection_lost confirms pipe-handle closure.
            await asyncio.wait_for(asyncio.shield(self.protocol.closed), 5)
            self.owner.streams.discard(self)

        async def start_tls(self, *args, **kwargs):
            await self.aclose()
            raise httpcore.ConnectError('TLS is not a contained inference pipe transport')

        def get_extra_info(self, name):
            if name == 'is_readable':
                return self.protocol.closed.done() or self.reader.at_eof() or bool(self.reader._buffer)
            if name == 'socket':
                return self
            return None

        # Hermes's owner-filtered abort walker needs shutdown/peek, not a raw descriptor.
        # No file descriptor or TCP peer address is exposed or fabricated.
        def shutdown(self, how):
            if how != socket.SHUT_RDWR:
                raise OSError('Only complete inference cancellation is supported')
            self.loop.call_soon_threadsafe(self.protocol.transport.abort)

        def settimeout(self, value):
            pass

        def setblocking(self, value):
            pass

        def recv(self, size, flags=0):
            if not flags & socket.MSG_PEEK:
                raise OSError('Pipe health checks must not consume inference data')
            if self.protocol.closed.done() or self.reader.at_eof():
                return b''
            raise BlockingIOError()

    class PipeBackend:
        def __init__(self):
            self.streams = set()
            self.pending = {}
            self.closing = False

        async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
            if self.closing:
                raise httpcore.ConnectError('Hermes inference backend is closing')
            if host != '127.0.0.1' or port != declared_port or local_address is not None or socket_options:
                raise httpcore.ConnectError('Inference endpoint does not match its declared pipe')
            loop = asyncio.get_running_loop()
            connect = getattr(loop, 'create_pipe_connection', None)
            if not callable(connect):
                raise httpcore.ConnectError('Hermes inference requires a Windows Proactor loop')
            reader = asyncio.StreamReader(limit=65536)
            protocol = PipeProtocol(reader)
            self.pending[protocol] = asyncio.current_task()
            stream = None
            try:
                async with asyncio.timeout(timeout):
                    transport, _ = await connect(lambda: protocol, pipe_name)
                    # Proactor returns before its scheduled connection_made callback.
                    # Own the handle immediately, but wait for protocol initialization.
                    protocol.transport = transport
                    await asyncio.shield(protocol.ready)
                if self.closing or protocol.transport.is_closing():
                    raise httpcore.ConnectError('Hermes inference pipe closed during connection')
                stream = PipeStream(reader, protocol, self)
                return stream
            except BaseException as error:
                if protocol.transport is not None:
                    protocol.transport.abort()
                    await asyncio.wait_for(asyncio.shield(protocol.closed), 5)
                if isinstance(error, TimeoutError): raise httpcore.ConnectTimeout() from error
                if isinstance(error, OSError): raise httpcore.ConnectError() from error
                raise
            finally:
                if stream is not None or protocol.transport is None or protocol.closed.done():
                    self.pending.pop(protocol, None)

        async def connect_unix_socket(self, *args, **kwargs):
            raise httpcore.ConnectError('Unix sockets are not a contained inference pipe transport')

        async def sleep(self, seconds):
            await asyncio.sleep(seconds)

        async def close(self):
            self.closing = True
            pending_tasks = {task for task in self.pending.values()
                             if not task.done() and task is not asyncio.current_task()}
            for task in pending_tasks:
                task.cancel()
            if pending_tasks:
                await asyncio.wait_for(asyncio.gather(*pending_tasks, return_exceptions=True), 5)
            for protocol in list(self.pending):
                if protocol.transport is not None:
                    protocol.transport.abort()
            results = await asyncio.gather(*(item.aclose() for item in list(self.streams)), return_exceptions=True)
            for protocol in list(self.pending):
                if protocol.transport is not None:
                    await asyncio.wait_for(asyncio.shield(protocol.closed), 5)
                    self.pending.pop(protocol, None)
            if self.streams or self.pending or any(isinstance(result, BaseException) for result in results):
                raise RuntimeError('Hermes inference pipe closure remains unconfirmed')

    class BlockingLoop:
        def __init__(self):
            self.lock = threading.Lock()
            self.loop = None
            self.thread = None
            self.failure = None
            self.closed = False

        def start(self):
            with self.lock:
                if self.closed:
                    raise RuntimeError('Hermes inference transport is closed')
                if self.thread is not None:
                    if self.failure is not None or not self.thread.is_alive() or self.loop is None:
                        raise RuntimeError('Hermes inference pipe loop is unavailable') from self.failure
                    return
                ready = threading.Event()

                def worker():
                    try:
                        self.loop = _new_native_hermes_loop()
                        asyncio.set_event_loop(self.loop)
                    except BaseException as error:
                        self.failure = error
                        ready.set()
                        return
                    self.loop.call_soon(ready.set)
                    try:
                        self.loop.run_forever()
                    finally:
                        self.loop.close()

                self.thread = threading.Thread(target=worker, name='hermes-inference-pipe', daemon=True)
                self.thread.start()
                if not ready.wait(5) or self.failure is not None:
                    raise RuntimeError('Hermes inference pipe loop did not start') from self.failure

        def run(self, coroutine, discard=None):
            try:
                self.start()
                if threading.current_thread() is self.thread:
                    raise RuntimeError('Blocking inference cannot run on its I/O loop')
                result = concurrent.futures.Future()
                settled = threading.Event()
                task = []

                def complete(value):
                    try:
                        result.set_result(value.result())
                    except BaseException as error:
                        result.set_exception(error)
                    finally:
                        settled.set()

                def start():
                    try:
                        task.append(self.loop.create_task(coroutine))
                        task[0].add_done_callback(complete)
                    except BaseException as error:
                        coroutine.close()
                        result.set_exception(error)
                        settled.set()

                self.loop.call_soon_threadsafe(start)
            except BaseException:
                coroutine.close()
                raise
            try:
                return result.result()
            except BaseException:
                self.loop.call_soon_threadsafe(lambda: task[0].cancel() if task else None)
                if not settled.wait(5):
                    raise RuntimeError('Cancelled Hermes inference operation remains owned')
                if discard is not None and result.exception() is None:
                    self.run(discard(result.result()))
                raise

        def close(self):
            with self.lock:
                if self.closed:
                    return
                if self.thread is None:
                    self.closed = True
                    return
                if self.failure is not None and not self.thread.is_alive():
                    self.closed = True
                    return
            self.run(sync_backend.close())
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join(5)
            if self.thread.is_alive():
                raise RuntimeError('Hermes inference pipe loop is still running')
            self.closed = True

    blocking = BlockingLoop()
    sync_backend = PipeBackend()

    class SyncStream:
        def __init__(self, stream): self.stream = stream
        def read(self, max_bytes, timeout=None): return blocking.run(self.stream.read(max_bytes, timeout))
        def write(self, buffer, timeout=None): return blocking.run(self.stream.write(buffer, timeout))
        def close(self): return blocking.run(self.stream.aclose())
        def start_tls(self, *args, **kwargs): return blocking.run(self.stream.start_tls(*args, **kwargs))
        def get_extra_info(self, name): return self.stream.get_extra_info(name)

    class SyncBackend:
        def connect_tcp(self, *args, **kwargs):
            stream = blocking.run(sync_backend.connect_tcp(*args, **kwargs), discard=lambda value: value.aclose())
            return SyncStream(stream)
        def connect_unix_socket(self, *args, **kwargs):
            raise httpcore.ConnectError('Unix sockets are not a contained inference pipe transport')
        def sleep(self, seconds): time.sleep(seconds)

    def check_request(request):
        if (request.url.scheme != 'http' or request.url.host != '127.0.0.1'
                or request.url.port != declared_port or request.url.userinfo):
            raise httpx.UnsupportedProtocol('Request is outside the declared inference pipe')

    class SyncTransport(httpx.HTTPTransport):
        def __init__(self):
            self._pool = httpcore.ConnectionPool(network_backend=SyncBackend(), max_connections=1000,
                max_keepalive_connections=50, keepalive_expiry=20.0, retries=0)
        def handle_request(self, request):
            check_request(request)
            return super().handle_request(request)

    class AsyncTransport(httpx.AsyncHTTPTransport):
        def __init__(self):
            self.backend = PipeBackend()
            self._pool = httpcore.AsyncConnectionPool(network_backend=self.backend, max_connections=100,
                max_keepalive_connections=20, keepalive_expiry=20.0, retries=0)
        async def handle_async_request(self, request):
            check_request(request)
            return await super().handle_async_request(request)
        async def aclose(self):
            await super().aclose()
            await self.backend.close()

    def build_client(url='', *, async_mode=False, verify=True):
        if url.rstrip('/') != base_url:
            raise RuntimeError('Hermes inference base URL does not match its declared pipe')
        timeout = httpx.Timeout(connect=15.0, read=None, write=15.0, pool=10.0)
        if async_mode:
            return httpx.AsyncClient(transport=AsyncTransport(), timeout=timeout, trust_env=False)
        transport = bootstrap._get_shared_transport(('native-inference-pipe', declared_port), SyncTransport)
        return httpx.Client(transport=bootstrap._shared_transport_cls()(transport), timeout=timeout, trust_env=False)

    bootstrap.build_keepalive_http_client = build_client
    atexit.register(blocking.close)
    bootstrap._native_pipe_backend = (declared_port, build_client, blocking.close)
    return bootstrap._native_pipe_backend[1:]

if 'NEMOCLAW_HERMES_INFERENCE_PIPE_PORT' in os.environ:
    _install_native_inference_pipe(os.environ['NEMOCLAW_HERMES_INFERENCE_PIPE_PORT'])`,
  ];
}
