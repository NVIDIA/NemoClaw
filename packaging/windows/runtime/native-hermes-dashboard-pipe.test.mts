// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermesDashboardPythonSource } from "./native-hermes-dashboard.mts";
import { renderFactory, staticWorkerSource } from "../distribution/build-native-workers.mts";

// These are network-free adapter tests, not Windows pipe or installed UI qualification.
const fixture = String.raw`
import asyncio
import sys
import types
from types import SimpleNamespace as NS

events = []
scopes = []
async def app(scope, receive, send):
    scopes.append(scope)
    await send({'type': 'application-result', 'headers': scope.get('headers')})

class Server:
    def __init__(self, config):
        self.config = config
        self.server_state = object()
        self.started = False
        self.should_exit = False
        self.servers = []

class Lifespan:
    should_exit = False
    state = {'state': object()}
    async def startup(self): events.append('startup')
    async def shutdown(self): events.append('shutdown')

configs = []
def build(host, port, *, ssh_isolated):
    events.append(('build', host, port, ssh_isolated))
    config = NS(app=app, http_protocol_class=lambda **kwargs: kwargs,
                proxy_headers=False, forwarded_allow_ips='127.0.0.1',
                ws_ping_interval=None, ws_ping_timeout=None, ws_max_size=1048576)
    configs.append(config)
    return config, Server(config)

web = types.ModuleType('hermes_cli.web_server')
web._build_uvicorn_server = build
web._read_bound_port = lambda server, fallback: fallback
web._run_serve = object()
chat = types.ModuleType('hermes_cli.web_server_chat')
chat._ws_client_reason = lambda ws: ws.reason
package = types.ModuleType('hermes_cli')
package.web_server = web
package.web_server_chat = chat
sys.modules['hermes_cli'] = package
sys.modules['hermes_cli.web_server'] = web
sys.modules['hermes_cli.web_server_chat'] = chat

class Listener:
    def __init__(self):
        self._closed = False
        self._accept_pipe_future = asyncio.get_running_loop().create_future()
        self.accept = self._accept_pipe_future
    def closed(self): return self._closed
    def close(self):
        self._closed = True
        self._accept_pipe_future.cancel()
        self._accept_pipe_future = None
        events.append('closed')

async def scenario(*, bind_error=None, empty=False, lifespan_exit=False):
    loop = asyncio.get_running_loop()
    listeners = []
    protocols = []
    async def bind(factory, name):
        events.append(('bind', name))
        if bind_error: raise bind_error
        if empty: return []
        listeners.append(Listener())
        protocols.append(factory())
        return listeners
    loop.start_serving_pipe = bind
    config, server = web._build_uvicorn_server('127.0.0.1', 0)
    server.lifespan = Lifespan()
    server.lifespan.should_exit = lifespan_exit
    await server.startup()
    return config, server, listeners, protocols

def rejects(action, message):
    try: action()
    except RuntimeError as error:
        assert message in str(error), str(error)
    else: raise AssertionError('Expected a fail-closed error: ' + message)

namespace = {'sys': NS(platform='win32'), 'os': NS(environ={}), '_new_native_hermes_loop': asyncio.new_event_loop}
`;

function check(python: string) {
  const adapter = hermesDashboardPythonSource()[0];
  const script =
    fixture +
    `\nexec(${JSON.stringify(adapter)}, namespace)\ninstall = namespace['_install_native_dashboard_pipe']\n` +
    python;
  const result = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-B", "-c", script],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result, "");
}

test("prebuilt workers compile the dashboard adapter only in dashboard variants without runtime source writes", () => {
  const source = renderFactory(
    fileURLToPath(new URL("./", import.meta.url)),
    "run-installed-native-console-agent.mts",
    "interactiveWorkloadSource",
  );
  const assets = new Map<string, string>();
  const bundled = staticWorkerSource("interactive", source, assets);
  assert(!bundled.includes("writeFileSync(runner"));
  assert.equal(assets.size, 4);
  for (const [name, content] of assets) {
    assert.equal(
      content.includes("def _install_native_dashboard_pipe"),
      name.includes("dashboard"),
    );
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", "-c", "import sys; compile(sys.stdin.read(), '<prebuilt-worker>', 'exec')"],
      {
        input: content,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
  }
});

test("dashboard pipe rejects unsupported platforms and malformed declarations before replacing hooks", () => {
  check(String.raw`
namespace['sys'].platform = 'linux'
rejects(lambda: install('8123'), 'native Windows')
namespace['sys'].platform = 'win32'
for value in ('', '0', '65536', '-1', '1.5', ' 12', '12 ', '１２', 'pipe', '12/other'):
    rejects(lambda: install(value), 'port is invalid')
assert web._build_uvicorn_server is build
assert events == []
`);
});

test("dashboard pipe binds the declared LOCAL endpoint and retains Uvicorn protocol configuration", () => {
  check(String.raw`
install('8123')
async def run():
    config, server, listeners, protocols = await scenario()
    assert events == [('build', '127.0.0.1', 0, False), 'startup', ('bind', r'\\.\pipe\LOCAL\OpenShell-Loopback-8123')]
    assert server.started and not server.should_exit
    assert config is configs[0]
    assert (config.proxy_headers, config.forwarded_allow_ips, config.ws_ping_interval,
            config.ws_ping_timeout, config.ws_max_size) == (False, '127.0.0.1', None, None, 1048576)
    assert protocols[0] == {'config': config, 'server_state': server.server_state,
                            'app_state': server.lifespan.state, '_loop': asyncio.get_running_loop()}
    assert server.servers[0].sockets == ()
    assert web._read_bound_port(server, 0) == 8123
asyncio.run(run())
`);
});

test("dashboard pipe refuses TCP, public, fixed-port and SSH-isolated listeners", () => {
  check(String.raw`
install('8123')
for args in (('0.0.0.0', 0), ('127.0.0.1', 8123), ('localhost', 0)):
    rejects(lambda: web._build_uvicorn_server(*args), 'private local')
rejects(lambda: web._build_uvicorn_server('127.0.0.1', 0, ssh_isolated=True), 'private local')
async def run():
    _, server = web._build_uvicorn_server('127.0.0.1', 0)
    server.lifespan = Lifespan()
    try: await server.startup(sockets=[])
    except RuntimeError as error: assert 'TCP sockets' in str(error)
    else: raise AssertionError('TCP accepted')
    assert 'startup' not in events and not server.started
asyncio.run(run())
`);
});

test("dashboard readiness requires a live pipe and leaves unrelated server readiness alone", () => {
  check(String.raw`
install('8123')
_, server = web._build_uvicorn_server('127.0.0.1', 0)
rejects(lambda: web._read_bound_port(server, 0), 'not listening')
assert web._read_bound_port(Server(None), 9191) == 9191
async def run():
    _, server, _, _ = await scenario()
    server.servers[0].close()
    rejects(lambda: web._read_bound_port(server, 0), 'not listening')
    await server.servers[0].wait_closed()
asyncio.run(run())
`);
});

test("dashboard bind errors and cancellation shut down lifespan without readiness or TCP fallback", () => {
  check(String.raw`
install('8123')
async def run():
    for error in (OSError('denied'), asyncio.CancelledError()):
        events.clear()
        try: await scenario(bind_error=error)
        except BaseException as caught: assert caught is error
        else: raise AssertionError('bind failure swallowed')
        assert events[-1] == 'shutdown'
        assert sum(isinstance(event, tuple) and event[0] == 'bind' for event in events) == 1
    events.clear()
    try: await scenario(empty=True)
    except RuntimeError as error: assert 'did not bind' in str(error)
    else: raise AssertionError('missing listener accepted')
    assert events[-1] == 'shutdown'
asyncio.run(run())
`);
});

test("dashboard lifespan rejection never opens a pipe", () => {
  check(String.raw`
install('8123')
async def run():
    _, server, listeners, protocols = await scenario(lifespan_exit=True)
    assert server.should_exit and not server.started
    assert listeners == protocols == []
    assert events == [('build', '127.0.0.1', 0, False), 'startup']
asyncio.run(run())
`);
});

test("dashboard pipe shutdown waits for accept cancellation and is idempotent", () => {
  check(String.raw`
install('8123')
async def run():
    _, server, listeners, _ = await scenario()
    wrapper = server.servers[0]
    try: await wrapper.wait_closed()
    except RuntimeError as error: assert 'still accepting' in str(error)
    else: raise AssertionError('open listener claimed closed')
    wrapper.close()
    wrapper.close()
    await wrapper.wait_closed()
    assert listeners[0].accept.cancelled()
    assert events.count('closed') == 1
asyncio.run(run())
`);
});

test("only pipe-delivered scopes receive local-peer identity; application headers and guards remain intact", () => {
  check(String.raw`
install('8123')
async def run():
    config, _, _, _ = await scenario()
    messages = []
    async def send(message): messages.append(message)
    scope = {'type': 'websocket', 'client': None, 'headers': [(b'host', b'evil.invalid'), (b'origin', b'https://evil.invalid')],
             '_nemoclaw_dashboard_pipe': 'spoofed'}
    await config.app(scope, None, send)
    assert scopes[0] is not scope and scope['_nemoclaw_dashboard_pipe'] == 'spoofed'
    assert scopes[0]['headers'] is scope['headers']
    assert messages == [{'type': 'application-result', 'headers': scope['headers']}]
    missing = 'missing_or_empty_peer bound=127.0.0.1'
    assert chat._ws_client_reason(NS(reason=missing, client=None, scope=scopes[0])) is None
    for spoof in ({}, scope, {'_nemoclaw_dashboard_pipe': object()}):
        assert chat._ws_client_reason(NS(reason=missing, client=None, scope=spoof)) == missing
    for denial in ('peer_not_loopback', 'host_mismatch', 'origin_mismatch', 'invalid_token', 'missing_or_empty_peer bound=other'):
        assert chat._ws_client_reason(NS(reason=denial, client=None, scope=scopes[0])) == denial
    assert chat._ws_client_reason(NS(reason=missing, client=NS(host='remote'), scope=scopes[0])) == missing
    assert chat._ws_client_reason(NS(reason=None, client=None, scope={})) is None
asyncio.run(run())
`);
});

test("dashboard runner uses a scoped Proactor loop and does not change the global event-loop policy", () => {
  check(String.raw`
install('8123')
policy = asyncio.get_event_loop_policy()
factory = asyncio.new_event_loop
asyncio.ProactorEventLoop = factory
async def serve():
    events.append(asyncio.get_running_loop())
web._run_serve(serve, None, '127.0.0.1', 0)
assert len(events) == 1 and events[0].is_closed()
assert asyncio.get_event_loop_policy() is policy
try: asyncio.get_event_loop()
except RuntimeError: pass
else: raise AssertionError('A closed event loop remained installed')
rejects(lambda: web._run_serve(serve, None, '0.0.0.0', 0), 'TCP listener')
async def interrupt(): raise KeyboardInterrupt()
web._run_serve(interrupt, None, '127.0.0.1', 0)
async def failure(): raise RuntimeError('real failure')
rejects(lambda: web._run_serve(failure, None, '127.0.0.1', 0), 'real failure')
`);
});
