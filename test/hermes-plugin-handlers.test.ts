// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PLUGIN_PATH = path.join(import.meta.dirname, "..", "agents", "hermes", "plugin", "__init__.py");

function runPython(script: string): string {
  return execFileSync("python3", ["-c", script, PLUGIN_PATH], {
    encoding: "utf-8",
  });
}

describe("Hermes NemoClaw plugin handlers", () => {
  it("accepts Hermes dispatch kwargs for status, info, and reload handlers", () => {
    const output = runPython(`
import importlib.util
import json
import pathlib
import sys
import types

plugin_path = pathlib.Path(sys.argv[1])
yaml_stub = types.ModuleType("yaml")
yaml_stub.safe_load = lambda *_args, **_kwargs: {}
sys.modules.setdefault("yaml", yaml_stub)
spec = importlib.util.spec_from_file_location("hermes_plugin", plugin_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

module._get_sandbox_info = lambda: {
    "agent": "hermes",
    "model": "nemotron",
    "provider": "nvidia",
    "base_url": "http://localhost:8642/v1",
    "gateway": "running",
    "port": 8642,
}
module._reload_skills = lambda: {
    "alpha": {"description": "First skill"},
    "beta": {"description": "Second skill"},
}

result = {
    "status": module._handle_status({}, None, task_id="t-123", session_id="s-456"),
    "info": json.loads(module._handle_info({}, None, task_id="t-123", user_task="inspect")),
    "reload": module._handle_reload_skills({}, None, task_id="t-123", session_id="s-456"),
}
print(json.dumps(result))
`);

    const result = JSON.parse(output) as {
      status: string;
      info: Record<string, unknown>;
      reload: string;
    };

    expect(result.status).toContain("NemoClaw Sandbox Status (Hermes)");
    expect(result.status).toContain("Gateway:  running");
    expect(result.info).toMatchObject({
      agent: "hermes",
      model: "nemotron",
      provider: "nvidia",
      gateway: "running",
      port: 8642,
    });
    expect(result.reload).toContain("Skill reload complete. 2 skill(s) discovered:");
    expect(result.reload).toContain("alpha: First skill");
    expect(result.reload).toContain("beta: Second skill");
  });
});

// Regression guard: the Hermes Dockerfile must create a symlink from the
// immutable /sandbox/.hermes/.hermes_history to the writable data dir so
// prompt_toolkit can persist TUI history even though /sandbox/.hermes is
// root-owned at runtime. See issue #2432.
describe("Hermes Dockerfile history symlink (regression #2432)", () => {
  const HERMES_DOCKERFILE = path.join(
    import.meta.dirname,
    "..",
    "agents",
    "hermes",
    "Dockerfile",
  );

  it("creates .hermes_history symlink pointing to writable data dir before directory is locked", () => {
    const src = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");

    // The symlink must be created (ln -s ... .hermes_history)
    expect(src).toContain(".hermes/.hermes_history");
    expect(src).toContain(".hermes-data/.hermes_history");

    // The symlink line must appear BEFORE the chown step that locks .hermes,
    // otherwise the root:root chown will own the target file, not the symlink.
    const symlinkIdx = src.indexOf(".hermes/.hermes_history");
    const chownIdx = src.indexOf("chown root:root /sandbox/.hermes");
    expect(symlinkIdx).toBeGreaterThanOrEqual(0);
    expect(chownIdx).toBeGreaterThanOrEqual(0);
    expect(symlinkIdx).toBeLessThan(chownIdx);
  });
});
