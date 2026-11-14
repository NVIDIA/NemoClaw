// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { mutableHermesConfigProbeCommand } from "../../../src/lib/sandbox/mutable-config-perms";
import { extractShellFunction } from "../../support/hermes-shell-harness";

const helper = path.resolve(import.meta.dirname, "../../../agents/hermes/startup-completion.py");

function probe(body: string) {
  return spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `
import importlib.util, json, os, pathlib, tempfile
spec = importlib.util.spec_from_file_location("completion", ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
observe_process = m.process_identity
supervisor = {"pid": os.getppid(), "parent": 1, "start": "10"}
gateway = {"pid": 999999, "parent": os.getppid(), "start": "20"}
identities = {supervisor["pid"]: supervisor, gateway["pid"]: gateway}
m.process_identity = lambda pid: identities.get(pid)
with tempfile.TemporaryDirectory() as root:
    os.chown(root, os.geteuid(), os.getegid())
    receipt = str(pathlib.Path(root) / "completion.json")
    def publish():
        m.publish_completion(gateway["pid"], receipt)
    def rejected(action, message):
        try:
            action()
        except (RuntimeError, OSError) as error:
            assert message in str(error), str(error)
        else:
            raise AssertionError("unsafe receipt was accepted")
${body
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
`,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
}

describe("Hermes supervisor startup completion", () => {
  it
    .skipIf(process.platform !== "linux" || process.getuid?.() === 0)
    .each(["live", "missing", "mismatched"])(
    "binds the non-root startup probe to the %s supervisor receipt",
    (condition) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-startup-handoff-"));
      const configDir = path.join(root, "config");
      const configPath = path.join(configDir, "config.yaml");
      const receipt = path.join(root, "completion.json");
      const inspection = path.join(root, "inspected");
      const publisher = path.join(root, "completion.py");
      const consumer = path.join(root, "probe.py");
      fs.mkdirSync(configDir);
      fs.chmodSync(configDir, 0o3770);
      fs.writeFileSync(configPath, "fixture\n", { mode: 0o640 });
      fs.chmodSync(configPath, 0o640);
      // Relocate installed paths only; retain real /proc identities and receipt validation.
      fs.writeFileSync(
        publisher,
        fs
          .readFileSync(helper, "utf8")
          .replace(
            'RECEIPT = "/tmp/nemoclaw-hermes-startup-complete.json"',
            `RECEIPT = ${JSON.stringify(receipt)}`,
          ),
      );
      const command = mutableHermesConfigProbeCommand({
        agentName: "hermes",
        configDir,
        configPath,
        configFile: "config.yaml",
        format: "yaml",
        sensitiveFiles: [],
      });
      fs.writeFileSync(
        consumer,
        `
import json, os, pathlib, pwd, runpy, types
pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())
load_helper = runpy.run_path
completion = load_helper(${JSON.stringify(publisher)})
receipt = ${JSON.stringify(receipt)}
if ${JSON.stringify(condition)} == "missing":
    os.unlink(receipt)
elif ${JSON.stringify(condition)} == "mismatched":
    value = json.loads(pathlib.Path(receipt).read_text())
    value["gateway"]["start"] = str(int(value["gateway"]["start"]) + 1)
    pathlib.Path(receipt).write_text(json.dumps(value))
else:
    value = completion["read_completion"]()
    assert value["supervisor"] == completion["process_identity"](os.getppid())
    assert value["gateway"]["parent"] == os.getppid()
def installed_helper(name):
    assert name == "/usr/local/lib/nemoclaw/hermes-startup-completion.py"
    return {**completion,
        "requires_completion": lambda: completion["requires_completion"](${JSON.stringify(path.join(root, "root-lifecycle"))}),
        "wait_for_completion": lambda: completion["wait_for_completion"](timeout=0.2)}
runpy.run_path = installed_helper
observe_stat = os.stat
def record_inspection(name, *args, **kwargs):
    if name == ${JSON.stringify(configDir)}:
        pathlib.Path(${JSON.stringify(inspection)}).touch()
    return observe_stat(name, *args, **kwargs)
os.stat = record_inspection
${command[command.indexOf("-c") + 1]}
`,
      );
      const source = fs.readFileSync(path.join(path.dirname(helper), "start.sh"), "utf8");
      const start = source.indexOf(
        'if [ "$(id -u)" -ne 0 ]; then\n  echo "[gateway] Running as non-root',
      );
      const end = source.indexOf("# ── Root path (full privilege separation", start);
      const script = [
        "set -euo pipefail",
        "NEMOCLAW_CMD=()",
        `HERMES_DIR=${shellQuote(configDir)}`,
        '_HERMES_PYTHON="$(command -v python3)"',
        `_HERMES_STARTUP_COMPLETION=${shellQuote(publisher)}`,
        ...[
          "prepare_hermes_nonroot_runtime",
          "cleanup_stale_hermes_gateway_runtime",
          "prepare_restricted_log",
          "validate_tmp_permissions",
          "start_gateway_log_stream",
          "wait_for_hermes_gateway_internal",
          "ensure_hermes_supervised_auxiliaries",
          "print_dashboard_urls",
        ].map((name) => `${name}() { :; }`),
        "launch_hermes_gateway_current_user() { sleep 30 & GATEWAY_PID=$!; }",
        `finalize_tirith_marker_retry() { printf 'startup complete\\n' >>${shellQuote(configPath)}; }`,
        extractShellFunction(source, "publish_hermes_startup_completion"),
        `supervise_hermes_service_restarts_current_user() { "$_HERMES_PYTHON" -I ${shellQuote(consumer)} ${command
          .slice(command.indexOf("-c") + 2)
          .map(shellQuote)
          .join(" ")}; }`,
        'trap \'if [ -n "${GATEWAY_PID:-}" ]; then kill "$GATEWAY_PID" 2>/dev/null || true; wait "$GATEWAY_PID" 2>/dev/null || true; fi\' EXIT',
        source.slice(start, end),
      ].join("\n");
      try {
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(condition === "live" ? 0 : 1);
        expect(fs.existsSync(inspection)).toBe(condition === "live");
        expect(result.stderr.includes("startup completion was not observed")).toBe(
          condition !== "live",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps the separate root startup protocol and rejects an untrusted root marker", () => {
    const result = probe(`
import stat, types
marker = str(pathlib.Path(root) / "root-lifecycle")
assert m.requires_completion(marker)
pathlib.Path(marker).write_text("root-separated\\n")
os.chmod(marker, 0o444)
rejected(lambda: m.requires_completion(marker), "Invalid Hermes root lifecycle marker")
real_fstat = os.fstat
def root_marker_metadata(fd):
    value = real_fstat(fd)
    return types.SimpleNamespace(st_mode=value.st_mode, st_nlink=value.st_nlink, st_uid=0, st_gid=0)
os.fstat = root_marker_metadata
assert not m.requires_completion(marker)
os.chmod(marker, 0o644)
rejected(lambda: m.requires_completion(marker), "Invalid Hermes root lifecycle marker")
os.fstat = real_fstat
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("observes process start identity and rejects dead or differently owned processes", () => {
    const result = probe(`
proc = pathlib.Path(root) / "123"
proc.mkdir()
fields = ["S", "100"] + ["0"] * 17 + ["456"]
def write_stat():
    (proc / "stat").write_text("123 (process name) " + " ".join(fields))
write_stat()
(proc / "status").write_text(f"Uid:\\t{os.geteuid()}\\t{os.geteuid()}\\t{os.geteuid()}\\t{os.geteuid()}\\n")
m.Path = lambda _path: proc
assert observe_process(123) == {"pid": 123, "parent": 100, "start": "456"}
fields[0] = "Z"
write_stat()
assert observe_process(123) is None
fields[0] = "S"
write_stat()
(proc / "status").write_text("Uid:\\t0\\t0\\t0\\t0\\n")
assert observe_process(123) is None
assert observe_process(True) is None
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("waits for publication before inspection and rejects a dead or reused gateway", () => {
    const result = probe(`
assert m.read_completion(receipt) is None
calls = []
def finish_startup(_interval):
    calls.append("finish startup writes")
    publish()
m.time.sleep = finish_startup
observed = m.wait_for_completion(path=receipt)
assert calls == ["finish startup writes"]
assert observed["gateway"] == gateway
identities.pop(gateway["pid"])
assert m.read_completion(receipt) is None
identities[gateway["pid"]] = {**gateway, "start": "21"}
assert m.read_completion(receipt) is None
rejected(lambda: m.wait_for_completion(timeout=0, path=receipt), "completion was not observed")
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["symlink", "hardlink", "writable", "malformed", "parent", "oversized"])(
    "rejects a %s receipt without replacing it",
    (kind) => {
      const result = probe(`
publish()
kind = ${JSON.stringify(kind)}
if kind == "symlink":
    os.rename(receipt, receipt + ".target")
    os.symlink(receipt + ".target", receipt)
elif kind == "hardlink":
    os.link(receipt, receipt + ".link")
elif kind == "writable":
    os.chmod(receipt, 0o666)
elif kind == "malformed":
    pathlib.Path(receipt).write_text("{broken")
elif kind == "parent":
    value = json.loads(pathlib.Path(receipt).read_text())
    value["gateway"]["parent"] += 1
    pathlib.Path(receipt).write_text(json.dumps(value))
elif kind == "oversized":
    pathlib.Path(receipt).write_text("x" * 1025)
before = os.lstat(receipt)
rejected(lambda: m.read_completion(receipt), "")
rejected(publish, "")
assert os.lstat(receipt) == before
`);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("rejects a receipt replaced while its descriptor is being read", () => {
    const result = probe(`
publish()
read = os.read
def raced_read(fd, count):
    data = read(fd, count)
    os.rename(receipt, receipt + ".old")
    pathlib.Path(receipt).write_bytes(data)
    os.chmod(receipt, 0o600)
    return data
os.read = raced_read
rejected(lambda: m.read_completion(receipt), "changed while reading")
`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("refuses publication when the gateway is no longer the supervisor's child", () => {
    const result = probe(`
identities[gateway["pid"]] = {**gateway, "parent": 5}
rejected(publish, "live supervised gateway")
assert not os.path.exists(receipt)
`);
    expect(result.status, result.stderr).toBe(0);
  });
});
