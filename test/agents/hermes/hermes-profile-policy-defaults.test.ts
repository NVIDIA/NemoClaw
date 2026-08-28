// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { HermesBuildSettings } from "../../../agents/hermes/config/build-env.ts";
import { buildHermesManagedPolicy } from "../../../agents/hermes/config/managed-policy.ts";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-profile-policy-defaults.py");
const imageBuildProbes = path.join(root, "agents", "hermes", "image-build-probes.py");
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
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
def _restrict_browser_evaluate() -> bool:
    try:
        cfg = {}
        return is_truthy_value(cfg_get(cfg, "browser", "restrict_evaluate"), default=False)
    except Exception as e:
        logger.debug("Could not read browser.restrict_evaluate from config: %s", e)
        return False
`;

const gatewayFixture = `\
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
    refresh_cua_driver = True
    _update_cfg = {}
    refresh_cua_driver = bool(
        _update_cfg.get("refresh_cua_driver", True)
    )
    return refresh_cua_driver
`;

function patchSource(
  kind: "config" | "browser" | "gateway" | "cli" | "tui" | "agent" | "main",
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

describe("Hermes profile policy defaults", () => {
  it("pins every config default that fresh profile homes otherwise inherit", () => {
    const result = patchSource("config", configFixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"mode": "manual"');
    expect(result.stdout).toContain('"allow_unsafe_evaluate": False');
    expect(result.stdout).toContain('"restrict_evaluate": True');
    expect(result.stdout).toContain('"show_reasoning": False');
    expect(result.stdout).toContain('"show_commentary": False');
    expect(result.stdout).toContain('"pre_update_backup": False');
    expect(result.stdout).toContain('"refresh_cua_driver": False');
    expect(result.stdout.match(/NemoClaw compatibility override/gu)).toHaveLength(6);
  });

  it("keeps the raw browser loader fail-safe when config is missing or unreadable", () => {
    const result = patchSource("browser", browserFixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('cfg_get(cfg, "browser", "restrict_evaluate"), default=True');
    expect(result.stdout).toMatch(/Could not read browser[.]restrict_evaluate[\s\S]*?return True/u);
    expect(result.stdout.match(/NemoClaw compatibility override/gu)).toHaveLength(2);
  });

  it("keeps the gateway reset policy fail-safe without config.yaml", () => {
    const result = patchSource("gateway", gatewayFixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('mode: str = "both"');
    expect(result.stdout).toContain('mode=mode if mode is not None else "both"');
    expect(result.stdout.match(/NemoClaw compatibility override/gu)).toHaveLength(2);
  });

  it("keeps the independent classic CLI display default private", () => {
    const result = patchSource("cli", cliFixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"show_reasoning": False');
    expect(result.stdout).not.toContain('"show_reasoning": True');
    expect(result.stdout).toContain("NemoClaw compatibility override");
  });

  it("keeps both raw TUI reasoning fallbacks private", () => {
    const result = patchSource("tui", tuiFixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/get[(]"show_reasoning", False[)]/gu)).toHaveLength(2);
    expect(result.stdout).not.toContain('.get("show_reasoning", True)');
    expect(result.stdout.match(/NemoClaw compatibility override/gu)).toHaveLength(2);
  });

  it("keeps all agent commentary fallbacks private", () => {
    const result = patchSource("agent", agentFixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("agent.show_commentary = True");
    expect(result.stdout).not.toContain('.get("show_commentary", True)');
    expect(result.stdout.match(/agent[.]show_commentary = False/gu)).toHaveLength(2);
    expect(result.stdout).toContain('.get("show_commentary", False)');
    expect(result.stdout.match(/NemoClaw compatibility override/gu)).toHaveLength(1);
  });

  it("keeps update backup and CUA refresh fallbacks off", () => {
    const result = patchSource("main", mainFixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('updates_cfg.get("pre_update_backup", False)');
    expect(result.stdout).toContain("refresh_cua_driver = False");
    expect(result.stdout).toContain('_update_cfg.get("refresh_cua_driver", False)');
    expect(result.stdout).not.toContain('updates_cfg.get("pre_update_backup", "quick")');
    expect(result.stdout.match(/NemoClaw compatibility override/gu)).toHaveLength(2);
  });

  it.each([
    [
      "missing config leaf",
      "config",
      configFixture.replace('        "mode": "smart",\n', ""),
      "expected one unpatched occurrence, found 0",
    ],
    [
      "prepatched browser fallback",
      "browser",
      browserFixture.replace("return False", "return True"),
      "expected one unpatched occurrence, found 0",
    ],
    [
      "duplicated gateway default",
      "gateway",
      `${gatewayFixture}\n${gatewayFixture}`,
      "expected one unpatched occurrence, found 2",
    ],
  ] as const)("fails closed for %s", (_name, kind, source, error) => {
    const result = patchSource(kind, source);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
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

  it.each(
    [
        "172b78ecb923048859ca177d96f5b010b44ec74bb1d13553577ff49bde1a071d",
        "02b4a0a0c8fc8b204c8f818dff1dd64295a817e5543b8a643198bcedbfbbcba2",
        "7221ee05798566ca7cf570035615a9b29034cf92ce5a6eaa5eec0693040c08aa",
        "cbcf1780174a03b225508244575915225a36502f54ad4cddf1da644d9174fec4",
        "5d00832327e4362ac75032f95003e1fa49aead4756cf7927dcfd66447b205a59",
        "85b7cb13d6e6306e75d5eec46f193433df680425533b7d35ee99e0f7eab9512a",
        "d6bf89a33fb708376a7ab354cff8081a3c3726dbfb91d84bbb679cd667db596c",
      ],
  )(
    "hash-binds the reviewed source patch and probes a real config-less profile [%s]",
    (expectedSourceHash) => {
      const digest = createHash("sha256").update(fs.readFileSync(patcher)).digest("hex");

      expect(dockerfile).toContain(`ARG NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256=${digest}`);
      expect(dockerfile).toContain(
        "COPY agents/hermes/patch-profile-policy-defaults.py " +
          "/usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py",
      );

      expect(fs.readFileSync(patcher, "utf8")).toContain(expectedSourceHash);

      expect(dockerfile).toContain("hermes profile create nemoclaw-policy-probe");
      expect(dockerfile).toContain('test ! -e "$profile_probe_home/config.yaml"');
      expect(dockerfile).toContain("/usr/local/share/nemoclaw/hermes-managed-policy.json");
      expect(dockerfile).toMatch(/image-build-probes[.]py\s+profile-policy/u);
    },
  );
});
