// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  getLocalProviderBaseUrl,
  getLocalProviderHealthCheck,
  validateLocalProvider,
} = require("../bin/lib/local-inference");

describe("local inference helpers", () => {
  it("returns the expected base URL for vllm-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("vllm-local"),
      "http://host.openshell.internal:8000/v1",
    );
  });

  it("returns the expected base URL for ollama-local", () => {
    assert.equal(
      getLocalProviderBaseUrl("ollama-local"),
      "http://host.openshell.internal:11434/v1",
    );
  });

  it("returns the expected health check command for ollama-local", () => {
    assert.equal(
      getLocalProviderHealthCheck("ollama-local"),
      "curl -sf http://localhost:11434/api/tags 2>/dev/null",
    );
  });

  it("validates a reachable local provider", () => {
    const result = validateLocalProvider("ollama-local", () => '{"models":[]}');
    assert.deepEqual(result, { ok: true });
  });

  it("returns a clear error when ollama-local is unavailable", () => {
    const result = validateLocalProvider("ollama-local", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /http:\/\/localhost:11434/);
  });

  it("returns a clear error when vllm-local is unavailable", () => {
    const result = validateLocalProvider("vllm-local", () => "");
    assert.equal(result.ok, false);
    assert.match(result.message, /http:\/\/localhost:8000/);
  });
});
