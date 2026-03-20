// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildProviderCommand, buildSandboxConfigSyncScript } = require("../bin/lib/onboard");

describe("buildProviderCommand", () => {
  it("includes both create and update fallback for nvidia-nim", () => {
    const cmd = buildProviderCommand(
      "nvidia-nim",
      "NVIDIA_API_KEY=nvapi-test123",
      "https://integrate.api.nvidia.com/v1"
    );
    assert.match(cmd, /openshell provider create --name nvidia-nim/);
    assert.match(cmd, /openshell provider update nvidia-nim/);
    assert.match(cmd, /NVIDIA_API_KEY=nvapi-test123/);
    assert.match(cmd, /OPENAI_BASE_URL=https:\/\/integrate\.api\.nvidia\.com\/v1/);
  });

  it("includes both create and update fallback for vllm-local", () => {
    const cmd = buildProviderCommand(
      "vllm-local",
      "OPENAI_API_KEY=dummy",
      "http://host.containers.internal:8000/v1"
    );
    assert.match(cmd, /openshell provider create --name vllm-local/);
    assert.match(cmd, /openshell provider update vllm-local/);
  });

  it("includes both create and update fallback for ollama-local", () => {
    const cmd = buildProviderCommand(
      "ollama-local",
      "OPENAI_API_KEY=ollama",
      "http://host.containers.internal:11434/v1"
    );
    assert.match(cmd, /openshell provider create --name ollama-local/);
    assert.match(cmd, /openshell provider update ollama-local/);
  });

  it("credential appears in both create and update branches", () => {
    const cmd = buildProviderCommand(
      "nvidia-nim",
      "NVIDIA_API_KEY=nvapi-secret",
      "https://integrate.api.nvidia.com/v1"
    );
    const parts = cmd.split("||");
    assert.ok(parts.length >= 2, "should have create || update || true");
    assert.match(parts[0], /NVIDIA_API_KEY=nvapi-secret/);
    assert.match(parts[1], /NVIDIA_API_KEY=nvapi-secret/);
  });

  it("ends with || true for error suppression", () => {
    const cmd = buildProviderCommand("test", "KEY=val", "http://localhost:8000/v1");
    assert.ok(cmd.trimEnd().endsWith("|| true"));
  });
});

describe("onboard helpers", () => {
  it("builds a sandbox sync script that writes config and updates the selected model", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /cat > ~\/\.nemoclaw\/config\.json/);
    assert.match(script, /"model": "nemotron-3-nano:30b"/);
    assert.match(script, /"credentialEnv": "OPENAI_API_KEY"/);
    assert.match(script, /openclaw models set 'inference\/nemotron-3-nano:30b'/);
    assert.match(script, /cfg\.setdefault\('agents', \{\}\)\.setdefault\('defaults', \{\}\)\.setdefault\('model', \{\}\)\['primary'\]/);
    assert.match(script, /providers_cfg\["inference"\]/);
    assert.match(script, /json\.loads\("\{\\\"baseUrl\\\":\\\"https:\/\/inference\.local\/v1\\\",\\\"apiKey\\\":\\\"unused\\\"/);
    assert.match(script, /inference\/nemotron-3-nano:30b/);
    assert.match(script, /^exit$/m);
  });
});
