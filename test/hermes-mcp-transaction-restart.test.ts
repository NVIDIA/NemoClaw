// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRestartFixture,
  mode,
  runGuard,
  runShieldsTransition,
  strictHashIsValid,
} from "./helpers/hermes-restart-config-seal-fixture";

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

describe("Hermes managed MCP integrity through restart", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps an unprivileged MCP transaction current through shields relock and gateway restart recovery (#7499)",
    () => {
      const fixture = createRestartFixture();

      try {
        const transaction = runPython(
          `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
if os.geteuid() == 0:
    raise RuntimeError("regression fixture requires an ordinary sandbox identity")
module.GUARD_PATH = sys.argv[2]
module.HERMES_DIR = sys.argv[3]
module.CONFIG_PATH = os.path.join(module.HERMES_DIR, "config.yaml")
module.STRICT_HASH_PATH = sys.argv[4]
module._assert_non_root_lifecycle_identity = lambda: None
reloads = []
module.reload_gateway = lambda: reloads.append("reload") or True
outcome = module.execute("add", {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_MCP_TOKEN"},
    "replace_existing": False,
})
guard = module._load_guard()
compat_path = os.path.join(module.HERMES_DIR, ".config-hash")
integrity = guard.inspect_mcp_integrity_snapshot(module.HERMES_DIR, compat_path)
strict_text, _ = guard._read_text(module.STRICT_HASH_PATH)
compat_text, _ = guard._read_text(compat_path)
print(json.dumps({
    "uid": os.geteuid(),
    "outcome": outcome,
    "reloads": reloads,
    "compat_state": integrity.state,
    "anchors_differ_before_relock": strict_text != compat_text,
}, sort_keys=True))
`,
          [fixture.hermesDir, fixture.hashPath],
        );

        expect(transaction.status, `${transaction.stdout}\n${transaction.stderr}`).toBe(0);
        expect(JSON.parse(transaction.stdout)).toMatchObject({
          outcome: { ok: true, changed: true, reloaded: true },
          reloads: ["reload"],
          compat_state: "current",
          anchors_differ_before_relock: true,
        });
        expect(JSON.parse(transaction.stdout).uid).toBe(process.getuid!());

        const locked = runShieldsTransition(fixture, "locked");
        expect(locked.status, `${locked.stdout}\n${locked.stderr}`).toBe(0);
        expect(mode(fixture.sandboxDir)).toBe(0o1775);
        expect(mode(fixture.hermesDir)).toBe(0o755);
        expect(mode(fixture.configPath)).toBe(0o444);
        expect(mode(fixture.envPath)).toBe(0o444);
        expect(mode(fixture.compatHashPath)).toBe(0o444);
        expect(strictHashIsValid(fixture)).toBe(true);
        expect(fs.readFileSync(fixture.hashPath, "utf8")).toBe(
          fs.readFileSync(fixture.compatHashPath, "utf8"),
        );

        // Exercise the same seal/unseal recovery boundary used around a managed
        // gateway restart after shields have returned to their locked posture.
        const sealed = runGuard("seal-restart", fixture);
        expect(sealed.status, `${sealed.stdout}\n${sealed.stderr}`).toBe(0);
        expect(sealed.stdout).toContain("original_locked=1");
        const recovered = runGuard("unseal-restart", fixture);
        expect(recovered.status, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
        expect(fs.existsSync(fixture.statePath)).toBe(false);

        const integrity = runPython(
          `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("guard", sys.argv[2])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
hermes_dir = sys.argv[3]
strict_path = sys.argv[4]
compat_path = os.path.join(hermes_dir, ".config-hash")
snapshot = guard.inspect_mcp_integrity_snapshot(
    hermes_dir, strict_path, compat_path
)
guard.assert_mcp_integrity_snapshot_current(snapshot)
hash_text, _ = guard._read_text(strict_path)
_config_digest, _env_digest, state = guard._parse_config_hash(
    hash_text,
    os.path.join(hermes_dir, "config.yaml"),
    os.path.join(hermes_dir, ".env"),
)
config_text, _ = guard._read_text(os.path.join(hermes_dir, "config.yaml"))
current_digest = guard._canonical_mcp_servers_digest(config_text)
compat_text, _ = guard._read_text(compat_path)
print(json.dumps({
    "state": snapshot.state,
    "anchors_match": hash_text == compat_text,
    "intended": state.intended,
    "applied": state.applied,
    "current": current_digest,
}, sort_keys=True))
`,
          [fixture.hermesDir, fixture.hashPath],
        );

        expect(integrity.status, `${integrity.stdout}\n${integrity.stderr}`).toBe(0);
        const finalState = JSON.parse(integrity.stdout) as {
          state: string;
          anchors_match: boolean;
          intended: string;
          applied: string;
          current: string;
        };
        expect(finalState).toMatchObject({
          state: "current",
          anchors_match: true,
        });
        expect(finalState.intended).toBe(finalState.applied);
        expect(finalState.applied).toBe(finalState.current);
        expect(mode(fixture.sandboxDir)).toBe(0o1775);
        expect(mode(fixture.hermesDir)).toBe(0o755);
        expect(mode(fixture.configPath)).toBe(0o444);
        expect(mode(fixture.envPath)).toBe(0o444);
        expect(mode(fixture.compatHashPath)).toBe(0o444);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
