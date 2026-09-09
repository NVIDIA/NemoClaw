// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { extractShellFunction, runHermesBashHarness } from "../../support/hermes-shell-harness";

const TRANSACTION = path.resolve(
  import.meta.dirname,
  "../../..",
  "agents/hermes/mcp-config-transaction.py",
);
const GUARD = path.resolve(
  import.meta.dirname,
  "../../..",
  "agents/hermes/runtime-config-guard.py",
);

function runPython(source: string, args: string[] = []) {
  return spawnSync("python3", ["-c", source, TRANSACTION, GUARD, ...args], {
    encoding: "utf8",
  });
}

const PACING_SETUP = `
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
clock = {"now": 0}
gateway = {"identity": (4242, 10000)}
signals = []
module.time.monotonic = lambda: clock["now"]
module.time.CLOCK_BOOTTIME = 7
module.time.clock_gettime = lambda _clock: 100 + clock["now"]
module.os.sysconf = lambda _name: 100
module.time.sleep = lambda seconds: clock.__setitem__("now", clock["now"] + seconds)
module._gateway_identity = lambda: gateway["identity"]
module._gateway_has_managed_parent = lambda _pid: True
module._gateway_health_phase = lambda deadline=None: (True, "waiting-for-stable-replacement-identity")
def signal_gateway(pid, sent_signal):
    signals.append({"pid": pid, "signal": signal.Signals(sent_signal).name, "at": clock["now"]})
    gateway["identity"] = (pid + 1, int((100 + clock["now"]) * 100))
module.os.kill = signal_gateway
`;

function countGatewayExits(times: number[]) {
  const source = fs.readFileSync(path.join(path.dirname(TRANSACTION), "start.sh"), "utf8");
  return runHermesBashHarness([
    extractShellFunction(source, "record_hermes_managed_gateway_exit"),
    "HERMES_MANAGED_GATEWAY_EXIT_TIMES=()",
    "HERMES_MANAGED_GATEWAY_EXIT_COUNT=0",
    'date() { printf "%s\\n" "$event_second"; }',
    'quarantine_hermes_managed_gateway_relaunch() { printf "quarantined\\n"; exit 0; }',
    `for event_second in ${times.join(" ")}; do record_hermes_managed_gateway_exit; printf "counted:%s\\n" "$HERMES_MANAGED_GATEWAY_EXIT_COUNT"; done`,
  ]);
}

describe("Hermes managed MCP reload convergence", () => {
  it("paces repeated intentional reloads while leaving genuine crash bursts quarantined", () => {
    const result = runPython(
      PACING_SETUP +
        `
reloads = [module.reload_gateway() for _ in range(6)]
print(json.dumps({"reloads": reloads, "signals": signals, "elapsed": clock["now"]}))
`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.reloads).toEqual([true, true, true, true, true, true]);
    expect(proof.signals).toEqual(
      [16, 32, 48, 64, 80, 96].map((at, index) => ({ pid: 4242 + index, signal: "SIGUSR1", at })),
    );
    expect(proof.elapsed).toBe(96);

    const paced = countGatewayExits(proof.signals.map((entry: { at: number }) => entry.at));
    const crashes = countGatewayExits([0, 1, 2, 3, 4]);
    expect(paced.status, paced.stderr).toBe(0);
    expect(paced.stdout.trim().split("\n")).toEqual([
      "counted:1",
      "counted:2",
      "counted:3",
      "counted:4",
      "counted:4",
      "counted:4",
    ]);
    expect(crashes.status, crashes.stderr).toBe(0);
    expect(crashes.stdout).toContain("quarantined");
    expect(crashes.stderr).toContain("5 exits in 60s window");
  });

  it("refuses identity drift while pacing without signaling or following a replacement", () => {
    const result = runPython(
      PACING_SETUP +
        `
outcomes = {}
for name, replacement in {"pid": (4243, 10000), "start": (4242, 10001), "missing": None, "parent": (4242, 10000)}.items():
    clock["now"] = 0
    signals.clear()
    module._gateway_identity = lambda: (4242, 10000) if clock["now"] < 5 else replacement
    module._gateway_has_managed_parent = lambda _pid: name != "parent" or clock["now"] < 5
    try:
        module.reload_gateway()
    except RuntimeError as error:
        outcomes[name] = {"error": str(error), "signals": list(signals), "elapsed": clock["now"]}
    else:
        outcomes[name] = {"unexpected_success": True}
print(json.dumps(outcomes))
`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const refusal = {
      error: "Hermes gateway identity changed while pacing managed MCP reload",
      signals: [],
      elapsed: 5,
    };
    expect(JSON.parse(result.stdout)).toEqual({
      pid: refusal,
      start: refusal,
      missing: refusal,
      parent: refusal,
    });
  });

  it("includes pacing in the original deadline before signaling and during replacement health", () => {
    const result = runPython(
      PACING_SETUP +
        `
outcomes = {}
for deadline in (4, 20):
    clock["now"] = 0
    gateway["identity"] = (4242, 10000)
    signals.clear()
    module.RELOAD_TIMEOUT_SECONDS = deadline
    def exhausted_health(deadline=None):
        clock["now"] = deadline
        return False, "waiting-for-internal-health"
    module._gateway_health_phase = exhausted_health
    try:
        module.reload_gateway()
    except TimeoutError:
        outcomes[str(deadline)] = {"elapsed": clock["now"], "signals": list(signals)}
    else:
        outcomes[str(deadline)] = {"unexpected_success": True}
print(json.dumps(outcomes))
`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      "4": { elapsed: 4, signals: [] },
      "20": { elapsed: 20, signals: [{ pid: 4242, signal: "SIGUSR1", at: 16 }] },
    });
  });

  it("paces the rollback reload while preserving the original transaction failure", () => {
    const result = runPython(
      PACING_SETUP +
        `
import types
module.RELOAD_TIMEOUT_SECONDS = 20
module.os.environ["SAFE_MCP_TOKEN"] = "openshell:resolve:env:v1_SAFE_MCP_TOKEN"
original = "model: test\\n"
state = {"text": original}
snapshot = types.SimpleNamespace(mode=0o600)
guard = types.SimpleNamespace(
    _read_text=lambda _path: (state["text"], snapshot),
    _write_existing=lambda _path, text, _snapshot, mode: state.__setitem__("text", text),
)
module._load_guard = lambda: guard
module._refresh_and_verify_hashes = lambda *_args: None
def apply(action, payload):
    updated, changed = module._mutate(module.yaml.safe_load(state["text"]), action, payload)
    state["text"] = module.yaml.safe_dump(updated, sort_keys=False)
    return changed
module.apply_transaction = apply
def health(deadline=None):
    if len(signals) == 1:
        clock["now"] = deadline
        return False, "waiting-for-internal-health"
    return True, "waiting-for-stable-replacement-identity"
module._gateway_health_phase = health
try:
    module.apply_transaction_and_reload("add", {
        "server": "fake", "url": "https://example.com/mcp",
        "headers": {"Authorization": "Bearer openshell:resolve:env:v1_SAFE_MCP_TOKEN"},
        "replace_existing": False,
    })
except RuntimeError as error:
    print(json.dumps({"error": str(error), "restored": state["text"] == original, "signals": signals, "elapsed": clock["now"]}))
else:
    raise AssertionError("the failed original reload must remain a failure")
`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.error).toContain("Hermes MCP runtime reload failed");
    expect(proof.error).toContain("config and hashes were restored");
    expect(proof.restored).toBe(true);
    expect(proof.signals).toEqual([
      { pid: 4242, signal: "SIGUSR1", at: 16 },
      { pid: 4243, signal: "SIGUSR1", at: 32 },
    ]);
    expect(proof.elapsed).toBe(32);
  });

  it("preserves the first signal settlement grace when initial pacing consumes time", () => {
    const result = runPython(
      PACING_SETUP +
        `
module.RELOAD_TIMEOUT_SECONDS = 40
module._gateway_health_phase = lambda deadline=None: (True, "waiting-for-stable-replacement-identity") if len(signals) >= 2 else (False, "waiting-for-internal-health")
print(json.dumps({"reloaded": module.reload_gateway(), "signals": signals, "elapsed": clock["now"]}))
`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      reloaded: true,
      signals: [
        { pid: 4242, signal: "SIGUSR1", at: 16 },
        { pid: 4243, signal: "SIGUSR1", at: 36 },
      ],
      elapsed: 37,
    });
  });

  it.each([22, null])(
    "paces an immature re-kick target while continuing health observation (%s)",
    (readyAt) => {
      const result = runPython(
        PACING_SETUP +
          `
module.RELOAD_TIMEOUT_SECONDS = 40
gateway["identity"] = (4242, 7000)
def identity():
    if len(signals) == 1 and clock["now"] >= 19:
        return (5000, 11900)
    return gateway["identity"]
module._gateway_identity = identity
def health(deadline=None):
    ready = len(signals) >= 2 or (${readyAt ?? -1} >= 0 and clock["now"] >= ${readyAt ?? -1})
    return (True, "waiting-for-stable-replacement-identity") if ready else (False, "waiting-for-internal-health")
module._gateway_health_phase = health
print(json.dumps({"reloaded": module.reload_gateway(), "signals": signals, "elapsed": clock["now"]}))
`,
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        readyAt === null
          ? {
              reloaded: true,
              signals: [
                { pid: 4242, signal: "SIGUSR1", at: 0 },
                { pid: 5000, signal: "SIGUSR1", at: 35 },
              ],
              elapsed: 36,
            }
          : {
              reloaded: true,
              signals: [{ pid: 4242, signal: "SIGUSR1", at: 0 }],
              elapsed: readyAt,
            },
      );
    },
  );

  it("refuses invalid kernel age evidence before signaling", () => {
    const result = runPython(
      PACING_SETUP +
        `
outcomes = {}
for name, start, ticks, boot in (
    ("boolean-start", True, 100, 100), ("float-start", 10000.0, 100, 100),
    ("future-start", 10001, 100, 100), ("zero-ticks", 10000, 0, 100),
    ("nonfinite-clock", 10000, 100, float("nan")),
):
    gateway["identity"] = (4242, start)
    module.os.sysconf = lambda _name: ticks
    module.time.clock_gettime = lambda _clock: boot
    try:
        module.reload_gateway()
    except RuntimeError as error:
        outcomes[name] = str(error)
    else:
        outcomes[name] = "unexpected success"
print(json.dumps({"outcomes": outcomes, "signals": signals, "elapsed": clock["now"]}))
`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const unavailable = "Hermes gateway uptime could not be verified";
    expect(JSON.parse(result.stdout)).toEqual({
      outcomes: {
        "boolean-start": unavailable,
        "float-start": unavailable,
        "future-start": unavailable,
        "zero-ticks": unavailable,
        "nonfinite-clock": unavailable,
      },
      signals: [],
      elapsed: 0,
    });
  });

  it("re-kicks one revalidated gateway identity within the original reload deadline", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_uptime_seconds = lambda _identity: 16

module.RELOAD_TIMEOUT_SECONDS = 4
clock = {"now": 0}
gateway = {"identity": (4242, 99)}
signals = []
sleeps = []
module._gateway_identity = lambda: gateway["identity"]
module._gateway_has_managed_parent = lambda pid: True
module._gateway_health_phase = lambda deadline=None: (
    (True, "waiting-for-stable-replacement-identity")
    if len(signals) >= 2
    else (False, "waiting-for-internal-health")
)
module.time.monotonic = lambda: clock["now"]
def sleep(seconds):
    sleeps.append(seconds)
    clock["now"] += seconds
module.time.sleep = sleep
def signal_gateway(pid, sent_signal):
    signals.append((pid, signal.Signals(sent_signal).name))
    if len(signals) == 1:
        gateway["identity"] = (4243, 100)
    elif len(signals) == 2:
        gateway["identity"] = (4244, 101)
module.os.kill = signal_gateway

print(json.dumps({
    "reloaded": module.reload_gateway(),
    "signals": signals,
    "sleeps": sleeps,
    "elapsed": clock["now"],
}))
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      elapsed: 3,
      reloaded: true,
      signals: [
        [4242, "SIGUSR1"],
        [4243, "SIGUSR1"],
      ],
      sleeps: [1, 1, 1],
    });
  });

  it("does not re-kick without a currently trusted gateway identity", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_uptime_seconds = lambda _identity: 16

module.RELOAD_TIMEOUT_SECONDS = 4
clock = {"now": 0}
identity_calls = {"count": 0}
signals = []
def identity():
    identity_calls["count"] += 1
    return (4242, 99) if not signals else None
module._gateway_has_managed_parent = lambda _pid: True
module._gateway_identity = identity
module.time.monotonic = lambda: clock["now"]
module.time.sleep = lambda seconds: clock.__setitem__("now", clock["now"] + seconds)
module.os.kill = lambda pid, sent_signal: signals.append(
    (pid, signal.Signals(sent_signal).name)
)
try:
    module.reload_gateway()
except TimeoutError as error:
    print(json.dumps({"error": str(error), "signals": signals}))
else:
    raise SystemExit(9)
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error:
        "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-replacement-identity; re-kick attempted: no; re-kick sent: no)",
      signals: [[4242, "SIGUSR1"]],
    });
  });

  it("does not probe or accept an unmanaged replacement gateway", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_uptime_seconds = lambda _identity: 16

module.RELOAD_TIMEOUT_SECONDS = 3
clock = {"now": 0}
gateway = {"identity": (4242, 99)}
signals = []
health_calls = []
module._gateway_identity = lambda: gateway["identity"]
module._gateway_has_managed_parent = lambda pid: pid == 4242
module._gateway_health_phase = lambda deadline=None: (
    health_calls.append(deadline) or (True, "waiting-for-stable-replacement-identity")
)
module.time.monotonic = lambda: clock["now"]
module.time.sleep = lambda seconds: clock.__setitem__("now", clock["now"] + seconds)
def signal_gateway(pid, sent_signal):
    signals.append((pid, signal.Signals(sent_signal).name))
    gateway["identity"] = (4243, 100)
module.os.kill = signal_gateway
try:
    module.reload_gateway()
except TimeoutError as error:
    print(json.dumps({"error": str(error), "health_calls": health_calls, "signals": signals}))
else:
    raise SystemExit(9)
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error:
        "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-replacement-identity; re-kick attempted: no; re-kick sent: no)",
      health_calls: [],
      signals: [[4242, "SIGUSR1"]],
    });
  });

  it("revalidates the managed parent after replacement health", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_uptime_seconds = lambda _identity: 16

module.RELOAD_TIMEOUT_SECONDS = 3
clock = {"now": 0}
gateway = {"identity": (4242, 99)}
signals = []
parent_checks = []
health_calls = []
module._gateway_identity = lambda: gateway["identity"]
def managed_parent(pid):
    if pid == 4242:
        return True
    parent_checks.append(pid)
    return len(parent_checks) == 1
module._gateway_has_managed_parent = managed_parent
module._gateway_health_phase = lambda deadline=None: (
    health_calls.append(deadline) or (True, "waiting-for-stable-replacement-identity")
)
module.time.monotonic = lambda: clock["now"]
module.time.sleep = lambda seconds: clock.__setitem__("now", clock["now"] + seconds)
def signal_gateway(pid, sent_signal):
    signals.append((pid, signal.Signals(sent_signal).name))
    gateway["identity"] = (4243, 100)
module.os.kill = signal_gateway
try:
    module.reload_gateway()
except TimeoutError as error:
    print(json.dumps({
        "error": str(error),
        "health_calls": len(health_calls),
        "signals": signals,
    }))
else:
    raise SystemExit(9)
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error:
        "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-stable-replacement-identity; re-kick attempted: no; re-kick sent: no)",
      health_calls: 1,
      signals: [[4242, "SIGUSR1"]],
    });
  });

  it("attempts a vanished re-kick target only once", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_uptime_seconds = lambda _identity: 16

module.RELOAD_TIMEOUT_SECONDS = 5
clock = {"now": 0}
attempts = []
module._gateway_identity = lambda: (4242, 99)
module._gateway_has_managed_parent = lambda pid: True
module.time.monotonic = lambda: clock["now"]
module.time.sleep = lambda seconds: clock.__setitem__("now", clock["now"] + seconds)
def signal_gateway(pid, sent_signal):
    attempts.append((pid, signal.Signals(sent_signal).name))
    if len(attempts) == 2:
        raise ProcessLookupError(pid)
module.os.kill = signal_gateway
try:
    module.reload_gateway()
except TimeoutError as error:
    print(json.dumps({"attempts": attempts, "error": str(error)}))
else:
    raise SystemExit(9)
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      attempts: [
        [4242, "SIGUSR1"],
        [4242, "SIGUSR1"],
      ],
      error:
        "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-replacement-identity; re-kick attempted: yes; re-kick sent: no)",
    });
  });

  it("reports whether reload stopped at internal health, public relay, or stable identity", () => {
    const result = runPython(`
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_uptime_seconds = lambda _identity: 16

statuses = {
    module.GATEWAY_INTERNAL_PORT: 503,
    module.GATEWAY_PUBLIC_PORT: 401,
}
class Connection:
    def __init__(self, host, port, timeout):
        self.port = port
    def request(self, method, path):
        pass
    def getresponse(self):
        return types.SimpleNamespace(status=statuses[self.port], read=lambda: b"")
    def close(self):
        pass
module.http.client.HTTPConnection = Connection

internal = module._gateway_health_phase()
statuses[module.GATEWAY_INTERNAL_PORT] = 200
statuses[module.GATEWAY_PUBLIC_PORT] = 503
public = module._gateway_health_phase()
statuses[module.GATEWAY_PUBLIC_PORT] = 401
stable = module._gateway_health_phase()
print(json.dumps({"internal": internal, "public": public, "stable": stable}))
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      internal: [false, "waiting-for-internal-health"],
      public: [false, "waiting-for-public-relay-health"],
      stable: [true, "waiting-for-stable-replacement-identity"],
    });
  });

  it("does not re-kick after a health probe exhausts the shared deadline", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_uptime_seconds = lambda _identity: 16

module.RELOAD_TIMEOUT_SECONDS = 4
clock = {"now": 0}
identity_calls = {"count": 0}
signals = []
def identity():
    identity_calls["count"] += 1
    return (4242, 99) if not signals else (4243, 100)
def health_phase(deadline=None):
    clock["now"] = deadline
    return False, "waiting-for-internal-health"
module._gateway_identity = identity
module._gateway_health_phase = health_phase
module._gateway_has_managed_parent = lambda pid: True
module.time.monotonic = lambda: clock["now"]
module.time.sleep = lambda seconds: (_ for _ in ()).throw(
    AssertionError("deadline exhaustion must not sleep")
)
module.os.kill = lambda pid, sent_signal: signals.append(
    (pid, signal.Signals(sent_signal).name)
)
try:
    module.reload_gateway()
except TimeoutError as error:
    print(json.dumps({"error": str(error), "signals": signals}))
else:
    raise SystemExit(9)
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error:
        "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-internal-health; re-kick attempted: no; re-kick sent: no)",
      signals: [[4242, "SIGUSR1"]],
    });
  });

  it("reports the furthest safe phase reached when reload exhausts its deadline", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._gateway_uptime_seconds = lambda _identity: 16

def run_case(name):
    module.RELOAD_TIMEOUT_SECONDS = 4
    clock = {"now": 0}
    churn = {"count": 0}
    signals = []

    def identity():
        if not signals:
            return (4242, 99)
        if name == "replacement":
            return None
        if name == "internal" and clock["now"] >= 3:
            return None
        if name == "stable":
            churn["count"] += 1
            return (4243, 100) if churn["count"] % 2 else (4244, 101)
        return (4243, 100)

    phases = {
        "internal": (False, "waiting-for-internal-health"),
        "public": (False, "waiting-for-public-relay-health"),
        "stable": (True, "waiting-for-stable-replacement-identity"),
    }
    module._gateway_identity = identity
    module._gateway_has_managed_parent = lambda pid: True
    module._gateway_health_phase = lambda deadline=None: phases[name]
    module.time.monotonic = lambda: clock["now"]
    module.time.sleep = lambda seconds: clock.__setitem__("now", clock["now"] + seconds)
    module.os.kill = lambda pid, sent_signal: signals.append(
        (pid, signal.Signals(sent_signal).name)
    )
    try:
        module.reload_gateway()
    except (TimeoutError, RuntimeError) as error:
        return {"error": str(error), "signals": signals}
    raise AssertionError("reload unexpectedly succeeded")

print(json.dumps({name: run_case(name) for name in (
    "replacement", "internal", "public", "stable"
)}))
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      replacement: {
        error:
          "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-replacement-identity; re-kick attempted: no; re-kick sent: no)",
        signals: [[4242, "SIGUSR1"]],
      },
      internal: {
        error:
          "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-internal-health; re-kick attempted: yes; re-kick sent: yes)",
        signals: [
          [4242, "SIGUSR1"],
          [4243, "SIGUSR1"],
        ],
      },
      public: {
        error:
          "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-public-relay-health; re-kick attempted: no; re-kick sent: no)",
        signals: [[4242, "SIGUSR1"]],
      },
      stable: {
        error: "Hermes gateway identity changed while pacing managed MCP reload",
        signals: [[4242, "SIGUSR1"]],
      },
    });
  });
});
