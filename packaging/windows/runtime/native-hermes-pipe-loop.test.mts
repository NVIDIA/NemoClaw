// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { hermesPipeLoopPythonSource } from "./native-hermes-pipe-loop.mts";

const dependencies = process.env.NEMOCLAW_HERMES_PYTHON_TEST_DEPS;
const options = {
  skip: dependencies ? false : "Pinned CPython transport source fixture is not configured",
};

// Execute the pinned Proactor/PipeHandle implementations with a memory WinAPI/IOCP.
// This checks source contracts and concurrency, not native Windows handle behavior.
const fixture = String.raw`
import ast, asyncio, os, signal, socket, sys, threading, types, warnings
from types import SimpleNamespace as NS
events = []
condition = threading.Condition()
handles = {}
failure = set()
next_handle = 100
buffer = bytearray()
proactors = []

def fails(name):
    if name in failure:
        failure.remove(name)
        raise OSError('fixture ' + name)

api = types.ModuleType('_winapi')
api.PIPE_ACCESS_INBOUND = 1
api.FILE_FLAG_OVERLAPPED = 0x40000000
api.FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
api.GENERIC_WRITE = 0x40000000
api.OPEN_EXISTING = 3
api.NMPWAIT_WAIT_FOREVER = 0xffffffff
api.NULL = 0
def handle(kind):
    global next_handle
    next_handle += 1
    handles[next_handle] = kind
    return next_handle
def named_pipe(address, access, mode, instances, outgoing, incoming, timeout, security):
    fails('CreateNamedPipe')
    assert address.startswith('\\\\.\\pipe\\LOCAL\\Hermes-Wakeup-') and len(address.rsplit('-', 1)[1]) == 32
    assert (access, mode, instances, outgoing, incoming, timeout, security) == (0x40080001, 8, 1, 0, 8192, 0xffffffff, 0)
    events.append(('create', address))
    return handle('reader')
def create_file(address, access, share, security, disposition, flags, template):
    fails('CreateFile')
    assert address == events[-1][1]
    assert (access, share, security, disposition, flags, template) == (0x40000000, 0, 0, 3, 0, 0)
    return handle('writer')
def connect_pipe(reader, *, overlapped):
    fails('ConnectNamedPipe')
    assert handles[reader] == 'reader' and overlapped
    def result(wait):
        assert wait
        events.append('connected')
    return NS(GetOverlappedResult=result)
def mode(writer, value, count, timeout):
    fails('SetNamedPipeHandleState')
    assert handles[writer] == 'writer' and (value, count, timeout) == (1, None, None)
    events.append('nonblocking-writer')
def write(writer, data):
    with condition:
        assert handles[writer] == 'writer' and data == b'\0'
        available = 8192 - len(buffer)
        count = min(available, len(data))
        buffer.extend(data[:count])
        condition.notify_all()
        return count, 0
def close_handle(value):
    fails('CloseHandle')
    assert value in handles
    events.append(('closed', handles.pop(value)))
api.CreateNamedPipe = named_pipe
api.CreateFile = create_file
api.ConnectNamedPipe = connect_pipe
api.SetNamedPipeHandleState = mode
api.WriteFile = write
api.CloseHandle = close_handle
sys.modules['_winapi'] = api

class Proactor:
    def __init__(self):
        self.reads = []
        self.timeouts = []
        self.closed = False
        proactors.append(self)
    def set_loop(self, loop): self.loop = loop
    def recv(self, reader, size):
        assert handles[reader.fileno()] == 'reader'
        future = self.loop.create_future()
        future._ov = NS(pending=True)
        self.reads.append((future, size))
        return future
    def select(self, timeout=None):
        self.timeouts.append(timeout)
        with condition:
            if not buffer: condition.wait(timeout)
            result = []
            for future, size in list(self.reads):
                if future.done():
                    future._ov.pending = False
                    self.reads.remove((future, size))
                elif buffer:
                    data = bytes(buffer[:size])
                    del buffer[:size]
                    future._ov.pending = False
                    future.set_result(data)
                    self.reads.remove((future, size))
                    result.append(future)
            return result
    def _unregister(self, ov): events.append('unregistered')
    def close(self):
        for future, _ in self.reads:
            future.cancel()
            future._ov.pending = False
        self.reads.clear()
        self.closed = True
        events.append('iocp-drained')

def selected_class(source, name, target):
    nodes = [node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == name]
    assert len(nodes) == 1
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), '<pinned-cpython-class>', 'exec'), target)

pinned = types.ModuleType('asyncio._hermes_pinned_proactor')
pinned.__package__ = 'asyncio'
sys.modules[pinned.__name__] = pinned
exec(compile(proactor_source, '<pinned-proactor-events>', 'exec'), pinned.__dict__)
windows = types.ModuleType('asyncio.windows_events')
windows.__dict__.update(proactor_events=pinned, IocpProactor=Proactor)
selected_class(windows_source, 'ProactorEventLoop', windows.__dict__)
utils = types.ModuleType('asyncio.windows_utils')
utils.__dict__.update(_winapi=api, warnings=warnings)
selected_class(utils_source, 'PipeHandle', utils.__dict__)
sys.modules['asyncio.windows_events'] = windows
sys.modules['asyncio.windows_utils'] = utils

def forbidden(*args, **kwargs): raise AssertionError('Socket or global signal wakeup FD touched')
socket.socketpair = forbidden
signal.set_wakeup_fd = forbidden
namespace = {'sys': NS(platform='win32', version_info=(3, 11, 16)), 'os': os}
exec(loop_source, namespace)
new_loop = namespace['_new_native_hermes_loop']
`;

function check(python: string) {
  assert(dependencies);
  const sources = [
    ["proactor_source", "proactor_events.py"],
    ["windows_source", "windows_events.py"],
    ["utils_source", "windows_utils.py"],
  ]
    .map(
      ([name, file]) =>
        `${name} = ${JSON.stringify(fs.readFileSync(path.join(dependencies, "cpython311", file), "utf8"))}\n`,
    )
    .join("");
  const script =
    sources +
    `loop_source = ${JSON.stringify(hermesPipeLoopPythonSource()[0])}\n` +
    fixture +
    python;
  const result = spawnSync("python3", ["-I", "-B", "-"], {
    input: script,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? result.signal));
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

test("pipe loop source is syntactically valid without importing Windows APIs", () => {
  const result = spawnSync(
    "python3",
    ["-I", "-B", "-c", "import sys; compile(sys.stdin.read(), '<pipe-loop>', 'exec')"],
    {
      input: hermesPipeLoopPythonSource().join("\n"),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test(
  "contained loop enforces exact runtime and opens no socket or global signal FD",
  options,
  () => {
    check(String.raw`
for platform, version in (('linux', (3, 11, 16)), ('win32', (3, 12, 0)), ('win32', (3, 11, 15))):
    namespace['sys'] = NS(platform=platform, version_info=version)
    try: new_loop()
    except RuntimeError: pass
    else: raise AssertionError('incompatible interpreter accepted')
assert not handles and not proactors
namespace['sys'] = NS(platform='win32', version_info=(3, 11, 16))
loop = new_loop()
assert len(handles) == 2 and loop._internal_fds == 1
loop.close()
loop.close()
assert not handles and loop._internal_fds == 0 and loop.is_closed()
assert proactors[0].closed
assert [event[1] for event in events if isinstance(event, tuple) and event[0] == 'closed'] == ['reader', 'writer']
`);
  },
);

test(
  "each partial wakeup-pipe startup failure closes its allocated handles and IOCP",
  options,
  () => {
    check(String.raw`
for stage in ('CreateNamedPipe', 'CreateFile', 'ConnectNamedPipe', 'SetNamedPipeHandleState'):
    failure.add(stage)
    try: new_loop()
    except OSError as error: assert stage in str(error)
    else: raise AssertionError('startup error swallowed')
    assert not handles and proactors[-1].closed
`);
  },
);

test(
  "failed handle closure retains ownership, attempts the other handle, and permits explicit retry",
  options,
  () => {
    check(String.raw`
loop = new_loop()
failure.add('CloseHandle')
try: loop.close()
except RuntimeError as error: assert 'unconfirmed' in str(error)
else: raise AssertionError('unconfirmed closure accepted')
assert len(handles) == 1 and loop._ssock is not None and loop._csock is None
assert not loop.is_closed() and not proactors[0].closed and loop._internal_fds == 1
loop.close()
assert not handles and loop.is_closed() and loop._internal_fds == 0
`);
  },
);

test(
  "main-thread loop retains signal handlers and bounds waits for signal delivery",
  options,
  () => {
    check(String.raw`
handler = signal.getsignal(signal.SIGINT)
loop = new_loop()
async def exercise():
    await asyncio.sleep(0.12)
    raise KeyboardInterrupt()
try: loop.run_until_complete(exercise())
except KeyboardInterrupt: pass
else: raise AssertionError('KeyboardInterrupt swallowed')
assert signal.getsignal(signal.SIGINT) is handler
assert all(value is not None and value <= 0.1 for value in proactors[0].timeouts)
assert proactors[0].reads
loop.close()
assert not handles and not proactors[0].reads
`);
  },
);

test(
  "cross-thread callbacks wake an idle loop through its private pipe and stop cleanly",
  options,
  () => {
    check(String.raw`
ready = threading.Event()
holder = []
errors = []
def worker():
    try:
        loop = new_loop()
        holder.append(loop)
        loop.call_soon(ready.set)
        loop.run_forever()
        loop.close()
    except BaseException as error: errors.append(error)
thread = threading.Thread(target=worker, daemon=True)
thread.start()
assert ready.wait(2)
loop = holder[0]
seen = []
async def request():
    seen.append('delivered')
    return 42
assert asyncio.run_coroutine_threadsafe(request(), loop).result(2) == 42
for index in range(100): loop.call_soon_threadsafe(seen.append, index)
loop.call_soon_threadsafe(loop.stop)
thread.join(2)
assert not thread.is_alive() and not errors
assert seen == ['delivered', *range(100)]
assert not handles and proactors[0].closed
assert None in proactors[0].timeouts
`);
  },
);

test("a full wakeup buffer does not block and pending callbacks still execute", options, () => {
  check(String.raw`
loop = new_loop()
for _ in range(9000): loop._write_to_self()
assert len(buffer) == 8192
seen = []
loop.call_soon_threadsafe(seen.append, 'retained')
loop.call_soon(loop.stop)
loop.run_forever()
assert seen == ['retained']
loop.close()
assert not handles
`);
});

test("running-loop close is rejected without discarding wakeup ownership", options, () => {
  check(String.raw`
loop = new_loop()
async def exercise():
    try: loop.close()
    except RuntimeError: pass
    else: raise AssertionError('running loop closed')
    assert len(handles) == 2 and loop._internal_fds == 1
loop.run_until_complete(exercise())
loop.close()
assert not handles
`);
});
