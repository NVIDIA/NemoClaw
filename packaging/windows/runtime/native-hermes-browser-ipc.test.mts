// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { hermesBrowserIpcPythonSource } from "./native-hermes-browser-ipc.mts";

const dependencies = process.env.NEMOCLAW_HERMES_PYTHON_TEST_DEPS;
const options = {
  skip:
    process.platform === "win32"
      ? "Isolated Unix and memory WinAPI controls"
      : dependencies
        ? false
        : "Pinned Browser Harness fixtures are not configured",
};
const fixture = String.raw`
import ast, asyncio, contextlib, hashlib, json, os, pathlib, socket, sys, tempfile, types
from types import SimpleNamespace as NS
root = tempfile.TemporaryDirectory(prefix='hermes-ipc-')
os.environ['BH_RUNTIME_DIR'] = root.name
os.environ['BH_TMP_DIR'] = root.name
from browser_harness import _ipc as ipc
ipc_file = pathlib.Path(ipc.__file__)
assert hashlib.sha256(ipc_file.read_bytes()).hexdigest() == 'b46ec6e55ddae9919ada069053dfa12a2555d33a832de57ef5eb3a457cec80b3'
daemon_file = ipc_file.with_name('daemon.py')
assert hashlib.sha256(daemon_file.read_bytes()).hexdigest() == '7f05f904e62af8c07153c34a1fd3d334acf5c5aded8d0ddab974596bb50a8c97'
tree = ast.parse(daemon_file.read_text())
daemon_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Daemon')
handle = next(node for node in daemon_class.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'handle')
daemon_namespace = {'ipc': ipc, 'os': os, 'BROWSER_KIND': 'fixture'}
exec(compile(ast.Module(body=[handle], type_ignores=[]), '<pinned-daemon-handle>', 'exec'), daemon_namespace)
originals = (ipc.request, ipc.ping, ipc.identify, ipc.expected_token, ipc.spawn_kwargs)
socket.create_connection = lambda *a, **k: (_ for _ in ()).throw(AssertionError('TCP fallback'))
state = NS(stall=False, settle=True, close_error=False, write_short=False, response=b'{}\n', writes=[], closed=[], opened=[], waits=[])
bindings = {}

class Operation:
    def __init__(self, data=b'', count=0):
        self.data, self.count = data, count
        self.event = self
        self.pending = state.stall
        self.cancelled = False
    def cancel(self): self.cancelled = True
    def GetOverlappedResult(self, wait):
        assert wait is False
        if self.pending and not (self.cancelled and state.settle): return (0, 996)
        return (self.count, api.ERROR_OPERATION_ABORTED if self.cancelled else 0)
    def getbuffer(self): return self.data

def create(address, access, share, security, disposition, flags, template):
    assert access == api.GENERIC_READ | api.GENERIC_WRITE
    assert share == security == template == 0 and flags == api.FILE_FLAG_OVERLAPPED
    state.opened.append(address)
    if address in bindings:
        handle = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        handle.settimeout(2)
        handle.connect(bindings[address])
        return handle
    return NS(address=address)

def write(handle, data, *, overlapped):
    assert overlapped
    data = bytes(data)
    state.writes.append(data)
    if isinstance(handle, socket.socket): handle.sendall(data)
    return Operation(count=len(data) - int(state.write_short)), api.ERROR_IO_PENDING if state.stall else 0

def read(handle, size, *, overlapped):
    assert overlapped
    data = handle.recv(size) if isinstance(handle, socket.socket) else state.response[:size]
    if not data: raise BrokenPipeError('fixture EOF')
    return Operation(data, len(data)), api.ERROR_IO_PENDING if state.stall else 0

def close(handle):
    if state.close_error: raise OSError('fixture close failed')
    state.closed.append(handle)
    if isinstance(handle, socket.socket): handle.close()

def wait(event, milliseconds):
    assert 0 < milliseconds <= 2147483647
    state.waits.append(milliseconds)
    return api.WAIT_TIMEOUT if event.pending and not (event.cancelled and state.settle) else api.WAIT_OBJECT_0

api = NS(GENERIC_READ=1, GENERIC_WRITE=2, NULL=0, OPEN_EXISTING=3, FILE_FLAG_OVERLAPPED=4,
    ERROR_PIPE_BUSY=231, ERROR_SEM_TIMEOUT=121, ERROR_IO_PENDING=997, ERROR_OPERATION_ABORTED=995,
    WAIT_OBJECT_0=0, WAIT_TIMEOUT=258, CreateFile=create, WriteFile=write, ReadFile=read,
    CloseHandle=close, WaitForSingleObject=wait,
    SetNamedPipeHandleState=lambda handle, mode, a, b: None)
sys.modules['_winapi'] = api
namespace = {'sys': NS(platform='win32'), 'os': os}
exec(adapter_source, namespace)
install = namespace['_install_native_browser_ipc']
cleanup, clients, servers = install('0123456789')
assert originals == (ipc.request, ipc.ping, ipc.identify, ipc.expected_token, ipc.spawn_kwargs)

def record(name='test'):
    identity = os.path.normcase(os.path.abspath(str(ipc.port_path(name)))).encode()
    return {'schemaVersion': 1, 'transport': 'native-hermes-browser-pipe',
        'pipe': r'\\.\pipe\LOCAL\Hermes-Browser-0123456789-' + hashlib.sha256(identity).hexdigest()[:24],
        'token': 'a' * 64}

def publish(value=None):
    ipc.port_path('test').write_text(json.dumps(record() if value is None else value))

@contextlib.asynccontextmanager
async def peer(handler=None, lost_delay=0):
    loop = asyncio.get_running_loop()
    tcp = loop.create_server
    loop.create_server = lambda *a, **k: (_ for _ in ()).throw(AssertionError('TCP listener'))
    address = str(pathlib.Path(root.name) / 'daemon.sock')
    class Listener:
        def __init__(self, server, name):
            self.server, self.name = server, name
            self._accept_pipe_future = loop.create_future()
            self.is_closed = False
        def closed(self): return self.is_closed
        def close(self):
            self.server.close()
            self.is_closed = True
            bindings.pop(self.name, None)
            self._accept_pipe_future.cancel()
    async def start(factory, name):
        if name in bindings: raise PermissionError('fixture first instance already bound')
        def protocol():
            value = factory()
            if lost_delay:
                original = value.connection_lost
                value.connection_lost = lambda error: loop.call_later(lost_delay, original, error)
            return value
        server = await loop.create_unix_server(protocol, address)
        bindings[name] = address
        return [Listener(server, name)]
    loop.start_serving_pipe = start
    async def respond(reader, writer):
        request = json.loads(await reader.readline())
        response = await daemon_namespace['handle'](NS(), request)
        writer.write((json.dumps(response) + '\n').encode())
        await writer.drain()
    task = asyncio.create_task(ipc.serve('test', handler or respond))
    try:
        for _ in range(100):
            if task.done(): await task
            if bindings and ipc.port_path('test').exists(): break
            await asyncio.sleep(0.001)
        else: raise AssertionError('server not published')
        yield task
    finally:
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass
        await cleanup()
        loop.create_server = tcp
        del loop.start_serving_pipe
`;

function check(body: string) {
  assert(dependencies);
  const result = spawnSync("python3", ["-I", "-B", "-"], {
    input:
      `import sys\nsys.path.insert(0, ${JSON.stringify(dependencies)})\nadapter_source = ${JSON.stringify(hermesBrowserIpcPythonSource()[0])}\n` +
      fixture +
      "\n" +
      body +
      "\nroot.cleanup()\n",
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? result.signal));
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
}

test(
  "browser IPC requires a stable Windows session and preserves upstream protocol functions",
  options,
  () => {
    check(String.raw`
assert install('0123456789') == (cleanup, clients, servers)
for value in ['other', '012345678a', '01234567890', '0123456789\n']:
    try: install(value)
    except RuntimeError: pass
    else: raise AssertionError(value)
namespace['sys'].platform = 'linux'
try: install('0123456789')
except RuntimeError: pass
else: raise AssertionError('platform')
assert not clients and not servers
`);
  },
);

test(
  "browser IPC rejects foreign or oversized endpoint records before opening handles",
  options,
  () => {
    check(String.raw`
for key, value in [('schemaVersion', True), ('transport', 'tcp'), ('pipe', record()['pipe'] + '-other'), ('token', 'a'), ('port', 8124)]:
    item = record(); item[key] = value; publish(item)
    try: ipc.connect('test')
    except OSError: pass
    else: raise AssertionError(key)
ipc.port_path('test').write_bytes(b' ' * 4097)
try: ipc.connect('test')
except OSError: pass
else: raise AssertionError('oversize')
for name in ['../test', '', 'test/name']:
    try: ipc.connect(name)
    except ValueError: pass
    else: raise AssertionError(name)
assert not clients and not state.opened
`);
  },
);

test(
  "browser IPC retains token injection, PID validation, bounded writes, and stream EOF",
  options,
  () => {
    check(String.raw`
publish()
for pid in [True, 0, -1, 1 << 31, '123', 123]:
    state.response = json.dumps({'pong': True, 'pid': pid}).encode() + b'\n'
    assert ipc.identify('test') == (123 if type(pid) is int and pid == 123 else None)
    assert json.loads(state.writes[-1]) == {'meta': 'ping', 'token': 'a' * 64}
assert not clients
client, token = ipc.connect('test')
state.writes.clear()
client.sendall(b'x' * 20000)
assert list(map(len, state.writes)) == [8192, 8192, 3616]
state.response = b''
assert client.recv(65536) == b'' and not clients
client.close()
`);
  },
);

test(
  "browser IPC validates deadlines and rejects partial writes without losing handle custody",
  options,
  () => {
    check(String.raw`
publish()
for value in [0, -1, True, None, float('inf'), float('nan')]:
    try: ipc.connect('test', timeout=value)
    except ValueError: pass
    else: raise AssertionError(value)
assert not clients and not state.opened
client, _ = ipc.connect('test')
state.write_short = True
try: client.sendall(b'payload')
except OSError: pass
else: raise AssertionError('partial write')
assert not clients and state.closed
`);
  },
);

test(
  "browser IPC timeout cancels and settles overlapped operations before releasing handles",
  options,
  () => {
    check(String.raw`
publish()
client, _ = ipc.connect('test', timeout=0.1)
state.stall = True
try: client.sendall(b'payload')
except TimeoutError: pass
else: raise AssertionError('timeout')
assert not clients and client.pending is None and client.handle is None
assert state.waits[-1] == 5000 and state.closed
`);
  },
);

test(
  "browser IPC bounds busy-pipe retries and closes a handle when stream-mode setup fails",
  options,
  () => {
    check(String.raw`
publish()
def busy(*args):
    error = OSError('busy'); error.winerror = api.ERROR_PIPE_BUSY; raise error
def timed_out(address, timeout):
    assert 0 < timeout <= 100
    error = OSError('timeout'); error.winerror = api.ERROR_SEM_TIMEOUT; raise error
api.CreateFile, api.WaitNamedPipe = busy, timed_out
try: ipc.connect('test', timeout=0.1)
except TimeoutError: pass
else: raise AssertionError('busy pipe deadline')
assert not clients and not state.closed
api.CreateFile = create
def reject_mode(*args): raise OSError('mode failed')
api.SetNamedPipeHandleState = reject_mode
try: ipc.connect('test')
except OSError: pass
else: raise AssertionError('stream mode')
assert not clients and len(state.closed) == 1
`);
  },
);

test(
  "browser IPC retains and retries unconfirmed overlapped cancellation and failed handle closure",
  options,
  () => {
    check(String.raw`
publish()
client, _ = ipc.connect('test', timeout=0.1)
state.stall, state.settle = True, False
try: client.recv(64)
except RuntimeError: pass
else: raise AssertionError('unconfirmed cancel')
assert client in clients and client.pending is not None and client.handle is not None
assert not state.closed
state.settle, state.close_error = True, True
try: client.close()
except OSError: pass
else: raise AssertionError('failed handle closure')
assert client in clients and client.pending is None and client.handle is not None
state.close_error = False
asyncio.run(cleanup())
assert not clients and client.handle is None
`);
  },
);

test(
  "browser IPC can release a cancelled operation that completed with a native broken-pipe error",
  options,
  () => {
    check(String.raw`
publish()
client, _ = ipc.connect('test', timeout=0.1)
state.stall, state.settle = True, False
try: client.recv(64)
except RuntimeError: pass
else: raise AssertionError('unconfirmed cancel')
state.settle = True
def broken(wait):
    error = BrokenPipeError('peer closed'); error.winerror = 109; raise error
client.pending.GetOverlappedResult = broken
client.close()
assert not clients and client.pending is None and client.handle is None
`);
  },
);

test(
  "pinned Browser Harness authenticates requests and verifies live PID over the pipe interface",
  options,
  () => {
    check(String.raw`
async def main():
    async with peer():
        assert ipc.expected_token() and len(ipc.expected_token()) == 64
        assert await asyncio.to_thread(ipc.ping, 'test') is True
        assert await asyncio.to_thread(ipc.identify, 'test') == os.getpid()
        def denied():
            client, _ = ipc.connect('test')
            try: return ipc.request(client, 'wrong-token', {'meta': 'ping'})
            finally: client.close()
        assert await asyncio.to_thread(denied) == {'error': 'unauthorized'}
        assert ipc.sock_addr('test') == record()['pipe']
    assert not clients and not servers and ipc.expected_token() is None
    assert ipc.port_path('test').exists(), 'bounded record is retained for exclusive replacement'
asyncio.run(main())
`);
  },
);

test(
  "competing browser daemon cannot replace an active endpoint and old cleanup never unlinks a new record",
  options,
  () => {
    check(String.raw`
async def main():
    async with peer():
        before = ipc.port_path('test').read_bytes()
        import browser_harness
        competitor = types.ModuleType('browser_harness._ipc')
        competitor.__package__ = 'browser_harness'
        exec(compile(ipc_file.read_text(), str(ipc_file), 'exec'), competitor.__dict__)
        browser_harness._ipc = competitor
        try:
            other_cleanup, other_clients, other_servers = install('0123456789')
            try: await competitor.serve('test', lambda *args: None)
            except PermissionError: pass
            else: raise AssertionError('duplicate listener')
            assert not other_servers and ipc.port_path('test').read_bytes() == before
            await other_cleanup()
        finally: browser_harness._ipc = ipc
        try: ipc.cleanup_endpoint('test')
        except RuntimeError: pass
        else: raise AssertionError('live server cleanup')
    replacement = record(); replacement['token'] = 'b' * 64; publish(replacement)
    ipc.cleanup_endpoint('test')
    assert json.loads(ipc.port_path('test').read_bytes()) == replacement
asyncio.run(main())
`);
  },
);

test(
  "browser IPC joins active server and handler tasks before releasing ownership",
  options,
  () => {
    check(String.raw`
async def main():
    entered = asyncio.Event()
    async def pending(reader, writer):
        entered.set()
        await asyncio.Event().wait()
    async with peer(pending):
        client, _ = await asyncio.to_thread(ipc.connect, 'test')
        await entered.wait()
        await cleanup()
        assert not clients and not servers and ipc.expected_token() is None
        assert client.handle is None
asyncio.run(main())
`);
  },
);

test(
  "browser IPC failed publication closes its listener and preserves the prior endpoint record",
  options,
  () => {
    check(String.raw`
async def main():
    publish()
    previous = ipc.port_path('test').read_bytes()
    loop = asyncio.get_running_loop()
    listener = NS(_accept_pipe_future=None, is_closed=False)
    listener.closed = lambda: listener.is_closed
    listener.close = lambda: setattr(listener, 'is_closed', True)
    async def start(factory, address): return [listener]
    loop.start_serving_pipe = start
    replace = os.replace
    def fail(*args): raise PermissionError('publication refused')
    os.replace = fail
    try:
        try: await ipc.serve('test', lambda *args: None)
        except PermissionError: pass
        else: raise AssertionError('publication')
    finally:
        os.replace = replace
        del loop.start_serving_pipe
    assert listener.closed() and not servers and ipc.expected_token() is None
    assert ipc.port_path('test').read_bytes() == previous
    assert not list(pathlib.Path(root.name).glob('*.tmp-*'))
asyncio.run(main())
`);
  },
);

test(
  "repeated server cancellation retains the record and close notification until connection_lost",
  options,
  () => {
    check(String.raw`
async def main():
    entered = asyncio.Event()
    async def pending(reader, writer):
        entered.set()
        await asyncio.Event().wait()
    async with peer(pending, lost_delay=0.1) as task:
        client, _ = await asyncio.to_thread(ipc.connect, 'test')
        await entered.wait()
        owner = servers['test']
        connection = next(iter(owner.connections))
        task.cancel()
        await asyncio.sleep(0.005)
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass
        assert servers and ipc.port_path('test').exists()
        waiter = asyncio.StreamReaderProtocol._get_close_waiter(connection, None)
        assert not waiter.cancelled() and not waiter.done()
        await cleanup()
        assert not servers and not clients and waiter.done() and not waiter.cancelled()
asyncio.run(main())
`);
  },
);
