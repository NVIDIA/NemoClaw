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
const GUARD = path.resolve(
  import.meta.dirname,
  "../../..",
  "agents/hermes/runtime-config-guard.py",
);

function runPython(source: string, args: string[] = []) {
  const revisionedEnvironment = Object.fromEntries(
    [...source.matchAll(/openshell:resolve:env:(v[0-9]{1,20})_([A-Za-z_][A-Za-z0-9_]*)/gu)].map(
      ([, revision, name]) => [name!, `openshell:resolve:env:${revision!}_${name!}`],
    ),
  );
  return spawnSync("python3", ["-c", source, TRANSACTION, GUARD, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...revisionedEnvironment },
  });
}

describe("Hermes managed MCP config reconciliation", () => {
  it("proves committed and absent state through stable managed gateway health", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 0
module.RECONCILE_STABILITY_SECONDS = 0
module._configure_gateway_public_port = lambda: None
module._gateway_identity = lambda: (4242, 99)
module._gateway_has_managed_parent = lambda pid: pid == 4242
module._gateway_health_phase = lambda: (True, "waiting-for-stable-replacement-identity")
inspections = []
module.inspect_managed_config = lambda payload, require_applied_hash=False: inspections.append({"payload": payload, "requireAppliedHash": require_applied_hash}) or {"ok": True, "state": "matched"}
expected = {
    "url": "https://mcp.example.test/mcp",
    "enabled": True,
    "timeout": 120,
    "connect_timeout": 60,
    "tools": {"resources": True, "prompts": True},
    "headers": {"Authorization": "Bearer openshell:resolve:env:v7_FAKE_TOKEN"},
}
committed = module.reconcile_managed_config({"present": {"fake": expected}, "absent": []})
absent = module.reconcile_managed_config({"present": {}, "absent": ["fake"]})
print(json.dumps({"committed": committed, "absent": absent, "inspections": inspections}, sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof).toMatchObject({
      committed: { ok: true, state: "committed" },
      absent: { ok: true, state: "absent" },
    });
    expect(proof.inspections).toHaveLength(4);
    expect(proof.inspections[0]).toMatchObject({
      requireAppliedHash: true,
      payload: { present: { fake: { url: "https://mcp.example.test/mcp" } }, absent: [] },
    });
  });

  it.each([
    ["gateway identity changes", "identity", /identity changed/u],
    ["public or internal health fails", "health", /public-relay-health/u],
    ["config or hash inspection fails", "integrity", /applied gateway state/u],
  ])("rejects reconciliation when %s", (_label, failure, message) => {
    const result = runPython(
      `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 0
module.RECONCILE_STABILITY_SECONDS = 0
module._configure_gateway_public_port = lambda: None
identity_calls = {"count": 0}
def identity():
    identity_calls["count"] += 1
    return (4243, 100) if sys.argv[3] == "identity" and identity_calls["count"] > 1 else (4242, 99)
module._gateway_identity = identity
module._gateway_has_managed_parent = lambda pid: pid in (4242, 4243)
module._gateway_health_phase = lambda: (
    (False, "waiting-for-public-relay-health")
    if sys.argv[3] == "health"
    else (True, "waiting-for-stable-replacement-identity")
)
def inspect(payload, require_applied_hash=False):
    if sys.argv[3] == "integrity":
        raise RuntimeError("Hermes MCP config does not match applied gateway state")
    return {"ok": True, "state": "matched"}
module.inspect_managed_config = inspect
try:
    module.reconcile_managed_config({"present": {}, "absent": ["fake"]})
except RuntimeError as error:
    print(json.dumps({"error": str(error)}))
else:
    raise SystemExit(9)
`,
      [failure],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).error).toMatch(message);
  });
});
