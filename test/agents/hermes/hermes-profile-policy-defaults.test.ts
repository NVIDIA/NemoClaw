// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { HermesBuildSettings } from "../../../agents/hermes/config/build-env.ts";
import { buildHermesManagedPolicy } from "../../../agents/hermes/config/managed-policy.ts";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-profile-policy-defaults.py");
const imageBuildProbes = path.join(root, "agents", "hermes", "image-build-probes.py");
const POLICY_SETTINGS: HermesBuildSettings = {
  model: "test-model",
  baseUrl: "https://inference.local/v1",
  providerKey: "custom",
  upstreamProvider: "custom",
  inferenceApi: "openai-completions",
  contextWindow: null,
  toolDisclosure: "progressive",
  webSearchProvider: null,
  messagingCredentialPlaceholders: [],
  managedToolGateways: { brokerEnabled: false, presets: [] },
  managedImageCapabilityUnion: false,
};
const MANAGED_POLICY = buildHermesManagedPolicy(POLICY_SETTINGS, {});

const configFixture = `\
DEFAULT_CONFIG = {
    "browser": {
        "allow_unsafe_evaluate": False,
        "restrict_evaluate": False,
    },
    "display": {
        "show_reasoning": True,
        "show_commentary": True,
    },
    "approvals": {
        "mode": "smart",
    },
    "updates": {
        "pre_update_backup": "quick",
        "refresh_cua_driver": True,
    },
}
`;

const browserFixture = `\
import os

_BROWSER_PASSTHROUGH_KEYS = ("npm_config_offline",)

def _build_browser_env() -> dict:
    env = {}
    for _key in _BROWSER_PASSTHROUGH_KEYS:
        if _key in os.environ:
            env[_key] = os.environ[_key]
    return env

def _restrict_browser_evaluate() -> bool:
    try:
        cfg = {}
        return is_truthy_value(cfg_get(cfg, "browser", "restrict_evaluate"), default=False)
    except Exception as e:
        logger.debug("Could not read browser.restrict_evaluate from config: %s", e)
        return False
`;

const gatewayFixture = `\
from dataclasses import dataclass

@dataclass
class SessionResetPolicy:
    mode: str = "none"  # "daily", "idle", "both", or "none"

    @classmethod
    def from_dict(cls, data):
        mode = data.get("mode")
        return cls(
            mode=mode if mode is not None else "none",
        )
`;

const cliFixture = `\
CLI_CONFIG = {
    "display": {
        "show_reasoning": True,
    },
}
`;

const tuiFixture = `\
def _load_show_reasoning():
    # Fallback True — keep in sync with DEFAULT_CONFIG display.show_reasoning
    # (this loader reads the raw user YAML without the DEFAULT_CONFIG merge).
    return bool((_load_cfg().get("display") or {}).get("show_reasoning", True))
`;

const tuiConfigFixture = `\
def _get_reasoning_status(cfg):
    return (
        "show"
        if bool((cfg.get("display") or {}).get("show_reasoning", True))
        else "hide"
    )
`;

const agentFixture = `\
# Codex commentary visibility (display.show_commentary, default true).
agent.show_commentary = True
try:
    _display_section = _agent_cfg.get("display", {})
    if isinstance(_display_section, dict):
        agent.show_commentary = bool(_display_section.get("show_commentary", True))
except Exception:
    agent.show_commentary = True
`;

const mainFixture = `\
def _resolve_pre_update_backup_mode():
    updates_cfg = {}
    raw = updates_cfg.get("pre_update_backup", "quick")
    return raw

def _refresh():
    if True:
        if True:
            refresh_cua_driver = True
            _update_cfg = {}
            refresh_cua_driver = bool(
                _update_cfg.get("refresh_cua_driver", True)
            )
            return refresh_cua_driver
`;

function patchSource(
  kind: "config" | "browser" | "gateway" | "cli" | "tui" | "tui_config" | "agent" | "main",
  source: string,
) {
  const harness = `\
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("profile_policy_patcher", pathlib.Path(sys.argv[1]))
assert spec and spec.loader
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source = sys.stdin.read()
values = module.profile_default_values(module.load_managed_policy(pathlib.Path(sys.argv[3])))
try:
    patched = getattr(module, "patch_" + sys.argv[2] + "_source")(source, values)
except ValueError as exc:
    print(exc, file=sys.stderr)
    raise SystemExit(1)
sys.stdout.write(patched)
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-profile-policy-"));
  const policyPath = path.join(tmp, "managed-policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(MANAGED_POLICY)}\n`);
  try {
    return spawnSync("python3", ["-I", "-c", harness, patcher, kind, policyPath], {
      encoding: "utf8",
      input: source,
      timeout: 5000,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runPatchedPython(source: string, body: string, env = process.env) {
  const script = `\
import sys
namespace = {}
exec(compile(sys.stdin.read(), "<patched-browser>", "exec"), namespace)
${body}
`;
  return spawnSync("python3", ["-I", "-c", script], {
    encoding: "utf8",
    env,
    input: source,
    timeout: 5000,
  });
}

describe("Hermes profile policy defaults", () => {
  it("pins every config default that fresh profile homes otherwise inherit", () => {
    const result = patchSource("config", configFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(
      result.stdout,
      'import json; print(json.dumps(namespace["DEFAULT_CONFIG"], sort_keys=True))',
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      approvals: { mode: "manual" },
      browser: { allow_unsafe_evaluate: false, restrict_evaluate: true },
      display: { show_commentary: false, show_reasoning: false },
      updates: { pre_update_backup: false, refresh_cua_driver: false },
    });
  });

  it("keeps the browser loader restricted and its runtime npx fallback offline", () => {
    const result = patchSource("browser", browserFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(
      result.stdout,
      `
import json
namespace["logger"] = type("Logger", (), {"debug": lambda *args: None})()
restricted_on_error = namespace["_restrict_browser_evaluate"]()
namespace["cfg_get"] = lambda *_args: None
namespace["is_truthy_value"] = lambda value, default: default if value is None else bool(value)
restricted_when_missing = namespace["_restrict_browser_evaluate"]()
print(json.dumps({
    "offline": namespace["_build_browser_env"]()["npm_config_offline"],
    "restricted_on_error": restricted_on_error,
    "restricted_when_missing": restricted_when_missing,
}))`,
      { ...process.env, npm_config_offline: "false" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      offline: "true",
      restricted_on_error: true,
      restricted_when_missing: true,
    });
  });

  it("keeps the gateway reset policy fail-safe without config.yaml", () => {
    const result = patchSource("gateway", gatewayFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(
      result.stdout,
      'print(namespace["SessionResetPolicy"].from_dict({}).mode)',
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("both");
  });

  it("keeps the independent classic CLI display default private", () => {
    const result = patchSource("cli", cliFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(
      result.stdout,
      'print(namespace["CLI_CONFIG"]["display"]["show_reasoning"])',
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("False");
  });

  it("keeps the raw TUI server reasoning fallback private", () => {
    const result = patchSource("tui", tuiFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(
      result.stdout,
      'namespace["_load_cfg"] = lambda: {}; print(namespace["_load_show_reasoning"]())',
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("False");
  });

  it("keeps the raw TUI config reasoning fallback private", () => {
    const result = patchSource("tui_config", tuiConfigFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(result.stdout, 'print(namespace["_get_reasoning_status"]({}))');
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("hide");
  });

  it("keeps all agent commentary fallbacks private", () => {
    const result = patchSource("agent", agentFixture);

    expect(result.status, result.stderr).toBe(0);
    const probeScript = `
import types
import sys

source = sys.stdin.read()
def evaluate(config):
    scope = {"agent": types.SimpleNamespace(), "_agent_cfg": config}
    exec(compile(source, "<agent>", "exec"), scope)
    return scope["agent"].show_commentary
class BrokenConfig:
    def get(self, *_args):
        raise RuntimeError("broken")
print(evaluate({}), evaluate(BrokenConfig()))
`;
    const probe = spawnSync("python3", ["-I", "-c", probeScript], {
      encoding: "utf8",
      input: result.stdout,
      timeout: 5000,
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("False False");
  });

  it("keeps update backup and CUA refresh fallbacks off", () => {
    const result = patchSource("main", mainFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(
      result.stdout,
      'print(namespace["_resolve_pre_update_backup_mode"](), namespace["_refresh"]())',
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("False False");
  });

  it("reports an invalid managed policy as a bounded build error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-profile-policy-error-"));
    const policyPath = path.join(tmp, "managed-policy.json");
    fs.writeFileSync(policyPath, "not-json\n");
    const result = spawnSync("python3", [patcher, "--policy", policyPath], {
      encoding: "utf8",
      timeout: 5000,
    });
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`ERROR: ${policyPath}: managed policy is malformed`);
    expect(result.stderr).not.toContain("Traceback");
  });

  it("checks session reset defaults at their gateway boundary for a config-less profile", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-profile-probe-"));
    const policyPath = path.join(tmp, "managed-policy.json");
    fs.writeFileSync(policyPath, `${JSON.stringify(MANAGED_POLICY)}\n`);
    const harness = `\
import copy
import importlib.util
import json
import pathlib
import sys
from types import SimpleNamespace

probe_path = pathlib.Path(sys.argv[1])
policy_path = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(probe_path.parent))
from managed_policy import profile_default_values
spec = importlib.util.spec_from_file_location("image_build_probes", probe_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
policy = json.loads(policy_path.read_text(encoding="utf-8"))
expected = profile_default_values(policy)
config = copy.deepcopy(policy["config"])
reset_policy = SimpleNamespace(**config.pop("session_reset"))
module._verify_profile_config_policy(config, expected)
module._verify_session_reset_policy(reset_policy, expected)
`;
    const result = spawnSync("python3", ["-I", "-c", harness, imageBuildProbes, policyPath], {
      encoding: "utf8",
      timeout: 5000,
    });
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(result.status, result.stderr).toBe(0);
  });
});
