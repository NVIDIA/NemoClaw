// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermesBrowserPipePythonSource } from "./native-hermes-browser-pipe.mts";
import { hermesBrowserBootstrapPythonSource } from "./native-hermes-browser-bootstrap.mts";
import { renderFactory } from "../distribution/build-native-workers.mts";

const dependencies = process.env.NEMOCLAW_HERMES_PYTHON_TEST_DEPS;
const options = {
  skip:
    process.platform === "win32"
      ? "Unix protocol controls run in isolated WSL"
      : dependencies
        ? false
        : "Pinned Hermes transport fixtures are not configured",
};
const fixture = String.raw`
import asyncio, contextlib, json, logging, os, pathlib, sys, tempfile
from types import SimpleNamespace as NS
import websockets
from websockets.asyncio.server import unix_serve
from websockets.exceptions import InvalidStatus
from cdp_use import client as cdp_client
assert websockets.__version__ == '15.0.1'
logging.disable(logging.CRITICAL)
original_connect = websockets.connect
namespace = {'sys': NS(platform='win32')}
exec(adapter_source, namespace)
install = namespace['_install_native_browser_pipe']
Connect, close_owned, owners = install('8124', '/devtools/browser/session-1')
endpoint = 'ws://127.0.0.1:8124/devtools/browser/session-1'
calls = []
requests = []
messages = []
response = lambda message: {'fixture': True}
transports = []
before_delay = after_delay = lost_delay = 0
hold_lost = False
defer_made = False
cancel_before_made = False
pending_lost = []
lost_pending = None
status = 101
bound = None

@contextlib.asynccontextmanager
async def peer():
    global bound, lost_pending
    loop = asyncio.get_running_loop()
    bound = asyncio.Event()
    lost_pending = asyncio.Event()
    original_tcp = loop.create_connection
    original_pipe = getattr(loop, 'create_pipe_connection', None)
    async def deny_tcp(*args, **kwargs): raise AssertionError('TCP fallback')
    loop.create_connection = deny_tcp
    with tempfile.TemporaryDirectory(prefix='hermes-cdp-') as root:
        address = str(pathlib.Path(root) / 'ws.sock')
        async def connect_pipe(factory, name):
            assert name == r'\\.\pipe\LOCAL\OpenShell-Loopback-8124'
            calls.append(name)
            if before_delay: await asyncio.sleep(before_delay)
            connection = factory()
            made = connection.connection_made
            if defer_made:
                connection.connection_made = lambda transport: None
            lost = connection.connection_lost
            if hold_lost:
                def defer_lost(error):
                    pending_lost.append((lost, error))
                    lost_pending.set()
                connection.connection_lost = defer_lost
            elif lost_delay:
                connection.connection_lost = lambda error: loop.call_later(lost_delay, lost, error)
            result = await loop.create_unix_connection(lambda: connection, address)
            if defer_made:
                # Proactor create_pipe_connection returns before connection_made.
                connection.connection_made = made
                if cancel_before_made:
                    loop.call_soon(asyncio.current_task().cancel)
                loop.call_soon(made, result[0])
            transports.append(result[0])
            bound.set()
            if after_delay: await asyncio.sleep(after_delay)
            return result
        loop.create_pipe_connection = connect_pipe
        async def request(connection, request):
            requests.append(request)
            if status != 101:
                response = connection.respond(status, 'test control')
                if status == 302: response.headers['Location'] = 'ws://foreign.invalid:8124/devtools/browser/session-1'
                return response
        async def handle(connection):
            try:
                async for raw in connection:
                    message = json.loads(raw)
                    messages.append(message)
                    await connection.send(json.dumps({'id': message['id'], 'result': response(message)}))
            except websockets.exceptions.ConnectionClosed:
                pass
        try:
            async with unix_serve(handle, address, process_request=request):
                yield
        finally:
            await close_owned()
            loop.create_connection = original_tcp
            if original_pipe is None: del loop.create_pipe_connection
            else: loop.create_pipe_connection = original_pipe
`;

function check(body: string) {
  assert(dependencies);
  const source =
    `import sys\nsys.path.insert(0, ${JSON.stringify(dependencies)})\nadapter_source = ${JSON.stringify(hermesBrowserPipePythonSource()[0])}\n` +
    fixture +
    "\n" +
    body;
  const result = spawnSync("python3", ["-I", "-B", "-"], {
    input: source,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? result.signal));
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
}

test("browser pipe source and staged bootstrap compile without native imports", () => {
  const bootstrap = hermesBrowserBootstrapPythonSource();
  assert.equal(
    renderFactory(
      fileURLToPath(new URL("./", import.meta.url)),
      "native-hermes-browser-bootstrap.mts",
      "hermesBrowserBootstrapPythonSource",
    ),
    bootstrap,
  );
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-B", "-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    { input: hermesBrowserPipePythonSource()[0], encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const compiled = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-B", "-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    { input: bootstrap, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
});

test("browser bootstrap requires exact versions and selected Edge endpoint before installing its loop", () => {
  const checks = String.raw`
import ast, asyncio, importlib.metadata, os, sys
from types import SimpleNamespace as NS
tree = ast.parse(source)
activation = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_activate_native_browser')
calls = []
policy = asyncio.get_event_loop_policy()
environment = {'NEMOCLAW_HERMES_BROWSER_PIPE_PORT': '8124', 'NEMOCLAW_BROWSER_CDP_PATH': '/devtools/browser/session-1', 'BU_CDP_WS': 'ws://127.0.0.1:8124/devtools/browser/session-1', 'NEMOCLAW_AGENT_SESSION_ID': '0123456789'}
namespace = {'sys': NS(platform='win32', version_info=(3,11,16)), 'os': NS(environ=environment), '_install_native_browser_pipe': lambda *args: calls.append(args), '_install_native_browser_ipc': lambda *args: calls.append(args), '_new_native_hermes_loop': policy.new_event_loop}
exec(compile(ast.Module(body=[activation], type_ignores=[]), '<bootstrap-activation>', 'exec'), namespace)
version = importlib.metadata.version
versions = {'cdp-use': '1.4.5', 'browser-harness': '0.1.13'}
importlib.metadata.version = lambda name: versions[name]
try:
    for field, value in [('BU_CDP_WS', 'ws://foreign.invalid/a'), ('BU_CDP_URL', 'http://127.0.0.1:8124'), ('BROWSER_CDP_URL', 'ws://foreign.invalid/a')]:
        original = environment.get(field)
        environment[field] = value
        try: namespace['_activate_native_browser']()
        except RuntimeError: pass
        else: raise AssertionError(field)
        if original is None: environment.pop(field)
        else: environment[field] = original
    for package in versions:
        original = versions[package]
        versions[package] = 'other'
        try: namespace['_activate_native_browser']()
        except RuntimeError: pass
        else: raise AssertionError(package)
        versions[package] = original
    namespace['sys'].version_info = (3,12,0)
    try: namespace['_activate_native_browser']()
    except RuntimeError: pass
    else: raise AssertionError('version')
    namespace['sys'].version_info = (3,11,16)
    assert not calls and asyncio.get_event_loop_policy() is policy
    namespace['_activate_native_browser']()
    assert calls == [('8124', '/devtools/browser/session-1'), ('0123456789',)]
    assert asyncio.get_event_loop_policy() is not policy
    loop = asyncio.new_event_loop()
    loop.close()
finally:
    asyncio.set_event_loop_policy(policy)
    importlib.metadata.version = version
`;
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-B", "-"], {
    input: `source = ${JSON.stringify(hermesBrowserBootstrapPythonSource())}\n` + checks,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("browser pipe validates declaration and retains one scoped CDP adapter", options, () => {
  check(String.raw`
assert install('8124', '/devtools/browser/session-1') == (Connect, close_owned, owners)
assert websockets.connect is original_connect
assert cdp_client.websockets.connect is Connect
assert cdp_client.websockets.exceptions is websockets.exceptions
for port, path in [('0', '/devtools/browser/a'), ('65536', '/devtools/browser/a'), ('08124', '/devtools/browser/a'), ('8124', '/devtools/page/a'), ('8124', '/devtools/browser/a?x'), ('8124', '/devtools/browser/../a'), ('8125', '/devtools/browser/session-1')]:
    try: install(port, path)
    except RuntimeError: pass
    else: raise AssertionError((port, path))
namespace['sys'].platform = 'linux'
try: install('8124', '/devtools/browser/session-1')
except RuntimeError: pass
else: raise AssertionError('unsupported platform')
assert not owners
`);
});

test("browser pipe rejects endpoint and connector overrides without a connection", options, () => {
  check(String.raw`
for value in [endpoint.replace('127.0.0.1', 'localhost'), endpoint.replace('8124', '8125'), endpoint.replace('ws:', 'wss:'), endpoint + '?x', endpoint + '#x', endpoint.replace('session-1', 'other'), endpoint.replace('127.0.0.1', 'u:p@127.0.0.1')]:
    try: Connect(value)
    except RuntimeError: pass
    else: raise AssertionError(value)
for key in ('proxy', 'create_connection', 'sock', 'host', 'port', 'unix', 'path', 'ssl', 'server_hostname', 'local_addr', 'family', 'flags', 'unsupported'):
    try: Connect(endpoint, **{key: None})
    except RuntimeError: pass
    else: raise AssertionError(key)
assert not owners and not calls
`);
});

test(
  "pinned CDP client exchanges real protocol messages and preserves headers and closure",
  options,
  () => {
    check(String.raw`
async def main():
    async with peer():
        client = cdp_client.CDPClient(endpoint, additional_headers={'X-Session-Control': 'fixture'}, max_ws_frame_size=4096)
        await client.start()
        assert len(owners) == 1
        assert await asyncio.wait_for(client.send_raw('Browser.getVersion', session_id='session-child'), 2) == {'fixture': True}
        assert messages == [{'id': 1, 'method': 'Browser.getVersion', 'params': {}, 'sessionId': 'session-child'}]
        assert requests[0].path == '/devtools/browser/session-1'
        assert requests[0].headers['Host'] == '127.0.0.1:8124'
        assert requests[0].headers['X-Session-Control'] == 'fixture'
        await client.stop()
        assert not owners and all(transport.is_closing() for transport in transports)
asyncio.run(main())
`);
  },
);

test(
  "pinned Browser Harness attaches its declared browser through the pipe and shuts down",
  options,
  () => {
    check(String.raw`
import hashlib
defer_made = True
with tempfile.TemporaryDirectory(prefix='hermes-harness-') as state:
    os.environ.update(BH_RUNTIME_DIR=state, BH_TMP_DIR=state, BH_AGENT_WORKSPACE=state,
                     BU_CDP_WS=endpoint, BH_TAB_MARKER='0', ANONYMIZED_TELEMETRY='false')
    for name in ('BU_CDP_URL', 'BU_BROWSER_ID', 'BU_NAME'):
        os.environ.pop(name, None)
    import browser_harness
    daemon_file = pathlib.Path(browser_harness.__file__).with_name('daemon.py')
    assert hashlib.sha256(daemon_file.read_bytes()).hexdigest() == '7f05f904e62af8c07153c34a1fd3d334acf5c5aded8d0ddab974596bb50a8c97'
    from browser_harness import daemon
    assert daemon.BROWSER_KIND == 'cdp'
    target = {'targetId': 'fixture-page', 'type': 'page', 'url': 'about:blank', 'title': ''}
    def response(message):
        method = message['method']
        if method == 'Target.getTargets': return {'targetInfos': [target]}
        if method == 'Target.createTarget':
            assert message['params'] == {'url': 'about:blank', 'background': True}
            return {'targetId': target['targetId']}
        if method == 'Target.attachToTarget':
            assert message['params'] == {'targetId': target['targetId'], 'flatten': True}
            return {'sessionId': 'fixture-session'}
        if method == 'Target.getTargetInfo': return {'targetInfo': target}
        if method in ('Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable'):
            assert message['sessionId'] == 'fixture-session'
            return {}
        raise AssertionError('Unexpected CDP method: ' + method)

    async def main():
        for name in ('default', 'nc-personal-fixture'):
            daemon.NAME = name
            messages.clear()
            async with peer():
                owner = daemon.Daemon()
                try:
                    await asyncio.wait_for(owner.start(), 2)
                    assert type(owner.cdp) is cdp_client.CDPClient
                    assert owner.target_id == target['targetId'] and owner.session == 'fixture-session'
                    methods = [message['method'] for message in messages]
                    assert methods.count('Target.createTarget') == int(name != 'default')
                    assert set(methods) >= {'Target.getTargets', 'Target.attachToTarget', 'Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable'}
                    daemon.ipc._server_token = 'fixture-token'
                    count = len(messages)
                    assert await owner.handle({'meta': 'current_tab', 'token': 'wrong'}) == {'error': 'unauthorized'}
                    assert len(messages) == count
                    tab = await owner.handle({'meta': 'current_tab', 'token': 'fixture-token'})
                    assert tab == {'targetId': target['targetId'], 'url': 'about:blank', 'title': ''}
                    assert await owner.handle({'meta': 'shutdown', 'token': 'fixture-token'}) == {'ok': True}
                    assert owner.stop.is_set() and owner._shutting_down
                    assert not owner._recovery_tasks and owner._recoveries_idle.is_set()
                finally:
                    daemon.ipc._server_token = None
                    if owner.cdp is not None:
                        await owner.cdp.stop()
                assert not owners and all(transport.is_closing() for transport in transports)
        assert len(calls) == 2
    asyncio.run(main())
`);
  },
);

test("browser pipe waits for Windows protocol initialization before its handshake", options, () => {
  check(String.raw`
defer_made = True
async def main():
    async with peer():
        client = cdp_client.CDPClient(endpoint)
        await client.start()
        assert await asyncio.wait_for(client.send_raw('Browser.getVersion'), 2) == {'fixture': True}
        assert len(requests) == 1 and len(owners) == 1
        await client.stop()
        assert not owners and all(transport.is_closing() for transport in transports)
asyncio.run(main())
`);
});

test("cancellation at Windows pipe initialization closes the retained transport", options, () => {
  check(String.raw`
defer_made = cancel_before_made = True
async def main():
    async with peer():
        async def start(): return await Connect(endpoint)
        task = asyncio.create_task(start())
        try: await task
        except asyncio.CancelledError: pass
        else: raise AssertionError('cancellation ignored')
        assert transports and all(transport.is_closing() for transport in transports)
        assert not owners and not requests
asyncio.run(main())
`);
});

for (const status of [403, 302]) {
  test(
    `browser handshake ${status} closes its pipe without redirect or TCP fallback`,
    options,
    () => {
      check(String.raw`
status = ${status}
defer_made = True
async def main():
    async with peer():
        try: await Connect(endpoint)
        except InvalidStatus as error: assert error.response.status_code == status
        else: raise AssertionError('rejected handshake accepted')
        assert len(calls) == 1 and not owners
        assert all(transport.is_closing() for transport in transports)
asyncio.run(main())
`);
    },
  );
}

test("connect deadline closes an already bound pipe before returning", options, () => {
  check(String.raw`
after_delay = 1
async def main():
    async with peer():
        try: await Connect(endpoint, open_timeout=0.03)
        except TimeoutError: pass
        else: raise AssertionError('connect deadline ignored')
        assert transports and all(transport.is_closing() for transport in transports)
        assert not owners
asyncio.run(main())
`);
});

test(
  "pending browser connection cannot be declared closed until its task is cancelled",
  options,
  () => {
    check(String.raw`
before_delay = 1
async def main():
    async with peer():
        async def start(): return await Connect(endpoint)
        task = asyncio.create_task(start())
        await asyncio.sleep(0.01)
        try: await close_owned()
        except RuntimeError as error: assert 'pending' in str(error)
        else: raise AssertionError('pending connect discarded')
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass
        assert not owners and not transports
asyncio.run(main())
`);
  },
);

test("repeated cancellation retains browser connection until connection_lost", options, () => {
  check(String.raw`
after_delay = 1
hold_lost = True
async def main():
    async with peer():
        async def start(): return await Connect(endpoint)
        task = asyncio.create_task(start())
        await bound.wait()
        task.cancel()
        await asyncio.wait_for(lost_pending.wait(), 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass
        assert owners, 'an interrupted wait dropped handle custody'
        assert pending_lost
        for callback, error in pending_lost: callback(error)
        await close_owned()
        assert not owners
asyncio.run(main())
`);
});
