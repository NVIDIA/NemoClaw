// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupCachedPatchedFixture,
  cleanupPackageFixtures,
  createPatchedPackageFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture";
afterEach(cleanupPackageFixtures);
afterAll(cleanupCachedPatchedFixture);

describe("native inference issued credentials", () => {
  it.each([
    ["compatible-endpoint", "https://models.example/v1", "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY"],
    [
      "compatible-anthropic-endpoint",
      "https://models.example/v1",
      "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY",
    ],
    [
      "compatible-anthropic-endpoint",
      "http://host.openshell.internal:11436/v1",
      "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
    ],
    [
      "compatible-anthropic-endpoint",
      "http://host.openshell.internal:21436/v1",
      "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
    ],
    ["nvidia-prod", "https://integrate.api.nvidia.com/v1", "NVIDIA_INFERENCE_API_KEY"],
  ])("binds %s constructor credentials to the issued scoped handle", (provider, endpoint, key) => {
    const tempDir = createPatchedPackageFixture();
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import os
from pathlib import Path
from deepagents_code import config, _nemoclaw_managed as managed
for name, value in [("managed-upstream-provider", ${JSON.stringify(provider)}), ("managed-inference-base-url", ${JSON.stringify(endpoint)})]:
    target = Path(${JSON.stringify(tempDir)}) / name
    target.chmod(0o644)
    target.write_text(value + "\\n")
    target.chmod(0o444)
key = ${JSON.stringify(key)}
for value in ["openshell:resolve:env:v42_" + key, "openshell:resolve:env:s" + "a" * 64 + "_" + key]:
    os.environ[key] = value
    assert config._get_provider_kwargs("openai")["api_key"] == value
for value in ["", "raw-secret-do-not-print", "openshell:resolve:env:" + key, "openshell:resolve:env:v42_OTHER_KEY"]:
    os.environ[key] = value
    try:
        config._get_provider_kwargs("openai")
    except RuntimeError as error:
        assert str(error) == "Native inference requires an issued OpenShell credential handle"
    else:
        raise AssertionError("unsafe credential accepted")
del os.environ[key]
try:
    config._get_provider_kwargs("openai")
except RuntimeError:
    pass
else:
    raise AssertionError("missing credential accepted")
`,
      ],
      {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("raw-secret-do-not-print");
  });
});
