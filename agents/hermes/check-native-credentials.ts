// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyHermesManagedRoute } from "../../src/lib/hermes-managed-route.ts";

// Run against the installed, pinned Hermes config loader and turn-context hook caller during image construction.
const runtime = process.argv[2] ?? "/opt/hermes";
const python = process.argv[3] ?? `${runtime}/.venv/bin/python3`;
const guard = path.resolve(
  process.argv[4] ?? "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
);
const defaultPluginDir = path.join(import.meta.dirname, "plugin");
const imagePluginDir = path.join(import.meta.dirname, "../nemoclaw-hermes-plugin");
const pluginDir =
  process.argv[5] ?? (fs.existsSync(defaultPluginDir) ? defaultPluginDir : imagePluginDir);
const providers = [
  ["openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY", "openai-completions"],
  ["anthropic-prod", "https://api.anthropic.com", "ANTHROPIC_API_KEY", "anthropic-messages"],
  [
    "gemini-api",
    "https://generativelanguage.googleapis.com/v1beta/openai/",
    "GEMINI_API_KEY",
    "openai-completions",
  ],
  ["openrouter-api", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", "openai-completions"],
  [
    "hermes-provider",
    "https://inference-api.nousresearch.com/v1",
    "OPENAI_API_KEY",
    "openai-completions",
  ],
];
const cases = providers.map(([provider, baseUrl, key, inferenceApi]) => {
  const config: Record<string, unknown> = {};
  applyHermesManagedRoute(config, {
    model: "synthetic-model",
    upstreamProvider: provider,
    baseUrl,
    inferenceApi,
  });
  return { config, key, provider };
});
const localRoute = {
  model: "synthetic-local-model",
  upstreamProvider: "vllm-local",
  baseUrl: "http://host.openshell.internal:8000/v1",
  inferenceApi: "openai-completions",
};
const initialLocalConfig: Record<string, unknown> = {};
applyHermesManagedRoute(initialLocalConfig, localRoute);
const localCases = ["v7", "v8", `s${"a".repeat(64)}`].map((scope) => {
  const config: Record<string, unknown> = {};
  const handle = `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
  applyHermesManagedRoute(config, {
    ...localRoute,
    nativeCredentialHandle: handle,
  });
  return { config, handle };
});
const result = spawnSync(
  python,
  [
    "-I",
    "-c",
    `
import copy, hashlib, json, os, pathlib, runpy, sys, tempfile
sys.path.insert(0, sys.argv[1])
fixture_home = tempfile.TemporaryDirectory(prefix="hermes-credential-contract-")
os.environ["HERMES_HOME"] = fixture_home.name
from hermes_cli.config import _expand_env_vars
from hermes_cli.runtime_provider import resolve_runtime_provider
from gateway.config import GatewayConfig
import yaml

cases = json.load(sys.stdin)
guard = runpy.run_path(sys.argv[2])
home = pathlib.Path(fixture_home.name)
config_path, env_path = home / "config.yaml", home / ".env"
config_path.write_text(json.dumps(cases["initialLocal"]))
env_path.write_text("")
config_path.chmod(0o640)
env_path.chmod(0o600)
hash_path, compat_hash = home / "strict-hash", home / ".config-hash"
hashes = "".join(hashlib.sha256(p.read_bytes()).hexdigest() + "  " + str(p) + "\\n" for p in (config_path, env_path))
hash_path.write_text(hashes)
compat_hash.write_text(hashes)
for case in cases["local"]:
    os.environ["NEMOCLAW_LOCAL_INFERENCE_TOKEN"] = case["handle"]
    guard["provider_placeholders"](str(home), str(hash_path), "both", None, None, refresh_native_local=True)
    # The persisted output must work even after removing the provider env.
    del os.environ["NEMOCLAW_LOCAL_INFERENCE_TOKEN"]
    assert yaml.safe_load(config_path.read_text()) == case["config"], "startup route changed"
    for provider in ("custom", "vllm-local"):
        resolved = resolve_runtime_provider(requested=provider)
        assert resolved["api_key"] == case["handle"], "startup credential identity changed"
        assert resolved["base_url"] == case["config"]["model"]["base_url"], "startup endpoint changed"

for case in cases["hosted"]:
    config, key = case["config"], case["key"]
    template = "\${" + key + "}"
    # Re-read after rotation; never bake a build-time value or a revision into the config.
    for scope in ("v7", "v8", "s" + "a" * 64):
        handle = "openshell:resolve:env:" + scope + "_" + key
        os.environ[key] = handle
        resolved = _expand_env_vars(config)
        for source in (config["model"], *config["providers"].values(), *config["custom_providers"]):
            assert source["api_key"] == template, case["provider"]
        for source in (resolved["model"], *resolved["providers"].values(), *resolved["custom_providers"]):
            assert source["api_key"] == handle, case["provider"]
    del os.environ[key]
    assert _expand_env_vars(config)["model"]["api_key"] == template

os.environ.pop("NEMOCLAW_LOCAL_INFERENCE_TOKEN", None)
for case in cases["local"]:
    config, handle = case["config"], case["handle"]
    GatewayConfig.from_dict(config)
    resolved = _expand_env_vars(config)
    for source in (resolved["model"], *resolved["providers"].values(), *resolved["custom_providers"]):
        assert source["api_key"] == handle, "local credential identity changed"
    # JSON is valid YAML. Exercise the pinned runtime's real file-loading and
    # provider resolution without substituting its credential or config owners.
    config_path = pathlib.Path(fixture_home.name) / "config.yaml"
    config_path.write_text(json.dumps(config))
    for provider in ("custom", "vllm-local"):
        runtime_config = resolve_runtime_provider(requested=provider)
        assert runtime_config["api_key"] == handle, "local runtime credential identity changed"
        assert runtime_config["base_url"] == config["model"]["base_url"], "local endpoint changed"
    # Reproduce the deferred defect: Hermes cannot recover an issued identity
    # from the old identityless alias, even when the issued environment exists.
    alias = "sk-OPENSHELL-RESOLVE-ENV-NEMOCLAW_LOCAL_INFERENCE_TOKEN"
    legacy = copy.deepcopy(config)
    for source in (legacy["model"], *legacy["providers"].values(), *legacy["custom_providers"]):
        source["api_key"] = alias
    os.environ["NEMOCLAW_LOCAL_INFERENCE_TOKEN"] = handle
    config_path.write_text(json.dumps(legacy))
    assert resolve_runtime_provider(requested="custom")["api_key"] == alias, "legacy consumer behavior changed"
    del os.environ["NEMOCLAW_LOCAL_INFERENCE_TOKEN"]
fixture_home.cleanup()

from agent.turn_context import _collect_pre_llm_call_context, compose_user_api_content
from hermes_cli.plugins import _reset_plugin_managers_for_tests, discover_plugins, get_plugin_manager
import types

plugin_src = pathlib.Path(sys.argv[3])
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    hermes_home = root / ".hermes"
    nemoclaw_home = root / ".nemoclaw"
    bundled = root / "plugins" / "nemoclaw"
    hermes_home.mkdir()
    nemoclaw_home.mkdir()
    bundled.mkdir(parents=True)
    for name in ("__init__.py", "plugin.yaml"):
        (bundled / name).write_text((plugin_src / name).read_text(encoding="utf-8"), encoding="utf-8")
    (hermes_home / "config.yaml").write_text(
        json.dumps({
            "model": {
                "default": "nvidia/nemotron-3-nano",
                "provider": "custom:My Lab",
                "base_url": "https://inference.local/v1",
            },
            "providers": {"my-lab": {"name": "My Lab", "api": "http://lab-gpu.internal:8000/v1"}},
            "_nemoclaw_upstream": {
                "model": "nvidia/nemotron-3-nano",
                "provider": "vllm-local",
                "provider_key": "vllm-local",
            },
            "plugins": {"enabled": ["nemoclaw"]},
        }),
        encoding="utf-8",
    )
    (nemoclaw_home / "config.json").write_text(
        json.dumps({"model": "nvidia/nemotron-3-nano", "provider": "vllm-local"}),
        encoding="utf-8",
    )
    os.environ["HOME"] = str(root)
    os.environ["HERMES_HOME"] = str(hermes_home)
    os.environ["HERMES_BUNDLED_PLUGINS"] = str(bundled.parent)
    _reset_plugin_managers_for_tests()
    discover_plugins(force=True)
    loaded = get_plugin_manager()._plugins["nemoclaw"].module
    loaded.subprocess = types.SimpleNamespace(
        run=lambda *_a, **_k: (_ for _ in ()).throw(OSError("health probe skipped"))
    )
    for live_model, expected, forbidden in (
        (
            "qwen/qwen3-32b",
            "- Hermes chat model: qwen/qwen3-32b.",
            "provider=custom:My Lab",
        ),
        (
            None,
            "- Hermes chat route: model=nvidia/nemotron-3-nano, provider=custom:My Lab, endpoint=http://lab-gpu.internal:8000/v1, gateway=stopped.",
            "- Hermes chat model:",
        ),
    ):
        agent = types.SimpleNamespace(
            session_id="session-1",
            model=live_model,
            platform="cli",
            _parent_session_id="",
            _user_id="",
            _persist_disabled=False,
        )
        context = _collect_pre_llm_call_context(
            agent,
            effective_task_id="task-1",
            turn_id="turn-1",
            original_user_message="status",
            messages=[{"role": "user", "content": "status"}],
            conversation_history=[],
        )
        api_content = compose_user_api_content("status", "", context) or ""
        assert expected in api_content, api_content
        assert forbidden not in api_content, api_content
    _reset_plugin_managers_for_tests()

print("Hermes credential contracts passed for five hosted providers and native-local issued references; NemoClaw pre_llm_call context passed.")
`,
    runtime,
    guard,
    pluginDir,
  ],
  {
    input: JSON.stringify({ hosted: cases, local: localCases, initialLocal: initialLocalConfig }),
    encoding: "utf8",
    timeout: 30_000,
  },
);
assert.equal(result.status, 0, result.stderr || result.error?.message);
process.stdout.write(result.stdout);
