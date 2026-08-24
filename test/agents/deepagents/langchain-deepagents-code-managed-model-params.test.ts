// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

const e2eProfileCheckPath = path.join(
  process.cwd(),
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "03-deepagents-code-nemotron-ultra-profile.sh",
);

describe("LangChain Deep Agents Code managed model request parameters", () => {
  it("supplies the reviewed Ultra template argument from the managed provider resolver (#7441)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const validation = `
from deepagents_code import config
from deepagents_code.model_config import ModelConfigError

base_openai_kwargs = {
    "api_key": "nemoclaw-managed-inference",
    "base_url": "https://inference.local/v1",
    "use_responses_api": False,
}
base_openrouter_kwargs = {
    "api_key": "nemoclaw-managed-inference",
    "base_url": "https://inference.local/v1",
}
ultra_extra_body = {"chat_template_kwargs": {"force_nonempty_content": True}}
ultra_models = (
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nvidia/nemotron-3-ultra",
)

# A mutable allowlist would let a caller widen the shaped set at runtime.
assert isinstance(config._NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS, frozenset)
assert set(config._NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS) == set(ultra_models)

for ultra_model in ultra_models:
    resolved = config._get_provider_kwargs("openai", model_name=ultra_model)
    assert resolved == {**base_openai_kwargs, "extra_body": ultra_extra_body}, resolved
    # The reviewed argument belongs to the OpenAI adapter alone.
    routed = config._get_provider_kwargs("openrouter", model_name=ultra_model)
    assert routed == base_openrouter_kwargs, routed

# "nemotron-4" is a deliberate near miss: a neighbouring generation must not be
# shaped just because the ID looks similar.
for unshaped in ("gpt-4o", "nvidia/nemotron-4-ultra-550b-a55b", None):
    assert config._get_provider_kwargs("openai", model_name=unshaped) == base_openai_kwargs
    assert (
        config._get_provider_kwargs("openrouter", model_name=unshaped)
        == base_openrouter_kwargs
    )
assert config._get_provider_kwargs("openai") == base_openai_kwargs

for blocked_provider in ("anthropic", "fireworks", "ollama", "nvidia"):
    try:
        config._get_provider_kwargs(blocked_provider, model_name=ultra_models[0])
    except ModelConfigError:
        pass
    else:
        raise AssertionError(blocked_provider)

# Mutation of one result cannot change a later result.
tampered = config._get_provider_kwargs("openai", model_name=ultra_models[0])
tampered["api_key"] = "tampered"
tampered["extra_body"]["chat_template_kwargs"]["force_nonempty_content"] = False
assert config._get_provider_kwargs("openai", model_name=ultra_models[0]) == {
    **base_openai_kwargs,
    "extra_body": ultra_extra_body,
}
print("managed-ultra-template-argument-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("managed-ultra-template-argument-ok");
  });

  it("binds the live Ultra E2E test to the installed resolver, not the configuration round trip (#7441)", () => {
    // The managed resolver never consumes the configuration params table, so a
    // ModelConfig.get_kwargs assertion passes with or without the fix. Keep the
    // live E2E test bound to the installed function it must verify.
    const e2eCheck = fs.readFileSync(e2eProfileCheckPath, "utf8");

    expect(e2eCheck).toContain("from deepagents_code.config import");
    expect(e2eCheck).toContain("_NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS,");
    expect(e2eCheck).toContain('_get_provider_kwargs("openai", model_name=model_id)');
    expect(e2eCheck).toContain('_get_provider_kwargs("openrouter", model_name=model_id)');
    expect(e2eCheck).toContain("managed_reasoning_effort,");
    expect(e2eCheck).toContain("MANAGED_REASONING_EFFORT = managed_reasoning_effort()");
    expect(e2eCheck).toContain("except ModelConfigError:");
    expect(e2eCheck).toContain("NEMOCLAW_MANAGED_RESOLVER_CONTRACT_OK:");
    // The resolver contract stays inference-free, like the profile contract.
    expect(e2eCheck).toContain("socket.socket = blocked_socket");
    expect(e2eCheck).toContain("socket.socket = real_socket");

    const resolverContract = e2eCheck.indexOf("MANAGED_BASE_URL = managed_inference_base_url()");
    const reportedResult = e2eCheck.indexOf("2 passed, 0 failed");
    expect(resolverContract).toBeGreaterThan(-1);
    expect(reportedResult).toBeGreaterThan(resolverContract);
  });
});
