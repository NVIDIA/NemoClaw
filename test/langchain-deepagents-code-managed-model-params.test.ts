// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

describe("LangChain Deep Agents Code managed model request parameters", () => {
  it("supplies the reviewed Ultra template argument from the managed provider resolver (#7441)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const validation = `
from deepagents_code import config

base_openai_kwargs = {
    "api_key": "nemoclaw-managed-inference",
    "base_url": "https://inference.local/v1",
    "use_responses_api": False,
}
ultra_extra_body = {"chat_template_kwargs": {"force_nonempty_content": True}}
for ultra_model in (
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nvidia/nemotron-3-ultra",
):
    resolved = config._get_provider_kwargs("openai", model_name=ultra_model)
    assert resolved == {**base_openai_kwargs, "extra_body": ultra_extra_body}, resolved
assert config._get_provider_kwargs("openai", model_name="gpt-4o") == base_openai_kwargs
assert config._get_provider_kwargs("openai") == base_openai_kwargs
openrouter_kwargs = config._get_provider_kwargs(
    "openrouter", model_name="nvidia/nemotron-3-ultra-550b-a55b"
)
assert openrouter_kwargs == {
    "api_key": "nemoclaw-managed-inference",
    "base_url": "https://inference.local/v1",
}
print("managed-ultra-template-argument-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("managed-ultra-template-argument-ok");
  });
});
