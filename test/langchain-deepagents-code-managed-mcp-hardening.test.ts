// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const patcherPath = path.join(
  process.cwd(),
  "agents",
  "langchain-deepagents-code",
  "patch-managed-deepagents-code.py",
);

function runManagedHelper(source: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-managed-mcp-"));
  const helperPath = path.join(tempDir, "_nemoclaw_managed.py");
  const patcher = fs.readFileSync(patcherPath, "utf-8");
  const helperSource = patcher.match(/HELPER_SOURCE = r'''([\s\S]*?)\n'''/)?.[1];
  expect(helperSource).toBeTypeOf("string");
  fs.writeFileSync(helperPath, helperSource as string, "utf-8");
  try {
    return spawnSync("python3", ["-I", "-c", source, helperPath], {
      encoding: "utf-8",
      timeout: 5000,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("Deep Agents managed MCP runtime hardening", () => {
  it("treats only the exact empty managed projection as an absent snapshot", () => {
    const result = runManagedHelper(String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

tombstone = b'{"mcpServers":{}}\n'
assert managed._canonicalize_managed_mcp_config(tombstone) is None
managed._read_managed_mcp_config = lambda: tombstone
assert managed.managed_mcp_config_path() is None
assert managed._MANAGED_MCP_READY is True
assert managed._MANAGED_MCP_FD is None

invalid = (
    b'{}',
    b'[]',
    b'null',
    b'{"mcpServers":[]}',
    b'{"mcpServers":null}',
    b'{"mcpServers":{},"extra":{}}',
    b'{"mcpServers":{},"mcpServers":{}}',
    b'{"mcpServers":NaN}',
)
for raw in invalid:
    try:
        managed._canonicalize_managed_mcp_config(raw)
    except RuntimeError:
        pass
    else:
        raise AssertionError(f"accepted malformed empty projection: {raw!r}")
print("strict-tombstone-ok")
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("strict-tombstone-ok");
  });

  it("rejects a same-sized fully sealed descriptor not created by this process state", () => {
    const result = runManagedHelper(String.raw`
import fcntl
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("_nemoclaw_managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

raw = b'{"mcpServers":{"github":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer openshell:resolve:env:GITHUB_TOKEN"}}}}'
payload = managed._canonicalize_managed_mcp_config(raw)
assert payload is not None
local_descriptor = managed._sealed_managed_mcp_snapshot(payload)
foreign_descriptor = managed._sealed_managed_mcp_snapshot(payload)
managed._MANAGED_MCP_FD = local_descriptor
managed._MANAGED_MCP_READY = True
local_path = f"/proc/self/fd/{local_descriptor}"
foreign_path = f"/proc/self/fd/{foreign_descriptor}"

assert os.fstat(local_descriptor).st_size == os.fstat(foreign_descriptor).st_size
assert fcntl.fcntl(local_descriptor, fcntl.F_GET_SEALS) == managed._MCP_REQUIRED_SEALS
assert fcntl.fcntl(foreign_descriptor, fcntl.F_GET_SEALS) == managed._MCP_REQUIRED_SEALS
assert managed.managed_mcp_server_descriptor(local_path) == local_descriptor
try:
    managed.managed_mcp_server_descriptor(foreign_path)
except RuntimeError as exc:
    assert "process-local" in str(exc)
else:
    raise AssertionError("foreign sealed descriptor was accepted")
finally:
    os.close(local_descriptor)
    os.close(foreign_descriptor)
print("descriptor-provenance-ok")
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("descriptor-provenance-ok");
  });
});
