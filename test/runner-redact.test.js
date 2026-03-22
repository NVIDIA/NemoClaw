// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { redactSecrets } = require("../bin/lib/runner");

describe("redactSecrets", () => {
  it("redacts NVIDIA_API_KEY=value", () => {
    const input = 'openshell provider create --credential "NVIDIA_API_KEY=nvapi-abc123XYZ"';
    const result = redactSecrets(input);
    assert.ok(!result.includes("nvapi-abc123XYZ"), "key value must not appear");
    assert.ok(result.includes("NVIDIA_API_KEY=***"), "key name should remain with ***");
  });

  it("redacts bare nvapi- tokens", () => {
    const input = "Bearer nvapi-SomeSecretToken123";
    const result = redactSecrets(input);
    assert.ok(!result.includes("nvapi-SomeSecretToken123"), "bare token must not appear");
    assert.ok(result.includes("nvapi-So***"), "prefix should remain with ***");
  });

  it("redacts GITHUB_TOKEN=value", () => {
    const input = "GITHUB_TOKEN=ghp_1234567890abcdef";
    const result = redactSecrets(input);
    assert.ok(!result.includes("ghp_1234567890abcdef"), "token must not appear");
    assert.ok(result.includes("GITHUB_TOKEN=***"));
  });

  it("redacts TELEGRAM_BOT_TOKEN=value", () => {
    const input = "TELEGRAM_BOT_TOKEN=123456:ABC-DEF";
    const result = redactSecrets(input);
    assert.ok(!result.includes("123456:ABC-DEF"));
    assert.ok(result.includes("TELEGRAM_BOT_TOKEN=***"));
  });

  it("redacts OPENAI_API_KEY=value", () => {
    const input = "OPENAI_API_KEY=sk-proj-abc123";
    const result = redactSecrets(input);
    assert.ok(!result.includes("sk-proj-abc123"));
    assert.ok(result.includes("OPENAI_API_KEY=***"));
  });

  it("returns input unchanged when no secrets present", () => {
    const input = "openshell sandbox create --name my-assistant";
    assert.equal(redactSecrets(input), input);
  });

  it("redacts multiple different secrets in one string", () => {
    const input = 'NVIDIA_API_KEY=nvapi-secret GITHUB_TOKEN=ghp_token123';
    const result = redactSecrets(input);
    assert.ok(!result.includes("nvapi-secret"));
    assert.ok(!result.includes("ghp_token123"));
    assert.ok(result.includes("NVIDIA_API_KEY=***"));
    assert.ok(result.includes("GITHUB_TOKEN=***"));
  });

  it("handles empty string", () => {
    assert.equal(redactSecrets(""), "");
  });

  it("is safe to call multiple times consecutively", () => {
    const input = "NVIDIA_API_KEY=nvapi-test123";
    const r1 = redactSecrets(input);
    const r2 = redactSecrets(input);
    assert.equal(r1, r2, "consecutive calls must produce identical results");
    assert.ok(!r1.includes("nvapi-test123"));
  });
});
