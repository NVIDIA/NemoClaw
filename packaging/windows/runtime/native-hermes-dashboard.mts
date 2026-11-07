// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The dashboard is Hermes's shipped SPA and ConPTY-backed JavaScript TUI.
// Its server and children use the same contained state and broker as the console.
export function hermesDashboardPythonSource(): string[] {
  return [
    String.raw`def _install_native_dashboard_pipe(port_text):
    import asyncio
    from hermes_cli import web_server, web_server_chat
    if sys.platform != 'win32':
        raise RuntimeError('Hermes dashboard pipes require native Windows')
    if not port_text.isascii() or not port_text.isdecimal() or not 1 <= int(port_text) <= 65535:
        raise RuntimeError('The declared Hermes dashboard pipe port is invalid')
    port = int(port_text)
    pipe_name = '\\\\.\\pipe\\LOCAL\\OpenShell-Loopback-' + str(port)
    marker = object()
    build_server = web_server._build_uvicorn_server
    read_port = web_server._read_bound_port
    peer_reason = web_server_chat._ws_client_reason

    class PipeListener:
        sockets = ()

        def __init__(self, listener):
            self.listener = listener
            self.accept_closed = None

        def close(self):
            if not self.listener.closed():
                self.accept_closed = self.listener._accept_pipe_future
                self.listener.close()

        async def wait_closed(self):
            if not self.listener.closed():
                raise RuntimeError('Hermes dashboard pipe is still accepting connections')
            if self.accept_closed is not None:
                try:
                    await self.accept_closed
                except asyncio.CancelledError:
                    pass

    def build_pipe_server(host, requested_port, *, ssh_isolated=False):
        if host != '127.0.0.1' or requested_port != 0 or ssh_isolated:
            raise RuntimeError('Hermes dashboard pipe requires its private local configuration')
        config, original = build_server(host, requested_port, ssh_isolated=False)
        original_app = config.app

        async def pipe_app(scope, receive, send):
            # Only this listener can stamp this process-local object; headers cannot supply it.
            scope = dict(scope)
            scope['_nemoclaw_dashboard_pipe'] = marker
            await original_app(scope, receive, send)

        config.app = pipe_app

        class PipeServer(type(original)):
            async def startup(self, sockets=None):
                if sockets is not None:
                    raise RuntimeError('Hermes dashboard pipe cannot accept TCP sockets')
                await self.lifespan.startup()
                if self.lifespan.should_exit:
                    self.should_exit = True
                    return
                loop = asyncio.get_running_loop()

                class AcceptedPipeProtocol(config.http_protocol_class):
                    def connection_made(self, transport):
                        super().connection_made(transport)
                        self._native_accept_pending = True

                    def data_received(self, data):
                        if not data:
                            return
                        if self._native_accept_pending:
                            self._native_accept_pending = False
                            # Ordinary in-container HTTP/WebSocket clients share this
                            # listener. Only the private relay requests an acknowledgment.
                            if data[0] == 0:
                                # Proactor has replenished its next accept instance.
                                self.transport.write(b'\x00')
                                data = data[1:]
                        if data:
                            super().data_received(data)

                def create_protocol():
                    return AcceptedPipeProtocol(
                        config=config, server_state=self.server_state,
                        app_state=self.lifespan.state, _loop=loop)

                try:
                    listeners = await loop.start_serving_pipe(create_protocol, pipe_name)
                    self.servers = [PipeListener(listener) for listener in listeners]
                    if not self.servers:
                        raise RuntimeError('Hermes dashboard pipe did not bind')
                except BaseException:
                    await self.lifespan.shutdown()
                    raise
                self.started = True

        server = PipeServer(config)
        server._nemoclaw_dashboard_pipe = marker
        return config, server

    def pipe_port(server, fallback):
        if getattr(server, '_nemoclaw_dashboard_pipe', None) is not marker:
            return read_port(server, fallback)
        if not server.started or not server.servers or any(item.listener.closed() for item in server.servers):
            raise RuntimeError('Hermes dashboard pipe is not listening')
        # This is a declared pipe identifier, never a claim of a bound TCP port.
        return port

    def pipe_peer_reason(ws):
        reason = peer_reason(ws)
        if (reason == 'missing_or_empty_peer bound=127.0.0.1' and ws.client is None
                and ws.scope.get('_nemoclaw_dashboard_pipe') is marker):
            return None
        return reason

    def run_pipe_server(serve, config, host, requested_port):
        if host != '127.0.0.1' or requested_port != 0:
            raise RuntimeError('Hermes dashboard pipe cannot start a TCP listener')

        def loop_factory():
            loop = _new_native_hermes_loop()
            asyncio.set_event_loop(loop)
            return loop

        try:
            with asyncio.Runner(loop_factory=loop_factory) as runner:
                runner.run(serve())
        except KeyboardInterrupt:
            return
        finally:
            asyncio.set_event_loop(None)

    web_server._build_uvicorn_server = build_pipe_server
    web_server._read_bound_port = pipe_port
    web_server._run_serve = run_pipe_server
    web_server_chat._ws_client_reason = pipe_peer_reason

if 'NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT' in os.environ:
    _install_native_dashboard_pipe(os.environ['NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT'])`,
    String.raw`def _install_native_dashboard_pty():
    from hermes_cli import win_pty_bridge
    from winpty import PtyProcess
    if sys.platform != 'win32':
        raise RuntimeError('Hermes dashboard terminals require native Windows')

    class NativePtyProcess(PtyProcess):
        def __init__(self, pty):
            # PtyProcess.__init__ uses a TCP reader thread, which native MXC denies.
            # WinPtyBridge already reads off-loop; use the underlying ConPTY directly.
            self.pty = pty
            self.pid = pty.pid
            self.closed = False
            self.flag_eof = False
            self.delayafterterminate = 0.1

        def read(self, size=1024):
            if self.closed:
                raise EOFError('Pty is closed')
            data = self.pty.read(size, blocking=False)
            if not data and self.pty.iseof():
                self.flag_eof = True
                raise EOFError('Pty is closed')
            return data

        def isalive(self):
            return not self.closed and self.pty.isalive()

        def terminate(self, force=False):
            stopped = super().terminate(force)
            if stopped:
                self.closed = True
                self.pty = None
            return stopped

        def close(self, force=False):
            if not self.closed and not self.terminate(force):
                raise OSError('Could not terminate the Hermes terminal child')

    # Keep upstream spawn quoting, environment, writes, resize and termination.
    # Replace only this dashboard's adapter; other pywinpty consumers are unchanged.
    win_pty_bridge.PtyProcess = NativePtyProcess

_install_native_dashboard_pty()`,
    "from pathlib import Path",
    "from hermes_cli.win_pty_bridge import WinPtyBridge",
    "if not WinPtyBridge.is_available(): raise RuntimeError('Hermes native ConPTY is unavailable')",
    "_source = Path(os.environ['NEMOCLAW_HERMES_SOURCE_ROOT'])",
    "_package = _source / 'hermes_cli'",
    "if not (_source / 'ui-tui' / 'dist' / 'entry.js').is_file(): raise RuntimeError('The bundled Hermes TUI is missing')",
    "os.environ['HERMES_TUI_DIR'] = str(_source / 'ui-tui')",
    "if not (_package / 'web_dist' / 'index.html').is_file(): raise RuntimeError('The bundled Hermes dashboard is missing')",
    "os.environ['HERMES_WEB_DIST'] = str(_package / 'web_dist')",
    "if not os.environ.get('HERMES_NODE'): raise RuntimeError('The installed canonical Hermes Node path is missing')",
    "os.environ['HERMES_PYTHON'] = sys.executable",
    "os.environ['HERMES_SKIP_NODE_BOOTSTRAP'] = '1'",
    "from hermes_cli.main import main",
    "sys.argv = [sys.argv[0], 'dashboard', '--host', '127.0.0.1', '--port', '0', '--no-open', '--skip-build']",
    "main()",
  ];
}
