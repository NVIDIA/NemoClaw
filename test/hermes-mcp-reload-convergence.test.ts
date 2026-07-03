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
const GUARD = path.resolve(import.meta.dirname, "..", "agents/hermes/runtime-config-guard.py");

function runPython(source: string, args: string[] = []) {
  return spawnSync("python3", ["-c", source, TRANSACTION, GUARD, ...args], {
    encoding: "utf8",
  });
}

describe("Hermes managed MCP reload convergence", () => {
  it("re-kicks one revalidated gateway identity within the original reload deadline", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

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
    else (False, "waiting-for-internal-health-on-18642")
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

module.RELOAD_TIMEOUT_SECONDS = 4
clock = {"now": 0}
identity_calls = {"count": 0}
signals = []
def identity():
    identity_calls["count"] += 1
    return (4242, 99) if identity_calls["count"] == 1 else None
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

  it("attempts a vanished re-kick target only once", () => {
    const result = runPython(`
import importlib.util, json, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

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
      internal: [false, "waiting-for-internal-health-on-18642"],
      public: [false, "waiting-for-public-relay-health-on-8642"],
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

module.RELOAD_TIMEOUT_SECONDS = 4
clock = {"now": 0}
identity_calls = {"count": 0}
signals = []
def identity():
    identity_calls["count"] += 1
    return (4242, 99) if identity_calls["count"] == 1 else (4243, 100)
def health_phase(deadline=None):
    clock["now"] = deadline
    return False, "waiting-for-internal-health-on-18642"
module._gateway_identity = identity
module._gateway_health_phase = health_phase
module._gateway_has_managed_parent = lambda pid: (_ for _ in ()).throw(
    AssertionError("deadline exhaustion must precede re-kick authority checks")
)
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
        "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-internal-health-on-18642; re-kick attempted: no; re-kick sent: no)",
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

def run_case(name):
    module.RELOAD_TIMEOUT_SECONDS = 4
    clock = {"now": 0}
    first_identity = {"pending": True}
    churn = {"count": 0}
    signals = []

    def identity():
        if first_identity["pending"]:
            first_identity["pending"] = False
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
        "internal": (False, "waiting-for-internal-health-on-18642"),
        "public": (False, "waiting-for-public-relay-health-on-8642"),
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
    except TimeoutError as error:
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
          "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-internal-health-on-18642; re-kick attempted: yes; re-kick sent: yes)",
        signals: [
          [4242, "SIGUSR1"],
          [4243, "SIGUSR1"],
        ],
      },
      public: {
        error:
          "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-public-relay-health-on-8642; re-kick attempted: yes; re-kick sent: yes)",
        signals: [
          [4242, "SIGUSR1"],
          [4243, "SIGUSR1"],
        ],
      },
      stable: {
        error:
          "Hermes gateway did not complete its managed MCP reload (last safe phase: waiting-for-stable-replacement-identity; re-kick attempted: yes; re-kick sent: yes)",
        signals: [
          [4242, "SIGUSR1"],
          [4243, "SIGUSR1"],
        ],
      },
    });
  });
});
