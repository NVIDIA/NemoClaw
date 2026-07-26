// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

import { hermesAgent } from "../../agent/hermes-recovery-boundary-fixtures";
import { type GatewayRestartDeps, restartSandboxGatewayWithDeps } from "./gateway-restart";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const HERMES_GUARD = path.join(REPO_ROOT, "agents/hermes/runtime-config-guard.py");
const HERMES_TRANSACTION = path.join(REPO_ROOT, "agents/hermes/mcp-config-transaction.py");

function fixtureSnapshot(paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((filePath) => [path.basename(filePath), fs.readFileSync(filePath, "utf8")]),
  );
}

it("detects real Hermes config/hash drift without mutating the inspected fixture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-gateway-drift-"));
  const hermesDir = path.join(root, ".hermes");
  const configPath = path.join(hermesDir, "config.yaml");
  const envPath = path.join(hermesDir, ".env");
  const strictHashPath = path.join(root, "hermes.config-hash");
  const compatHashPath = path.join(hermesDir, ".config-hash");
  const fixturePaths = [configPath, envPath, strictHashPath, compatHashPath] as const;
  const setup = spawnSync(
    "python3",
    [
      "-c",
      String.raw`
import importlib.util, json, os, sys, yaml

def load(name, file_path):
    spec = importlib.util.spec_from_file_location(name, file_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

transaction = load("gateway_drift_transaction", sys.argv[1])
guard = load("gateway_drift_guard", sys.argv[2])
root = sys.argv[3]
hermes = os.path.join(root, ".hermes")
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
strict = os.path.join(root, "hermes.config-hash")
compat = os.path.join(hermes, ".config-hash")
os.mkdir(hermes)
candidate = transaction._managed_candidate({
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": {"Authorization": "Bearer openshell:resolve:env:GITHUB_TOKEN"},
})
payload = {"present": {"github": candidate}, "absent": []}
open(config, "w", encoding="utf-8").write(
    yaml.safe_dump({"model": "test", "mcp_servers": {"github": candidate}}, sort_keys=False)
)
open(env, "w", encoding="utf-8").write("SAFE=1\n")
hash_text, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(strict, hash_text)
guard._write_hash(compat, hash_text)
print(json.dumps(payload, sort_keys=True))
`,
      HERMES_TRANSACTION,
      HERMES_GUARD,
      root,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );

  try {
    expect(setup.status, setup.stderr).toBe(0);
    const payload = setup.stdout.trim();
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace("https://api.githubcopilot.com/mcp/", "https://drift.example.test/mcp"),
    );
    const driftedFixture = fixtureSnapshot(fixturePaths);
    const inspection = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, os, sys

spec = importlib.util.spec_from_file_location("gateway_drift_inspection", sys.argv[1])
transaction = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = transaction
spec.loader.exec_module(transaction)
root = sys.argv[3]
transaction.HERMES_DIR = os.path.join(root, ".hermes")
transaction.CONFIG_PATH = os.path.join(transaction.HERMES_DIR, "config.yaml")
transaction.STRICT_HASH_PATH = os.path.join(root, "hermes.config-hash")
transaction.GUARD_PATH = sys.argv[2]
transaction.os.geteuid = lambda: 0
sys.argv = [transaction.__file__, "inspect", "--payload", sys.argv[4]]
raise SystemExit(transaction.main())
`,
        HERMES_TRANSACTION,
        HERMES_GUARD,
        root,
        payload,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(inspection.status).toBe(2);
    expect(inspection.stderr).toContain("Hermes config hash does not match persisted inputs");
    expect(fixtureSnapshot(fixturePaths)).toEqual(driftedFixture);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("sanitizes an injected Hermes reconciliation refusal before post-restart mutations", () => {
  try {
    const postReconciliationMutations = [
      vi.fn(() => true),
      vi.fn(() => null),
      vi.fn(() => null),
      vi.fn(() => null),
    ] as const;
    const deps: GatewayRestartDeps = {
      getSessionAgent: () => hermesAgent,
      getSandbox: () => ({ agent: "hermes" }),
      resolveSandboxDashboardPort: () => 18789,
      requestGatewaySupervisorAction: vi.fn(() => ({
        status: 0,
        stdout: "GATEWAY_PID=123",
        stderr: "",
      })),
      executeSandboxExecCommand: vi.fn(() => null),
      waitForRecoveredSandboxGateway: vi.fn(() => true),
      ensureSandboxPortForward: postReconciliationMutations[0],
      ensureHermesDashboardPortForwardIfEnabled: postReconciliationMutations[1],
      recoverMessagingHostForward: postReconciliationMutations[2],
      recoverDeclaredAgentForwardPorts: postReconciliationMutations[3],
      printGatewayWedgeDiagnostics: vi.fn(() => false),
      inspectHermesMcpReconciliationRefusal: vi.fn(() => ({
        detail: "Hermes config hash does not match persisted inputs FORGED SUCCESS <REDACTED>",
      })),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(restartSandboxGatewayWithDeps("alpha", { quiet: true, deps })).toEqual({
      ok: false,
      failureLayer: "MCP reconciliation refusal",
      detail: "Hermes config hash does not match persisted inputs FORGED SUCCESS <REDACTED>",
    });
    expect(postReconciliationMutations[0]).not.toHaveBeenCalled();
    expect(postReconciliationMutations[1]).not.toHaveBeenCalled();
    expect(postReconciliationMutations[2]).not.toHaveBeenCalled();
    expect(postReconciliationMutations[3]).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).not.toMatch(/\x1b|ghp_0123456789abcdefghij/u);
  } finally {
    vi.restoreAllMocks();
  }
});
