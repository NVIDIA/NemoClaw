// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const patcher = path.resolve(
  import.meta.dirname,
  "../../../agents/hermes/patch-gateway-native-restart.py",
);

function runPython(source: string) {
  const transaction = path.resolve(
    import.meta.dirname,
    "../../../agents/hermes/mcp-config-transaction.py",
  );
  return spawnSync("python3", ["-c", source, transaction], { encoding: "utf8", timeout: 5000 });
}

describe("Hermes native planned restart", () => {
  it("re-executes only after planned restart teardown and preserves ordinary exits", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hermes-native-restart-"));
    const fixture = path.join(directory, "gateway.py");
    try {
      writeFileSync(
        fixture,
        `import json, types
calls = []
def execv(command, argv):
    calls.append(["exec", command, argv])
    raise SystemExit(0)
os = types.SimpleNamespace(execv=execv, _exit=lambda code: calls.append(["exit", code]))
def finish(exit_code):
    calls.append(["teardown", exit_code])
    os._exit(exit_code)
for code in [0, 1, 75]:
    try:
        finish(code)
    except SystemExit:
        pass
print(json.dumps(calls))
`,
      );
      const first = spawnSync("python3", ["-I", patcher, fixture], { encoding: "utf8" });
      expect(first.status, first.stderr).toBe(0);
      const repeated = spawnSync("python3", ["-I", patcher, fixture], { encoding: "utf8" });
      expect(repeated.status, repeated.stderr).toBe(0);
      const result = spawnSync("python3", ["-I", fixture], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        ["teardown", 0],
        ["exit", 0],
        ["teardown", 1],
        ["exit", 1],
        ["teardown", 75],
        ["exec", "/usr/local/bin/hermes", ["hermes", "gateway", "run"]],
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("routes the public restart command through guarded acknowledged reload", () => {
    const wrapper = path.resolve(import.meta.dirname, "../../../agents/hermes/hermes-wrapper.py");
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("wrapper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module._resolve_real_hermes = lambda: "/trusted/hermes.real"
module._resolve_guard = lambda: "/trusted/guard"
module.os.geteuid = lambda: 1000
module.os.environ["HERMES_LAZY_INSTALL_TARGET"] = "/trusted/deps"
calls = []
module._run_gateway_env_file_guard = lambda path: calls.append("env-guard") or 0
module._run_gateway_guard = lambda path: calls.append("config-guard") or 0
module._harden_gateway_package_env = lambda path: None
def execv(path, argv):
    calls.append([path, argv])
    raise SystemExit(0)
module.os.execv = execv
try:
    module.main(["gateway", "restart"])
except SystemExit:
    pass
print(json.dumps(calls))
`,
        wrapper,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const helper = "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";
    expect(JSON.parse(result.stdout)).toEqual([
      "env-guard",
      "config-guard",
      [helper, [helper, "reload"]],
    ]);
  });

  it("rejects an upstream exit implementation that no longer matches", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "hermes-native-restart-"));
    try {
      const fixture = path.join(directory, "gateway.py");
      writeFileSync(fixture, "raise SystemExit(75)\n");
      const result = spawnSync("python3", ["-I", patcher, fixture], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("review the restart patch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("acknowledges explicit reload only after lifecycle checks and runtime completion", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
calls = []
module.probe = lambda: calls.append("probe") or {"ok": True}
module.reload_gateway = lambda: calls.append("reload") or True
sys.argv = [sys.argv[1], "reload"]
code = module.main()
print(json.dumps({"code": code, "calls": calls}))
`);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { ok: true, changed: false, reloaded: true },
      { code: 0, calls: ["probe", "reload"] },
    ]);
  });

  it("waits for new runtime metadata when Hermes re-executes with the same PID", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_identity = lambda: (123, 456)
module._gateway_has_managed_parent = lambda pid: True
generations = iter([(1, 10, 20, 20), (1, 10, 20, 20), (1, 11, 30, 30), (1, 11, 30, 30)])
module._gateway_runtime_generation = lambda: next(generations)
module._gateway_health_phase = lambda deadline: (True, "waiting-for-stable-replacement-identity")
module.time.monotonic = lambda: 0
sleeps = []
module.time.sleep = sleeps.append
module.os.kill = lambda pid, signal: None
print(json.dumps({"reloaded": module.reload_gateway(), "sleeps": sleeps}))
`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ reloaded: true, sleeps: [1] });
  });
});
