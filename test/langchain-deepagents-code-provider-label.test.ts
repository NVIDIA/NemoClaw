// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchStagedDockerfile } from "../src/lib/onboard/dockerfile-patch";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "./helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

describe("LangChain Deep Agents Code managed provider label", () => {
  it("keeps the managed OpenAI route while reporting the NVIDIA provider family", () => {
    const tempDir = createPackageFixture();
    const model = "nvidia/nemotron-3-super-120b-a12b";
    const stagedDockerfile = path.join(tempDir, "Dockerfile");
    fs.copyFileSync(
      path.join(process.cwd(), "agents", "langchain-deepagents-code", "Dockerfile"),
      stagedDockerfile,
    );
    patchStagedDockerfile(
      stagedDockerfile,
      model,
      "http://127.0.0.1:18789",
      "provider-label-test",
      "nvidia-prod",
    );
    const stagedSource = fs.readFileSync(stagedDockerfile, "utf8");
    expect(stagedSource).toContain("ARG NEMOCLAW_PROVIDER_KEY=inference");
    expect(stagedSource).toContain("ARG NEMOCLAW_UPSTREAM_PROVIDER=nvidia-prod");
    expect(stagedSource).toContain("NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER}");
    const runtimeEnv = Object.fromEntries(
      [
        "NEMOCLAW_MODEL",
        "NEMOCLAW_PROVIDER_KEY",
        "NEMOCLAW_UPSTREAM_PROVIDER",
        "NEMOCLAW_INFERENCE_BASE_URL",
        "NEMOCLAW_INFERENCE_API",
      ].map((name) => {
        const value = stagedSource.match(new RegExp(`^ARG ${name}=(.*)$`, "m"))?.[1];
        expect(value).toBeDefined();
        return [name, value ?? ""];
      }),
    );
    const generator = path.join(
      process.cwd(),
      "agents",
      "langchain-deepagents-code",
      "generate-config.ts",
    );
    execFileSync(process.execPath, ["--experimental-strip-types", generator], {
      env: {
        PATH: process.env.PATH,
        HOME: tempDir,
        ...runtimeEnv,
      },
    });
    const config = fs.readFileSync(path.join(tempDir, ".deepagents", "config.toml"), "utf8");
    expect(config).toContain(`default = "openai:${model}"`);
    expect(config).toContain("[models.providers.openai]");
    expect(config).toContain('base_url = "https://inference.local/v1"');
    expect(config).toContain("upstream provider: nvidia-prod");

    patchFixture(tempDir);
    const validation = `
import os

from deepagents_code import _nemoclaw_managed, agent
from deepagents_code.tui.widgets.status import StatusBar
from deepagents_code.tui.widgets.welcome import WelcomeBanner

model = "nvidia/nemotron-3-super-120b-a12b"

assert os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] == "nvidia-prod"
_nemoclaw_managed.assert_safe_runtime()
assert os.environ["OPENAI_BASE_URL"] == "https://inference.local/v1"
assert os.environ["NEMOCLAW_INFERENCE_BASE_URL"] == "https://inference.local/v1"

for upstream in ("nvidia", "nvidia-prod", "nvidia-nim", "nvidia-router"):
    os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = upstream
    assert _nemoclaw_managed.managed_display_provider("openai") == "nvidia", upstream

os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = "nvidia-prod"
status = StatusBar()
status.set_model(provider="openai", model=model)
assert status.model_display == {"provider": "nvidia", "model": model, "effort": ""}, status.model_display
assert f'{status.model_display["provider"]}:{status.model_display["model"]}' == f"nvidia:{model}"
banner = WelcomeBanner()
banner.update_model(provider="openai", model=model)
assert banner.model_display == {"provider": "nvidia", "model": model}, banner.model_display
assert f'{banner.model_display["provider"]}:{banner.model_display["model"]}' == f"nvidia:{model}"
identity = agent.build_model_identity_section(model, provider="openai")
assert "(provider: nvidia)" in identity, identity
assert "openai" not in identity, identity
assert model in identity, identity

for upstream in (None, "", "bad provider!", " nvidia-prod", "nvidia-prod\\n", "x" * 65):
    if upstream is None:
        os.environ.pop("NEMOCLAW_UPSTREAM_PROVIDER", None)
    else:
        os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = upstream
    assert _nemoclaw_managed.managed_display_provider("openai") == "openai", upstream
    status.set_model(provider="openai", model=model)
    assert status.model_display == {"provider": "openai", "model": model, "effort": ""}, (upstream, status.model_display)

os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = "openai"
assert _nemoclaw_managed.managed_display_provider("openai") == "openai"

os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = "compatible-anthropic-endpoint"
assert _nemoclaw_managed.managed_display_provider("openai") == "compatible-anthropic-endpoint"

os.environ["NEMOCLAW_UPSTREAM_PROVIDER"] = "nvidia-prod"
status.set_model(provider="anthropic", model=model)
assert status.model_display == {"provider": "anthropic", "model": model, "effort": ""}, status.model_display
assert _nemoclaw_managed.managed_display_provider("anthropic") == "anthropic"

print("provider-label-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir, ...runtimeEnv },
      encoding: "utf8",
    });
    expect(output).toContain("provider-label-ok");
  });
});
