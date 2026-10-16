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
const defaultPluginDir = path.join(import.meta.dirname, "plugin");
const imagePluginDir = path.join(import.meta.dirname, "../nemoclaw-hermes-plugin");
const pluginDir =
  process.argv[4] ?? (fs.existsSync(defaultPluginDir) ? defaultPluginDir : imagePluginDir);
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
const result = spawnSync(
  python,
  [
    "-I",
    "-c",
    `
import json, os, sys, tempfile, types
from pathlib import Path

sys.path.insert(0, sys.argv[1])
try:
    import yaml
except ModuleNotFoundError:
    yaml = types.ModuleType("yaml")
    yaml.safe_load = json.load
    sys.modules["yaml"] = yaml

from agent.turn_context import _collect_pre_llm_call_context, compose_user_api_content
from hermes_cli.config import _expand_env_vars
from hermes_cli.plugins import _reset_plugin_managers_for_tests, discover_plugins, get_plugin_manager

for case in json.load(sys.stdin):
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

plugin_src = Path(sys.argv[2])
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
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

print("Hermes native credential resolution passed for five hosted providers; NemoClaw pre_llm_call context passed.")
`,
    runtime,
    pluginDir,
  ],
  { input: JSON.stringify(cases), encoding: "utf8", timeout: 30_000 },
);
assert.equal(result.status, 0, result.stderr || result.error?.message);
process.stdout.write(result.stdout);
