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
    "database": {
        "journal_mode": "wal",
        "wal_autocheckpoint": None,
        "journal_size_limit": None,
    },
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
    env.update({k: os.environ[k] for k in _BROWSER_PASSTHROUGH_KEYS if k in os.environ})
    return env
`;

const browserPolicyFixture = `\
def _origin():
    return origin

def _browser_eval_flag(key: str) -> bool:
    """Read boolean \`\`browser.<key>\`\` (default False) through the origin's config reader."""
    _bt = _origin()
    return _bt._browser_cfg(key, False, lambda v: is_truthy_value(v, default=False), f"browser.{key} from config")

def _allow_unsafe_browser_evaluate() -> bool:
    return _browser_eval_flag("allow_unsafe_evaluate")

def _restrict_browser_evaluate() -> bool:
    return _browser_eval_flag("restrict_evaluate")
`;

function patchSource(kind: "config" | "browser" | "browser_policy", source: string) {
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
      database: {
        journal_mode: "wal",
        journal_size_limit: null,
        temp_store: 2,
        wal_autocheckpoint: null,
      },
      display: { show_commentary: true, show_reasoning: true },
      updates: { pre_update_backup: "quick", refresh_cua_driver: true },
    });
  });

  it("keeps the browser runtime npx fallback offline", () => {
    const result = patchSource("browser", browserFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(
      result.stdout,
      'print(namespace["_build_browser_env"]()["npm_config_offline"])',
      { ...process.env, npm_config_offline: "false" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("true");
  });

  it("keeps browser evaluation restricted while unsafe evaluation stays opt-in", () => {
    const result = patchSource("browser_policy", browserPolicyFixture);

    expect(result.status, result.stderr).toBe(0);
    const probe = runPatchedPython(
      result.stdout,
      `
import types
namespace["is_truthy_value"] = lambda value, default: default if value is None else bool(value)
namespace["origin"] = types.SimpleNamespace(
    _browser_cfg=lambda key, default, convert, _label: convert(None)
)
print(namespace["_restrict_browser_evaluate"](), namespace["_allow_unsafe_browser_evaluate"]())`,
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("True False");
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
});
