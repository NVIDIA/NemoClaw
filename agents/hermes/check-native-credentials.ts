// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { applyHermesManagedRoute } from "../../src/lib/hermes-managed-route.ts";

// Run against the installed, pinned Hermes config loader during image construction.
const runtime = process.argv[2] ?? "/opt/hermes";
const python = process.argv[3] ?? `${runtime}/.venv/bin/python3`;
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
// These are consumer contracts, not activation of Hermes native-local routing.
const localCases = ["v7", "v8", `s${"a".repeat(64)}`].map((scope) => {
  const config: Record<string, unknown> = {};
  const handle = `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
  applyHermesManagedRoute(config, {
    model: "synthetic-local-model",
    upstreamProvider: "vllm-local",
    baseUrl: "http://host.openshell.internal:8000/v1",
    inferenceApi: "openai-completions",
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
import copy, json, os, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
fixture_home = tempfile.TemporaryDirectory(prefix="hermes-credential-contract-")
os.environ["HERMES_HOME"] = fixture_home.name
from hermes_cli.config import _expand_env_vars
from hermes_cli.runtime_provider import resolve_runtime_provider
from gateway.config import GatewayConfig

cases = json.load(sys.stdin)
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
print("Hermes credential contracts passed for five hosted providers and native-local issued references.")
`,
    runtime,
  ],
  {
    input: JSON.stringify({ hosted: cases, local: localCases }),
    encoding: "utf8",
    timeout: 30_000,
  },
);
assert.equal(result.status, 0, result.stderr || result.error?.message);
process.stdout.write(result.stdout);
