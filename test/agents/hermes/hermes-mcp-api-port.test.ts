// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TRANSACTION = path.resolve(
  import.meta.dirname,
  "../../..",
  "agents/hermes/mcp-config-transaction.py",
);

describe("Hermes MCP API port resolution", () => {
  it("resolves the port from the managed API relay without process environments (#9044)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import builtins, importlib.util, json, sys, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = (41, 333)
manager_pid = 40
relay_pid = 42
relay_arguments = [
    b"socat",
    b"TCP-LISTEN:8645,bind=0.0.0.0,fork,reuseaddr",
    b"TCP:127.0.0.1:18642",
]

class ProcessEntries:
    def __enter__(self):
        return iter(types.SimpleNamespace(name=name) for name in ("self", "1", "41", "42"))
    def __exit__(self, *_args):
        return False

owners = {manager_pid: 1000, relay_pid: 1000}
module._root_gateway_public_port_marker = lambda: None
module.os.geteuid = lambda: 1000
module.os.scandir = lambda path: ProcessEntries()
module.os.stat = lambda path: types.SimpleNamespace(st_uid=owners[int(path.rsplit("/", 1)[1])])
module._process_parent_pid = lambda pid: manager_pid
module._process_name = lambda pid: module.MANAGED_API_RELAY_PROCESS_NAME
module._process_arguments = lambda pid: [module.SERVICE_MANAGER_PATH] if pid == manager_pid else relay_arguments
module._process_start_identity = lambda pid: 101 if pid == manager_pid else 202
module._gateway_identity = lambda: identity

environment_reads = []
real_open = builtins.open
def deny_environment(path, *args, **kwargs):
    if str(path).endswith("/environ"):
        environment_reads.append(str(path))
        raise PermissionError("process environments are unavailable")
    return real_open(path, *args, **kwargs)

builtins.open = deny_environment
try:
    port = module._resolve_gateway_public_port()
finally:
    builtins.open = real_open

print(json.dumps({"port": port, "environment_reads": environment_reads}))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ port: 8645, environment_reads: [] });
  });

  it("skips unreadable unrelated children but rejects unreadable relay arguments (#9044)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import builtins, importlib.util, io, json, sys, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = (41, 333)
manager_pid = 40
helper_pid = 42
relay_pid = 43
relay_arguments = [
    b"socat",
    b"TCP-LISTEN:8645,bind=0.0.0.0,fork,reuseaddr",
    b"TCP:127.0.0.1:18642",
]

class ProcessEntries:
    def __enter__(self):
        return iter(types.SimpleNamespace(name=str(pid)) for pid in (41, helper_pid, relay_pid))
    def __exit__(self, *_args):
        return False

def run_case(helper_name):
    process_names = {
        manager_pid: "bash",
        41: "python3",
        helper_pid: helper_name,
        relay_pid: "socat",
    }
    parents = {41: manager_pid, helper_pid: manager_pid, relay_pid: manager_pid}
    command_lines = {
        manager_pid: module.SERVICE_MANAGER_PATH + b"\\0",
        relay_pid: b"\\0".join(relay_arguments) + b"\\0",
    }
    command_line_reads = []
    real_open = builtins.open

    def fake_open(path, mode="r", *args, **kwargs):
        raw_path = str(path)
        fields = raw_path.split("/")
        if len(fields) == 4 and fields[1] == "proc":
            pid = int(fields[2])
            if fields[3] == "status":
                status = f"Name:\\t{process_names[pid]}\\nPPid:\\t{parents[pid]}\\n"
                if "b" in mode:
                    return io.BytesIO(status.encode("utf-8"))
                return io.StringIO(status)
            if fields[3] == "cmdline":
                command_line_reads.append(pid)
                if pid == helper_pid:
                    raise PermissionError("helper arguments denied")
                return io.BytesIO(command_lines[pid])
        return real_open(path, mode, *args, **kwargs)

    module.os.geteuid = lambda: 1000
    module.os.scandir = lambda path: ProcessEntries()
    module.os.stat = lambda path: types.SimpleNamespace(st_uid=1000)
    module._process_start_identity = lambda pid: 101 if pid == manager_pid else 200 + pid
    module._gateway_identity = lambda: identity
    builtins.open = fake_open
    try:
        try:
            outcome = {"port": module._managed_api_relay_public_port(identity)}
        except Exception as error:
            outcome = {"error": [type(error).__name__, str(error)]}
    finally:
        builtins.open = real_open
    outcome["helper_arguments_read"] = helper_pid in command_line_reads
    return outcome

print(json.dumps({
    "unrelated_child": run_case("sleep"),
    "relay_named_child": run_case("socat"),
}, sort_keys=True))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      relay_named_child: {
        error: ["PermissionError", "Hermes managed API relay identity is unavailable"],
        helper_arguments_read: true,
      },
      unrelated_child: { helper_arguments_read: false, port: 8645 },
    });
  });

  it("accepts allocated relay ports and rejects forged relay topology (#9044)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, sys, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = (41, 333)
manager_pid = 40
relay_pid = 42
exact_arguments = [
    b"socat",
    b"TCP-LISTEN:8645,bind=0.0.0.0,fork,reuseaddr",
    b"TCP:127.0.0.1:18642",
]

def relay_arguments(raw):
    return [
        b"socat",
        module.MANAGED_API_RELAY_LISTEN_PREFIX + raw + module.MANAGED_API_RELAY_LISTEN_SUFFIX,
        module.MANAGED_API_RELAY_TARGET,
    ]

class ProcessEntries:
    def __enter__(self):
        return iter((types.SimpleNamespace(name="41"), types.SimpleNamespace(name="42")))
    def __exit__(self, *_args):
        return False

def run_candidate(owner=1000, parent=manager_pid, arguments=exact_arguments):
    owners = {manager_pid: 1000, relay_pid: owner}
    module.os.geteuid = lambda: 1000
    module.os.scandir = lambda path: ProcessEntries()
    module.os.stat = lambda path: types.SimpleNamespace(st_uid=owners[int(path.rsplit("/", 1)[1])])
    module._process_parent_pid = lambda pid: manager_pid if pid == 41 else parent
    module._process_name = lambda pid: module.MANAGED_API_RELAY_PROCESS_NAME
    module._process_arguments = lambda pid: [module.SERVICE_MANAGER_PATH] if pid == manager_pid else arguments
    module._process_start_identity = lambda pid: 101 if pid == manager_pid else 202
    module._gateway_identity = lambda: identity
    try:
        module._managed_api_relay_public_port(identity)
    except Exception as error:
        return type(error).__name__, str(error)
    raise AssertionError("untrusted relay topology was accepted")

accepted = [module._managed_api_relay_port(relay_arguments(raw)) for raw in (b"8642", b"8645", b"8652")]

rejected = []
for arguments in (
    relay_arguments(b"8641"),
    relay_arguments(b"8653"),
    relay_arguments("²".encode("utf-8")),
    [b"socat", b"TCP-LISTEN:8645,reuseaddr", module.MANAGED_API_RELAY_TARGET],
):
    try:
        module._managed_api_relay_port(arguments)
    except PermissionError as error:
        rejected.append(str(error))

print(json.dumps({
    "accepted": accepted,
    "rejected": rejected,
    "wrong_owner": run_candidate(owner=2000),
    "wrong_parent": run_candidate(parent=99),
    "wrong_executable": run_candidate(arguments=[b"fake-socat", *exact_arguments[1:]]),
    "wrong_target": run_candidate(arguments=[*exact_arguments[:2], b"TCP:127.0.0.1:18780"]),
}))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      accepted: [8642, 8645, 8652],
      rejected: [
        "Hermes API port is outside the allocated range",
        "Hermes API port is outside the allocated range",
        "Hermes managed API relay port is malformed",
        "Hermes managed API relay arguments are malformed",
      ],
      wrong_executable: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
      wrong_owner: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
      wrong_parent: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
      wrong_target: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
    });
  });

  it("classifies changed relay topology as not ready and rejects ambiguous or unreadable topology (#9044)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, sys, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
identity = (41, 333)
manager_pid = 40
relay_arguments = [
    b"socat",
    b"TCP-LISTEN:8645,bind=0.0.0.0,fork,reuseaddr",
    b"TCP:127.0.0.1:18642",
]

class ProcessEntries:
    def __init__(self, pids):
        self.pids = pids
    def __enter__(self):
        return iter(types.SimpleNamespace(name=str(pid)) for pid in self.pids)
    def __exit__(self, *_args):
        return False

def run_case(mutation):
    relay_pids = (
        []
        if mutation == "missing"
        else [42, 43]
        if mutation in ("ambiguous", "candidate_start_exit")
        else [42]
    )
    counters = {
        "gateway_parent": 0,
        "manager_arguments": 0,
        "manager_start": 0,
        "manager_stat": 0,
        "relay_start": 0,
    }
    module.os.geteuid = lambda: 1000

    if mutation == "process_table":
        module.os.scandir = lambda path: (_ for _ in ()).throw(PermissionError("denied"))
    else:
        module.os.scandir = lambda path: ProcessEntries([41, *relay_pids])

    def process_stat(path):
        pid = int(path.rsplit("/", 1)[1])
        if pid == manager_pid:
            counters["manager_stat"] += 1
            changed = mutation == "manager_owner" and counters["manager_stat"] > 1
            return types.SimpleNamespace(st_uid=1001 if changed else 1000)
        return types.SimpleNamespace(st_uid=1000)

    def parent_pid(pid):
        if pid == 41:
            counters["gateway_parent"] += 1
            if mutation == "gateway_parent" and counters["gateway_parent"] > 1:
                return 99
        return manager_pid

    def process_arguments(pid):
        if pid == manager_pid:
            counters["manager_arguments"] += 1
            if mutation == "manager_arguments" and counters["manager_arguments"] > 1:
                return [b"/tmp/unmanaged-start"]
            return [module.SERVICE_MANAGER_PATH]
        return relay_arguments

    def process_start(pid):
        if pid == manager_pid:
            counters["manager_start"] += 1
            if mutation == "manager_start" and counters["manager_start"] > 1:
                return 102
            return 101
        counters["relay_start"] += 1
        if mutation == "candidate_start_exit" and counters["relay_start"] == 1:
            raise FileNotFoundError("relay exited")
        if mutation == "candidate_start_denied":
            raise PermissionError("relay start identity denied")
        if mutation == "relay_start" and counters["relay_start"] > 1:
            return 203
        return 202 + (pid - 42)

    module.os.stat = process_stat
    module._process_parent_pid = parent_pid
    module._process_name = lambda pid: module.MANAGED_API_RELAY_PROCESS_NAME
    module._process_arguments = process_arguments
    module._process_start_identity = process_start
    module._gateway_identity = lambda: identity
    try:
        port = module._managed_api_relay_public_port(identity)
    except Exception as error:
        return type(error).__name__, str(error)
    if mutation == "candidate_start_exit":
        return port
    raise AssertionError("unstable relay topology was accepted")

results = {case: run_case(case) for case in (
    "missing",
    "candidate_start_exit",
    "candidate_start_denied",
    "relay_start",
    "manager_owner",
    "manager_arguments",
    "manager_start",
    "gateway_parent",
    "ambiguous",
    "process_table",
)}
print(json.dumps(results, sort_keys=True))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ambiguous: ["PermissionError", "Hermes managed API relay identity is ambiguous"],
      candidate_start_denied: [
        "PermissionError",
        "Hermes managed API relay identity is unavailable",
      ],
      candidate_start_exit: 8645,
      gateway_parent: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
      manager_arguments: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
      manager_owner: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
      manager_start: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
      missing: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
      process_table: ["PermissionError", "Hermes process table is unavailable"],
      relay_start: ["RuntimeError", "Hermes gateway is not running for managed MCP reload"],
    });
  });

  it("rejects a marker that the sandbox user could have shaped (#8543)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, os, pathlib, sys, tempfile, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

temporary = tempfile.TemporaryDirectory()
root = pathlib.Path(temporary.name)
module.GATEWAY_PUBLIC_PORT_PATH = str(root / "hermes-api-port")
absent = module._root_gateway_public_port_marker()

def stage_writable_mode(path):
    path.write_bytes(b"8645")
    path.chmod(0o644)

def stage_extra_hard_link(path):
    path.write_bytes(b"8645")
    path.chmod(0o444)
    os.link(path, path.parent / "extra-link")

def stage_oversized_record(path):
    path.write_bytes(b"8" * 64)
    path.chmod(0o444)

class RootOwnedStat:
    def __init__(self, real):
        self._real = real
        self.st_uid = 0
        self.st_gid = 0

    def __getattr__(self, name):
        return getattr(self._real, name)

class SandboxOwnedStat(RootOwnedStat):
    def __init__(self, real):
        super().__init__(real)
        self.st_uid = 1000
        self.st_gid = 1000

real_fstat = module.os.fstat

unsafe = []
for index, stage in enumerate(
    (stage_writable_mode, stage_extra_hard_link, stage_oversized_record)
):
    directory = root / f"case-{index}"
    directory.mkdir()
    marker = directory / "hermes-api-port"
    stage(marker)
    module.GATEWAY_PUBLIC_PORT_PATH = str(marker)
    module.os.fstat = lambda descriptor: RootOwnedStat(real_fstat(descriptor))
    try:
        module._root_gateway_public_port_marker()
    except PermissionError as error:
        unsafe.append(str(error))
    finally:
        module.os.fstat = real_fstat

accepted = root / "accepted"
accepted.mkdir()
sound_marker = accepted / "hermes-api-port"
sound_marker.write_bytes(b"8645")
sound_marker.chmod(0o444)
module.GATEWAY_PUBLIC_PORT_PATH = str(sound_marker)
module.os.fstat = lambda descriptor: RootOwnedStat(real_fstat(descriptor))
try:
    sound = module._root_gateway_public_port_marker()
finally:
    module.os.fstat = real_fstat

owned = root / "owned"
owned.mkdir()
owned_marker = owned / "hermes-api-port"
owned_marker.write_bytes(b"8645")
owned_marker.chmod(0o444)
module.GATEWAY_PUBLIC_PORT_PATH = str(owned_marker)
module.os.fstat = lambda descriptor: SandboxOwnedStat(real_fstat(descriptor))
non_root_owner = ""
try:
    module._root_gateway_public_port_marker()
except PermissionError as error:
    non_root_owner = str(error)
finally:
    module.os.fstat = real_fstat

linked = root / "linked"
linked.mkdir()
target = linked / "hermes-api-port"
target.write_bytes(b"8645")
target.chmod(0o444)
symlink = linked / "symlink"
symlink.symlink_to(target)
module.GATEWAY_PUBLIC_PORT_PATH = str(symlink)
followed = ""
try:
    module._root_gateway_public_port_marker()
except PermissionError as error:
    followed = str(error)

temporary.cleanup()

print(json.dumps({
    "absent": absent,
    "sound": sound,
    "unsafe": unsafe,
    "followed": followed,
    "non_root_owner": non_root_owner,
}))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      absent: null,
      sound: 8645,
      unsafe: [
        "Hermes API port marker is unsafe",
        "Hermes API port marker is unsafe",
        "Hermes API port marker is unsafe",
      ],
      followed: "Hermes API port marker cannot be opened safely",
      non_root_owner: "Hermes API port marker is unsafe",
    });
  });

  it("prefers the root marker over managed relay discovery (#8543)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, sys, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._gateway_identity = lambda: (41, 333)
module._managed_api_relay_public_port = lambda identity: 8649

module._root_gateway_public_port_marker = lambda: 8647
marker_wins = module._resolve_gateway_public_port()

module._root_gateway_public_port_marker = lambda: None
real_geteuid = module.os.geteuid

module.os.geteuid = lambda: 0
root_without_marker = ""
try:
    module._resolve_gateway_public_port()
except PermissionError as error:
    root_without_marker = str(error)

module.os.geteuid = lambda: 1000
same_uid_relay = module._resolve_gateway_public_port()

module._gateway_identity = lambda: None
without_identity = ""
try:
    module._resolve_gateway_public_port()
except RuntimeError as error:
    without_identity = str(error)

module.os.geteuid = real_geteuid

print(json.dumps({
    "marker_wins": marker_wins,
    "root_without_marker": root_without_marker,
    "same_uid_relay": same_uid_relay,
    "without_identity": without_identity,
}))
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      marker_wins: 8647,
      root_without_marker: "Hermes root API port marker is unavailable",
      same_uid_relay: 8649,
      without_identity: "Hermes gateway is not running for managed MCP reload",
    });
  });

  it("fails the probe with exit code 2 when the port cannot be resolved (#8543)", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, pathlib, sys, tempfile, types
sys.modules["yaml"] = types.SimpleNamespace(YAMLError=type("YAMLError", (Exception,), {}))
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as temp_dir:
    module.GATEWAY_PUBLIC_PORT_PATH = str(pathlib.Path(temp_dir) / "absent-marker")
    module.os.geteuid = lambda: 0
    sys.argv = ["mcp-config-transaction.py", "probe"]
    raise SystemExit(module.main())
`,
        TRANSACTION,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("Hermes root API port marker is unavailable");
    expect(result.stdout).toBe("");
  });
});
