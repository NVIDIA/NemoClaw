// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TRANSACTION = path.resolve(
  import.meta.dirname,
  "..",
  "agents/hermes/mcp-config-transaction.py",
);

describe("Hermes MCP API port resolution", () => {
  it("accepts only allocated ports from the stable service-manager environment (#8543)", () => {
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
module._gateway_identity = lambda: identity
module._process_parent_pid = lambda pid: 40
module._is_service_manager_process = lambda pid: True

accepted = []
for raw in (b"8642", b"8645", b"8652"):
    module._read_service_manager_environment = (
        lambda pid, value=raw: b"PATH=/usr/bin\\0NEMOCLAW_HERMES_API_PORT="
        + value
        + b"\\0"
    )
    accepted.append(module._service_manager_gateway_public_port(identity))

rejected = []
for raw in (
    b"8641",
    b"8653",
    "²".encode("utf-8"),
    b"8645\\0NEMOCLAW_HERMES_API_PORT=8646",
):
    module._read_service_manager_environment = (
        lambda pid, value=raw: b"NEMOCLAW_HERMES_API_PORT=" + value + b"\\0"
    )
    try:
        module._service_manager_gateway_public_port(identity)
    except PermissionError as error:
        rejected.append(str(error))

module._read_service_manager_environment = lambda pid: b"PATH=/usr/bin\\0"
absent = module._service_manager_gateway_public_port(identity)

module._gateway_identity = lambda: (41, 999)
module._read_service_manager_environment = (
    lambda pid: b"NEMOCLAW_HERMES_API_PORT=8645\\0"
)
identity_change = ""
try:
    module._service_manager_gateway_public_port(identity)
except PermissionError as error:
    identity_change = str(error)

print(json.dumps({
    "accepted": accepted,
    "rejected": rejected,
    "absent": absent,
    "identity_change": identity_change,
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
        "Hermes service-manager API port is malformed",
        "Hermes service-manager API port is ambiguous",
      ],
      absent: 8642,
      identity_change: "Hermes service-manager identity changed while reading",
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

  it("prefers the marker over the service-manager environment (#8543)", () => {
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
module._service_manager_gateway_public_port = lambda identity: 8649

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
same_uid_fallback = module._resolve_gateway_public_port()

module._gateway_identity = lambda: None
without_identity = ""
try:
    module._resolve_gateway_public_port()
except PermissionError as error:
    without_identity = str(error)

module.os.geteuid = real_geteuid

print(json.dumps({
    "marker_wins": marker_wins,
    "root_without_marker": root_without_marker,
    "same_uid_fallback": same_uid_fallback,
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
      same_uid_fallback: 8649,
      without_identity: "Hermes gateway identity is unavailable",
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
