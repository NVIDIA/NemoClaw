// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function hermesBrowserPipePythonSource(): string[] {
  return [
    String.raw`def _install_native_browser_pipe(port_text, browser_path):
    import asyncio
    import re
    from urllib.parse import urlsplit
    import websockets
    from websockets.asyncio.client import ClientConnection, connect as WebSocketConnect
    from websockets.uri import parse_uri
    from cdp_use import client as cdp_client

    if sys.platform != 'win32' or websockets.__version__ != '15.0.1':
        raise RuntimeError('Hermes browser pipes require native Windows and pinned websockets 15.0.1')
    if not re.fullmatch(r'[1-9][0-9]{0,4}', port_text) or int(port_text) > 65535:
        raise RuntimeError('The declared Hermes browser pipe port is invalid')
    if not re.fullmatch(r'/devtools/browser/[A-Za-z0-9-]{1,128}', browser_path):
        raise RuntimeError('The declared Hermes browser CDP path is invalid')
    endpoint = 'ws://127.0.0.1:' + port_text + browser_path
    existing = getattr(cdp_client, '_native_browser_pipe', None)
    if existing is not None:
        if existing[0] != endpoint:
            raise RuntimeError('Hermes browser pipe cannot change after bootstrap')
        return existing[1:]
    pipe_name = '\\\\.\\pipe\\LOCAL\\OpenShell-Loopback-' + port_text
    owners = set()

    class BrowserPipeConnection(ClientConnection):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.native_ready = asyncio.get_running_loop().create_future()
            self.native_transport = None

        def connection_made(self, transport):
            self.native_transport = transport
            super().connection_made(transport)
            self.native_ready.set_result(None)

    class BrowserPipeConnect(WebSocketConnect):
        def __init__(self, uri, **kwargs):
            if not isinstance(uri, str) or uri != endpoint:
                raise RuntimeError('Browser CDP endpoint does not match its declared pipe')
            target = urlsplit(uri)
            if target.username or target.password or target.query or target.fragment:
                raise RuntimeError('Browser CDP endpoint contains an unsupported override')
            # Keep protocol, limits and timeouts from the pinned client. No proxy,
            # socket, TLS, alternate protocol factory or ambient network connector.
            if any(name in kwargs for name in ('proxy', 'create_connection', 'sock', 'host', 'port', 'unix',
                    'path', 'ssl', 'server_hostname', 'local_addr', 'family', 'flags')):
                raise RuntimeError('Browser CDP pipe has conflicting transport settings')
            super().__init__(uri, proxy=None, create_connection=BrowserPipeConnection, **kwargs)
            if self.connection_kwargs:
                raise RuntimeError('Browser CDP pipe has unsupported connection settings')
            self._native_connection = None

        async def _close_failed_connection(self):
            connection = self._native_connection
            if connection is None:
                return
            transport = connection.native_transport
            if transport is None:
                owners.discard(connection)
                return
            transport.abort()
            # Cancellation may interrupt this wait. Ownership remains in the
            # registry until the actual protocol observes connection_lost.
            await asyncio.wait_for(asyncio.shield(connection.connection_lost_waiter), 5)

        async def create_connection(self):
            if self.uri != endpoint:
                raise RuntimeError('Browser CDP pipe cannot follow a changed endpoint')
            loop = asyncio.get_running_loop()
            connect_pipe = getattr(loop, 'create_pipe_connection', None)
            if not callable(connect_pipe):
                raise RuntimeError('Browser CDP pipes require a Windows Proactor loop')
            connection = self.protocol_factory(parse_uri(self.uri))
            self._native_connection = connection
            owners.add(connection)
            connection.connection_lost_waiter.add_done_callback(lambda _: owners.discard(connection))
            try:
                transport, _ = await connect_pipe(lambda: connection, pipe_name)
                connection.native_transport = transport
                # Windows returns the pipe before its scheduled connection_made
                # initializes the WebSocket protocol. Retain custody while waiting.
                await asyncio.shield(connection.native_ready)
                return connection
            except BaseException:
                await self._close_failed_connection()
                raise

        def process_redirect(self, error):
            return error

        async def __await_impl__(self):
            try:
                return await super().__await_impl__()
            except BaseException:
                await self._close_failed_connection()
                raise

    async def close_owned():
        for connection in list(owners):
            transport = connection.native_transport
            if transport is not None:
                transport.abort()
            else:
                raise RuntimeError('Browser CDP pipe connection is still pending')
        if owners:
            await asyncio.wait_for(asyncio.gather(*(asyncio.shield(connection.connection_lost_waiter)
                                                   for connection in list(owners))), 5)
        # An already-completed waiter can return before its scheduled registry
        # callback runs. Only the successful protocol close notification releases
        # custody; a cancelled or failed waiter is not closure evidence.
        for connection in list(owners):
            waiter = connection.connection_lost_waiter
            if waiter.done() and not waiter.cancelled() and waiter.exception() is None:
                owners.discard(connection)
        if owners:
            raise RuntimeError('Browser CDP pipe closure remains unconfirmed')

    class BrowserWebSockets:
        connect = BrowserPipeConnect

        def __getattr__(self, name):
            return getattr(websockets, name)

    cdp_client.websockets = BrowserWebSockets()
    cdp_client._native_browser_pipe = (endpoint, BrowserPipeConnect, close_owned, owners)
    return cdp_client._native_browser_pipe[1:]`,
  ];
}
