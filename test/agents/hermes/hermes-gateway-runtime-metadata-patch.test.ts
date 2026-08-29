// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCHER = path.join(ROOT, "agents", "hermes", "patch-gateway-runtime-metadata.py");
const MCP_TRANSACTION = path.join(ROOT, "agents", "hermes", "mcp-config-transaction.py");

const UPSTREAM_FIXTURE = `from pathlib import Path
from typing import Optional

HOME = Path(__file__).parent / "hermes-home"
_GATEWAY_LOCK_FILENAME = "gateway.lock"
_RUNTIME_STATUS_FILE = "gateway_state.json"

def _get_process_hermes_home() -> Path:
    return HOME

def _get_pid_path() -> Path:
    """Return the path to the gateway PID file, respecting HERMES_HOME."""
    home = _get_process_hermes_home()
    return home / "gateway.pid"

def _get_gateway_lock_path(pid_path: Optional[Path] = None) -> Path:
    """Return the path to the runtime gateway lock file."""
    if pid_path is not None:
        return pid_path.with_name(_GATEWAY_LOCK_FILENAME)
    home = _get_process_hermes_home()
    return home / _GATEWAY_LOCK_FILENAME

def _get_runtime_status_path() -> Path:
    """Return the persisted runtime health/status file path."""
    return _get_pid_path().with_name(_RUNTIME_STATUS_FILE)

if __name__ == "__main__":
    print(_get_pid_path())
    print(_get_gateway_lock_path())
    print(_get_runtime_status_path())
`;

function runPatcher(fixture: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-metadata-"));
  const statusPath = path.join(tmp, "status.py");
  fs.writeFileSync(statusPath, fixture);
  const result = spawnSync("python3", ["-I", PATCHER, statusPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return { result, statusPath, tmp };
}

describe("Hermes writable gateway runtime metadata", () => {
  it("relocates every central gateway metadata reader and remains idempotent", () => {
    const { result, statusPath, tmp } = runPatcher(UPSTREAM_FIXTURE);
    try {
      expect(result.status, result.stderr).toBe(0);
      const second = spawnSync("python3", ["-I", PATCHER, statusPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(second.status, second.stderr).toBe(0);

      const probe = spawnSync("python3", ["-I", statusPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(probe.status, probe.stderr).toBe(0);
      expect(
        probe.stdout
          .trim()
          .split("\n")
          .map((entry) => path.relative(tmp, entry)),
      ).toEqual([
        "hermes-home/runtime/gateway.pid",
        "hermes-home/runtime/gateway.lock",
        "hermes-home/runtime/gateway_state.json",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the pinned Hermes helper shape changes", () => {
    const drifted = UPSTREAM_FIXTURE.replace(
      'return home / "gateway.pid"',
      'return home / "changed-gateway.pid"',
    );
    const { result, statusPath, tmp } = runPatcher(drifted);
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("gateway runtime metadata source shape changed");
      expect(fs.readFileSync(statusPath, "utf-8")).toBe(drifted);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects the obsolete Hermes 0.18 home selector", () => {
    const obsolete = UPSTREAM_FIXTURE.replaceAll("_get_process_hermes_home()", "get_hermes_home()");
    const { result, statusPath, tmp } = runPatcher(obsolete);
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("gateway runtime metadata source shape changed");
      expect(fs.readFileSync(statusPath, "utf-8")).toBe(obsolete);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the managed MCP identity reader on the relocated PID record", () => {
    const source = fs.readFileSync(MCP_TRANSACTION, "utf-8");
    expect(source).toContain('GATEWAY_PID_PATH = f"{HERMES_DIR}/runtime/gateway.pid"');
    expect(source).not.toContain('GATEWAY_PID_PATH = f"{HERMES_DIR}/gateway.pid"');
  });
});
