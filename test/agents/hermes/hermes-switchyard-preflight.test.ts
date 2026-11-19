// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bashPrintfQ, extractShellFunction } from "../../support/hermes-shell-harness";
import {
  createHermesSwitchyardRoutingIntent,
  fingerprintHermesSwitchyardRouting,
  serializeHermesSwitchyardRouting,
} from "../../../src/lib/hermes-switchyard-routing";
import { switchyardBindingFixture } from "../../helpers/hermes-switchyard";

const helper = path.resolve("agents/hermes/switchyard-preflight.py");
const python = ["python3", "python3.14", "python3.13", "python3.12", "python3.11"].find(
  (candidate) =>
    spawnSync(candidate, ["-I", "-c", "import tomllib"], { timeout: 5000 }).status === 0,
)!;
const routing = createHermesSwitchyardRoutingIntent({
  efficient: { provider: "nvidia-prod", model: "efficient" },
  capable: { provider: "openai-api", model: "capable" },
});
const files = serializeHermesSwitchyardRouting(routing, switchyardBindingFixture(routing));

const fixture = String.raw`
import importlib.util, json, os, pathlib, sys, types, fcntl
spec = importlib.util.spec_from_file_location("preflight", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
directory = pathlib.Path(sys.argv[2])
case = sys.argv[3]
files = json.loads(sys.argv[4])
m.ROOT_UID = os.getuid()
m.DIRECTORY = directory
m.PATHS = {key: directory / path.name for key, path in m.PATHS.items()}
m.LOCK_PATH = directory / "routing.lock"
m.package_identity = lambda: "pinned-package"
m.gateway_pids = lambda: set()
state = {"native": 0, "shutdown": 0, "requests": 0}
def native(path):
    state["native"] += 1
    if case == "invalid-native": raise ValueError("secret-native-diagnostic")
m.validate_native = native
def write(key):
    m.PATHS[key].write_text(files[key])
    m.PATHS[key].chmod(0o444)
if case in ("partial", "mixed", "replay", "symlink", "hardlink", "writable", "parent-writable", "disabled"):
    for key in m.PATHS: write(key)
    first = next(iter(m.PATHS.values()))
    if case == "partial": first.unlink()
    if case == "mixed":
        first.chmod(0o600); first.write_text("interrupted"); first.chmod(0o444)
    if case == "symlink":
        original = directory / "original"; first.rename(original); first.symlink_to(original)
    if case == "hardlink": os.link(first, directory / "alias")
    if case == "writable": first.chmod(0o666)
    if case == "parent-writable": directory.chmod(0o777)
if case == "restrictive-umask": os.umask(0o077)
if case == "untrusted-lock":
    m.LOCK_PATH.touch(mode=0o400)
if case == "live-gateway": m.gateway_pids = lambda: {123}
if case == "concurrent-startup":
    m.LOCK_PATH.touch(mode=0o444)
    held = os.open(m.LOCK_PATH, os.O_RDONLY)
    fcntl.flock(held, fcntl.LOCK_SH | fcntl.LOCK_NB)
if case == "interrupted":
    original = os.replace
    def interrupt(source, target):
        if target == m.PATHS['relayPluginStateJson']: raise OSError('interrupted')
        original(source, target)
    os.replace = interrupt
try:
    m.publish(None if case == "disabled" else files)
    if case != "disabled": assert m.read_installed(files) == files
    state["accepted"] = True
except Exception:
    state["accepted"] = False
state["published"] = sum(path.exists() for path in m.PATHS.values())
state["activation"] = m.PATHS['relayPluginsToml'].exists()
state["fingerprint"] = m.fingerprint(files)
directory.chmod(0o700)
print(json.dumps(state))
`;

function run(caseName: string) {
  // Root and user ancestors are accepted only by this imported test module's
  // ROOT_UID seam. Production always requires uid 0 and has no environment override.
  const directory = fs.mkdtempSync(path.resolve(".switchyard-preflight-test-"));
  try {
    const result = spawnSync(
      python,
      ["-I", "-c", fixture, helper, directory, caseName, JSON.stringify(files)],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("protected Switchyard publication", () => {
  it("publishes a fully validated configuration and matches the host fingerprint (#13864)", () => {
    expect(run("valid")).toMatchObject({
      accepted: true,
      native: 1,
      published: 3,
      fingerprint: fingerprintHermesSwitchyardRouting(files),
    });
  });
  it("publishes under a restrictive umask without repairing an existing untrusted lock (#13864)", () => {
    expect(run("restrictive-umask")).toMatchObject({ accepted: true, published: 3 });
    expect(run("untrusted-lock")).toMatchObject({ accepted: false, published: 0 });
  });
  it.each([false, true])(
    "excludes publication while the actual startup function holds its lock, routed=%s (#13864)",
    (routed) => {
      const directory = fs.mkdtempSync(path.resolve(".switchyard-preflight-test-"));
      try {
        const lock = path.join(directory, "routing.lock");
        fs.writeFileSync(lock, "", { mode: 0o444 });
        const startup = extractShellFunction(
          fs.readFileSync("agents/hermes/start.sh", "utf8"),
          "qualify_hermes_switchyard_judge",
        )
          .replaceAll("/usr/local/share/nemoclaw/hermes-switchyard.lock", lock)
          .replaceAll("/usr/local/share/nemoclaw/", `${directory}/`);
        const probe = String.raw`
import importlib.util, json, os, pathlib, sys
spec=importlib.util.spec_from_file_location('preflight',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.ROOT_UID=os.getuid();m.LOCK_PATH=pathlib.Path(sys.argv[2]);m.DIRECTORY=m.LOCK_PATH.parent
m.PATHS={key:m.DIRECTORY/path.name for key,path in m.PATHS.items()}
m.gateway_pids=lambda:set()
try:
    m.publish(json.loads(sys.argv[3]))
except BlockingIOError:
    assert not any(path.exists() for path in m.PATHS.values())
    print('excluded')
else: raise AssertionError('publisher acquired startup lock')
`;
        const result = spawnSync(
          "bash",
          [
            "-c",
            [
              "set -euo pipefail",
              `flock() { ${bashPrintfQ(python)} -I -c 'import fcntl,sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_SH | fcntl.LOCK_NB)' "$3"; }`,
              "id() { printf 1000; }; judge_python() { :; }",
              `HERMES_DIR=${bashPrintfQ(directory)}; _HERMES_PYTHON=judge_python`,
              `NEMOCLAW_HERMES_SWITCHYARD_SHA256=${routed ? "requested" : ""}`,
              startup,
              "qualify_hermes_switchyard_judge",
              `${bashPrintfQ(python)} -I -c ${bashPrintfQ(probe)} ${bashPrintfQ(helper)} ${bashPrintfQ(lock)} ${bashPrintfQ(JSON.stringify(files))}`,
            ].join("\n"),
          ],
          { encoding: "utf8", timeout: 10000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("excluded\n");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("accepts an exact replay without replacing files (#13864)", () => {
    expect(run("replay")).toMatchObject({ accepted: true, native: 0, published: 3 });
  });
  it("leaves activation absent after interrupted publication (#13864)", () => {
    expect(run("interrupted")).toMatchObject({ accepted: false, published: 1, activation: false });
  });
  it("removes disabled routing only while stopped (#13864)", () => {
    expect(run("disabled")).toMatchObject({ accepted: true, published: 0 });
  });
  it.each(["partial", "mixed", "symlink", "hardlink", "writable", "parent-writable"])(
    "rejects %s state without repair (#13864)",
    (caseName) => {
      expect(run(caseName)).toMatchObject({ accepted: false, native: 0 });
    },
  );
  it.each(["invalid-native", "live-gateway", "concurrent-startup"])(
    "does not publish files after %s (#13864)",
    (caseName) => {
      expect(run(caseName)).toMatchObject({ accepted: false, published: 0 });
    },
  );
});

describe("request-free native validation", () => {
  it.each(["scoped", "transport", "raw", "wrong-key", "stale-file", "duplicate-file"])(
    "checks selected credential references for %s (#13864)",
    (caseName) => {
      const result = spawnSync(
        python,
        [
          "-I",
          "-c",
          String.raw`
import contextlib, importlib.util, json, sys, types
spec=importlib.util.spec_from_file_location("preflight",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
# No YAML operation is involved in these existing pure reference parsers.
sys.modules['yaml']=types.ModuleType('yaml')
guard=m.load_helper('guard',m.Path(sys.argv[1]).with_name('runtime-config-guard.py'))
boundary=m.load_helper('boundary',m.Path(sys.argv[1]).with_name('validate-env-secret-boundary.py'))
files=json.loads(sys.argv[2]); case=sys.argv[3]; keys=m.credential_keys(files)
env={key:'openshell:resolve:env:v1_'+key for key in keys}
if case=='transport': env={key:'xapp-OPENSHELL-RESOLVE-ENV-'+key for key in keys}
if case=='raw': env[keys[0]]='private-raw-credential'
if case=='wrong-key': env[keys[0]]=env[keys[1]]
text='\n'.join(key+'='+value for key,value in env.items())
if case=='stale-file': text=text.replace('v1_','v2_')
if case=='duplicate-file': text+='\n'+keys[0]+'='+env[keys[0]]
@contextlib.contextmanager
def opened(path): yield (0,(),[0],[],'env')
boundary._open_env_path=opened
boundary._read_bounded_env=lambda *args:text.encode()
boundary._verify_env_path_chain=lambda *args:None
m.load_helper=lambda name,path:guard if name=='switchyard_runtime_guard' else boundary
try:
    references=m.verify_placeholders(files,env)
    print(json.dumps({'accepted':True,'references':references}))
except Exception: print(json.dumps({'accepted':False}))
`,
          helper,
          JSON.stringify(files),
          caseName,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("private-raw-credential");
      const observed = JSON.parse(result.stdout);
      expect(observed.accepted).toBe(["scoped", "transport"].includes(caseName));
      expect(Object.values(observed.references ?? {})).toEqual(
        ["scoped", "transport"].includes(caseName)
          ? [expect.stringMatching(/^[a-f0-9]{64}$/u), expect.stringMatching(/^[a-f0-9]{64}$/u)]
          : [],
      );
    },
  );
  it.each(["valid", "disabled", "shutdown", "lingering"])(
    "cleans up activation for %s without executing a request (#13864)",
    (caseName) => {
      const result = spawnSync(
        python,
        [
          "-I",
          "-c",
          String.raw`
import importlib.util, json, os, sys, types
spec=importlib.util.spec_from_file_location("preflight", sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
case=sys.argv[2]; state={"shutdown":0,"requests":0}; active=False
class Runtime:
    def __init__(self):
        global active
        active=True
    def managed_execution_enabled(self): return case != "disabled"
    def shutdown(self):
        global active
        state["shutdown"]+=1; active=False
        if case == "shutdown": raise ValueError("private-native-output")
def execute(*args):
    state["requests"]+=1
    raise AssertionError("must not execute")
relay=types.SimpleNamespace(plugin=types.SimpleNamespace(list_kinds=lambda: [], report=lambda: "leftover" if case == "lingering" else None), llm=types.SimpleNamespace(execute=execute))
os.environ[m.PLUGINS_ENV]="original"
try: m.validate_native("candidate",runtime_factory=Runtime,relay=relay); state["accepted"]=True
except Exception: state["accepted"]=False
state["restored"]=os.environ[m.PLUGINS_ENV]=="original"
print(json.dumps(state))
`,
          helper,
          caseName,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("private-native-output");
      expect(JSON.parse(result.stdout)).toEqual({
        shutdown: 1,
        requests: 0,
        accepted: caseName === "valid",
        restored: true,
      });
    },
  );
});
