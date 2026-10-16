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
const result = spawnSync(
  python,
  [
    "-I",
    "-c",
    `
import json, os, sys
sys.path.insert(0, sys.argv[1])
from hermes_cli.config import _expand_env_vars

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
print("Hermes native credential resolution passed for five hosted providers.")
`,
    runtime,
  ],
  { input: JSON.stringify(cases), encoding: "utf8", timeout: 30_000 },
);
assert.equal(result.status, 0, result.stderr || result.error?.message);
process.stdout.write(result.stdout);
