// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hermesInferencePipePythonSource } from "./native-hermes-inference-pipe.mts";
import { renderFactory, staticWorkerSource } from "../distribution/build-native-workers.mts";

// The optional fixture contains hash-verified Python sources from the pinned Hermes archive.
// Real HTTPX/httpcore/h11 parse HTTP over a memory transport; no Windows/live inference claim.
const dependencies = process.env.NEMOCLAW_HERMES_PYTHON_TEST_DEPS;
const fixture = String.raw`
import ast, asyncio, contextlib, os, sys, threading, time, types
from types import SimpleNamespace as NS
import httpx, httpcore, h11
assert (httpx.__version__, httpcore.__version__, h11.__version__) == ('0.28.1', '1.0.9', '0.16.0')

def functions(source, names, target):
    tree = ast.parse(source)
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(nodes) == len(names)
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    module = ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[]))
    exec(compile(module, '<pinned-hermes-functions>', 'exec'), target)

bootstrap = types.ModuleType('agent.process_bootstrap')
bootstrap.__dict__.update(_SharedTransport=None, _SHARED_TRANSPORTS={}, _SHARED_TRANSPORTS_MAX=32,
    _SHARED_TRANSPORTS_LOCK=threading.Lock(), HERMES_TRANSPORT_OWNER_EXT='hermes_transport_owner')
functions(bootstrap_source, {'_shared_transport_cls', '_get_shared_transport', 'close_shared_transports'}, bootstrap.__dict__)
agent = types.ModuleType('agent')
agent.process_bootstrap = bootstrap
sys.modules['agent'] = agent
sys.modules['agent.process_bootstrap'] = bootstrap
helpers = {'contextlib': contextlib, '_ra': lambda: NS(logger=NS(debug=lambda *args: None))}
functions(helpers_source, {'_iter_httpx_pools_with_owner', '_connection_candidates', '_socket_from_stream',
    '_iter_pool_sockets', 'force_close_tcp_sockets'}, helpers)

pipes = []
requests = []
connect_delay = 0
after_bind_delay = 0
ready_delay = 0
write_paused = False
close_delay = 0

class MemoryPipe(asyncio.Transport):
    def __init__(self, protocol, loop):
        self.protocol = protocol
        self.loop = loop
        self.closing = False
        self.server = h11.Connection(h11.SERVER)
        self.request = None
        self.body = bytearray()
        self.writes = []
    def get_extra_info(self, name, default=None): return default
    def is_closing(self): return self.closing
    def abort(self):
        if not self.closing:
            self.closing = True
            self.loop.call_later(close_delay, self.protocol.connection_lost, None)
    def close(self): self.abort()
    def pause_reading(self): pass
    def resume_reading(self): pass
    def write(self, data):
        assert not self.closing
        self.writes.append(len(data))
        if write_paused:
            self.protocol.pause_writing()
            return
        self.server.receive_data(data)
        while True:
            event = self.server.next_event()
            if event is h11.NEED_DATA or event is h11.PAUSED: return
            if isinstance(event, h11.Request): self.request = event
            elif isinstance(event, h11.Data): self.body.extend(event.data)
            elif isinstance(event, h11.EndOfMessage):
                requests.append((self.request, bytes(self.body), self))
                target = self.request.target
                headers = [(b'content-type', b'text/event-stream'), (b'transfer-encoding', b'chunked')]
                status = 302 if target == b'/redirect' else 200
                if status == 302: headers.append((b'location', b'http://foreign.invalid/v1'))
                self.protocol.data_received(self.server.send(h11.Response(status_code=status, headers=headers)))
                if target == b'/hang': return
                for data in (b'data: {"content":', b'"fixture"}\n\n', b'data: [DONE]\n\n'):
                    wire = self.server.send(h11.Data(data=data))
                    for offset in range(0, len(wire), 3): self.protocol.data_received(wire[offset:offset + 3])
                self.protocol.data_received(self.server.send(h11.EndOfMessage()))
                self.server.start_next_cycle()
                self.body.clear()
                return

def pipe_loop():
    loop = asyncio.new_event_loop()
    async def connect(factory, address):
        assert address == r'\\.\pipe\LOCAL\OpenShell-Loopback-8123'
        if connect_delay: await asyncio.sleep(connect_delay)
        protocol = factory()
        transport = MemoryPipe(protocol, loop)
        pipes.append(transport)
        if after_bind_delay:
            protocol.connection_made(transport)
            await asyncio.sleep(after_bind_delay)
        else:
            loop.call_later(ready_delay, protocol.connection_made, transport)
        return transport, protocol
    loop.create_pipe_connection = connect
    return loop

asyncio.ProactorEventLoop = pipe_loop
namespace = {'sys': NS(platform='win32'), 'os': NS(environ={}), '_new_native_hermes_loop': pipe_loop}
exec(adapter_source, namespace)
install = namespace['_install_native_inference_pipe']
build, close = install('8123')
url = 'http://127.0.0.1:8123/v1'
expected = 'data: {"content":"fixture"}\n\ndata: [DONE]\n\n'
def run(coroutine):
    with asyncio.Runner(loop_factory=pipe_loop) as runner: return runner.run(coroutine)
`;

function check(python: string) {
  assert(dependencies);
  const source =
    `import sys\nsys.path.insert(0, ${JSON.stringify(dependencies)})\n` +
    `bootstrap_source = ${JSON.stringify(fs.readFileSync(path.join(dependencies, "process_bootstrap.py"), "utf8"))}\n` +
    `helpers_source = ${JSON.stringify(fs.readFileSync(path.join(dependencies, "agent_runtime_helpers.py"), "utf8"))}\n` +
    `adapter_source = ${JSON.stringify(hermesInferencePipePythonSource()[0])}\n` +
    fixture +
    "\ntry:\n" +
    python
      .trim()
      .split("\n")
      .map((line) => "    " + line)
      .join("\n") +
    "\nfinally:\n    bootstrap.close_shared_transports()\n    close()\n";
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-B", "-"], {
    input: source,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? result.signal));
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

const options = {
  skip: dependencies
    ? false
    : "Pinned Hermes Python transport test dependencies are not configured",
};

test(
  "top-level workers reuse the child bootstrap backend and reject a changed pipe",
  options,
  () => {
    check(String.raw`
again, same_close = install('8123')
assert again is build and same_close is close
try: install('8124')
except RuntimeError as error: assert 'cannot change' in str(error)
else: raise AssertionError('bootstrap pipe was rebound')
assert not pipes
`);
  },
);

test("all five prebuilt Hermes Python variants contain the reviewed inference adapter before Hermes starts", () => {
  const assets = new Map<string, string>();
  for (const [mode, file, name] of [
    ["interactive", "run-installed-native-console-agent.mts", "interactiveWorkloadSource"],
    ["hermes-turn", "run-installed-native-hermes-turn.mts", "hermesWorkloadSource"],
  ]) {
    const source = renderFactory(fileURLToPath(new URL("./", import.meta.url)), file, name);
    const bundled = staticWorkerSource(mode, source, assets);
    assert(!bundled.includes("writeFileSync(runner"));
  }
  assert.equal(assets.size, 5);
  for (const content of assets.values()) {
    assert(content.includes(hermesInferencePipePythonSource()[0]));
    assert(
      content.indexOf("def _install_native_inference_pipe") <
        content.indexOf("from hermes_cli.main import main"),
    );
    assert(Buffer.byteLength(content) < 64 * 1024);
  }
});

test(
  "pipe inference validates declaration and rejects alternate endpoints without fallback",
  options,
  () => {
    check(String.raw`
for value in ('', '0', '65536', '-1', ' 8123', '８１２３', '8123/name'):
    try: install(value)
    except RuntimeError: pass
    else: raise AssertionError(value)
namespace['sys'].platform = 'linux'
try: install('8123')
except RuntimeError: pass
else: raise AssertionError('non-Windows accepted')
for value in ('', 'https://127.0.0.1:8123/v1', 'http://localhost:8123/v1', 'http://127.0.0.1:8124/v1'):
    try: build(value)
    except RuntimeError: pass
    else: raise AssertionError(value)
assert pipes == []
`);
  },
);

test(
  "synchronous HTTPX preserves streamed bytes, headers, shared-pool ownership and keepalive",
  options,
  () => {
    check(String.raw`
os.environ['HTTP_PROXY'] = 'http://foreign.invalid:9999'
first, second = build(url), build(url)
assert first._transport._pool is second._transport._pool
assert first.timeout.read is None and first.timeout.connect == 15 and first.timeout.pool == 10
for client in (first, second):
    with client.stream('POST', url + '/chat/completions', headers={'authorization': 'Bearer fixture-only'}, json={'stream': True}) as response:
        assert ''.join(response.iter_text()) == expected
assert len(pipes) == 1 and len(requests) == 2
assert dict(requests[0][0].headers)[b'authorization'] == b'Bearer fixture-only'
assert b'"stream":true' in requests[0][1]
first.close()
assert second.get(url).text == expected
assert not pipes[0].closing
second.close()
`);
  },
);

test("async HTTPX preserves streaming and releases owned pipe handles on close", options, () => {
  check(String.raw`
async def exercise():
    async with build(url, async_mode=True) as client:
        backend = client._transport.backend
        async with client.stream('POST', url, content=b'fixture') as response:
            assert ''.join([chunk async for chunk in response.aiter_text()]) == expected
        assert len(backend.streams) == 1
    assert not backend.streams
    assert pipes[0].closing
run(exercise())
`);
});

test("redirects and per-request endpoint changes cannot escape the inference pipe", options, () => {
  check(String.raw`
with build(url) as client:
    for target in ('http://foreign.invalid/v1', 'https://127.0.0.1:8123/v1', 'http://127.0.0.1:8124/v1', 'http://user:secret@127.0.0.1:8123/v1'):
        try: client.get(target)
        except httpx.UnsupportedProtocol: pass
        else: raise AssertionError('out-of-scope request accepted')
    assert not pipes
    try: client.get('http://127.0.0.1:8123/redirect', follow_redirects=True)
    except httpx.UnsupportedProtocol: pass
    else: raise AssertionError('redirect escaped')
    assert len(pipes) == 1 and len(requests) == 1
`);
});

test("read deadlines remain HTTPX timeouts and close the pipe before returning", options, () => {
  check(String.raw`
with build(url) as client:
    try: client.get('http://127.0.0.1:8123/hang', timeout=0.02)
    except httpx.ReadTimeout: pass
    else: raise AssertionError('read did not time out')
assert len(pipes) == 1 and pipes[0].closing
assert pipes[0].protocol.closed.done()
`);
});

test("connect deadlines close a late-bound pipe and never retry with TCP", options, () => {
  check(String.raw`
after_bind_delay = 1
with build(url) as client:
    try: client.get(url, timeout=0.02)
    except httpx.ConnectTimeout: pass
    else: raise AssertionError('connect did not time out')
assert len(pipes) == 1 and pipes[0].closing and pipes[0].protocol.closed.done()
assert not requests
`);
});

test(
  "connect deadlines retain returned pipes until deferred readiness and closure settle",
  options,
  () => {
    check(String.raw`
ready_delay = 0.05
close_delay = 0.08
with build(url) as client:
    try: client.get(url, timeout=0.02)
    except httpx.ConnectTimeout: pass
    else: raise AssertionError('protocol readiness did not time out')
assert len(pipes) == 1 and pipes[0].closing and pipes[0].protocol.closed.done()
assert pipes[0].protocol.ready.done() and not pipes[0].protocol.ready.cancelled()
assert not requests
`);
  },
);

test(
  "client closure before deferred connection_made retains and closes the returned pipe",
  options,
  () => {
    check(String.raw`
ready_delay = 0.05
close_delay = 0.08
async def exercise():
    client = build(url, async_mode=True)
    backend = client._transport.backend
    pending = asyncio.create_task(client.get(url))
    while not pipes and not pending.done(): await asyncio.sleep(0)
    if pending.done(): await pending
    assert not pipes[0].protocol.ready.done()
    await client.aclose()
    try: await pending
    except asyncio.CancelledError: pass
    else: raise AssertionError('connecting request survived client closure')
    assert not backend.pending and not backend.streams and not requests
    assert pipes[0].closing and pipes[0].protocol.closed.done()
    assert pipes[0].protocol.ready.done() and not pipes[0].protocol.ready.cancelled()
run(exercise())
`);
  },
);

test("write backpressure has a deadline and bounded chunks", options, () => {
  check(String.raw`
write_paused = True
with build(url) as client:
    try: client.post(url, content=b'x' * 200000, timeout=0.02)
    except httpx.WriteTimeout: pass
    else: raise AssertionError('write did not time out')
assert len(pipes) == 1 and pipes[0].closing and pipes[0].protocol.closed.done()
assert max(pipes[0].writes) <= 65536
`);
});

test("async cancellation confirms pipe closure and retains no backend stream", options, () => {
  check(String.raw`
async def exercise():
    async with build(url, async_mode=True) as client:
        backend = client._transport.backend
        pending = asyncio.create_task(client.get('http://127.0.0.1:8123/hang'))
        while not requests and not pending.done(): await asyncio.sleep(0)
        if pending.done(): await pending
        pending.cancel()
        try: await pending
        except asyncio.CancelledError: pass
        else: raise AssertionError('cancellation swallowed')
        assert not backend.streams
        assert pipes[0].protocol.closed.done()
run(exercise())
`);
});

test("AnyIO cancellation scopes do not interrupt pipe closure confirmation", options, () => {
  check(String.raw`
import anyio
close_delay = 0.05
async def exercise():
    async with build(url, async_mode=True) as client:
        backend = client._transport.backend
        with anyio.move_on_after(0.02) as scope:
            await client.get('http://127.0.0.1:8123/hang')
        assert scope.cancel_called
        assert pipes[0].protocol.closed.done()
        assert not backend.streams
run(exercise())
`);
});

test("closing an async client cancels and settles a pending pipe connection", options, () => {
  check(String.raw`
after_bind_delay = 10
async def exercise():
    client = build(url, async_mode=True)
    backend = client._transport.backend
    pending = asyncio.create_task(client.get(url))
    while not pipes and not pending.done(): await asyncio.sleep(0)
    if pending.done(): await pending
    await client.aclose()
    try: await pending
    except asyncio.CancelledError: pass
    else: raise AssertionError('connecting request survived client closure')
    assert not backend.pending and not backend.streams
    assert pipes[0].closing and pipes[0].protocol.closed.done()
run(exercise())
`);
});

test("interrupted close retains the pipe owner until connection_lost is confirmed", options, () => {
  check(String.raw`
close_delay = 0.05
async def exercise():
    client = build(url, async_mode=True)
    assert (await client.get(url)).text == expected
    backend = client._transport.backend
    stream = next(iter(backend.streams))
    closing = asyncio.create_task(stream.aclose())
    while not pipes[0].closing: await asyncio.sleep(0)
    closing.cancel()
    try: await closing
    except asyncio.CancelledError: pass
    else: raise AssertionError('test did not interrupt closure')
    assert stream in backend.streams and not stream.protocol.closed.done()
    await client.aclose()
    assert not backend.streams and stream.protocol.closed.done()
run(exercise())
`);
});

test(
  "repeated cancellation during connect cleanup retains the pending handle until closure",
  options,
  () => {
    check(String.raw`
after_bind_delay = 10
close_delay = 0.05
async def exercise():
    client = build(url, async_mode=True)
    backend = client._transport.backend
    pending = asyncio.create_task(client.get(url))
    while not pipes and not pending.done(): await asyncio.sleep(0)
    if pending.done(): await pending
    pending.cancel()
    while not pipes[0].closing: await asyncio.sleep(0)
    pending.cancel()
    try: await pending
    except asyncio.CancelledError: pass
    else: raise AssertionError('request cancellation was swallowed')
    assert backend.pending and not pipes[0].protocol.closed.done()
    await client.aclose()
    assert not backend.pending and not backend.streams
    assert pipes[0].protocol.closed.done()
run(exercise())
`);
  },
);

test(
  "pinned Hermes abort walker stops only the selected client's stream in a shared pool",
  options,
  () => {
    check(String.raw`
clients = [build(url), build(url)]
finished = [threading.Event(), threading.Event()]
def receive(index):
    try: clients[index].get('http://127.0.0.1:8123/hang')
    except httpx.RemoteProtocolError: pass
    finally: finished[index].set()
threads = [threading.Thread(target=receive, args=(index,), daemon=True) for index in range(2)]
for thread in threads: thread.start()
deadline = time.monotonic() + 3
while len(requests) < 2 and time.monotonic() < deadline: time.sleep(0.001)
assert len(requests) == 2
assert helpers['force_close_tcp_sockets'](clients[0]) == 1
assert finished[0].wait(2)
assert not finished[1].is_set()
assert helpers['force_close_tcp_sockets'](clients[1]) == 1
assert finished[1].wait(2)
for thread in threads: thread.join(2)
for client in clients: client.close()
`);
  },
);
