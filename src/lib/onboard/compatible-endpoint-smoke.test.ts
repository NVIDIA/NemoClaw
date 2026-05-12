// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../inference/config", () => ({
  INFERENCE_ROUTE_URL: "https://inference.local/v1",
  MANAGED_PROVIDER_ID: "inference",
}));

import {
  buildCompatibleEndpointSandboxSmokeCommand,
  buildCompatibleEndpointSandboxSmokeScript,
  shouldRunCompatibleEndpointSandboxSmoke,
  spawnOutputToString,
} from "./compatible-endpoint-smoke";

describe("compatible endpoint sandbox smoke helpers", () => {
  it("runs only for OpenClaw compatible-endpoint sandboxes with messaging", () => {
    expect(shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", ["telegram"])).toBe(
      true,
    );
    expect(
      shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", ["telegram"], {
        name: "openclaw",
      }),
    ).toBe(true);
    expect(
      shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", ["telegram"], {
        name: "hermes",
      }),
    ).toBe(false);
    expect(shouldRunCompatibleEndpointSandboxSmoke("nvidia-prod", ["telegram"])).toBe(false);
    expect(shouldRunCompatibleEndpointSandboxSmoke("compatible-endpoint", [])).toBe(false);
  });

  it("normalizes spawn output values to strings", () => {
    expect(spawnOutputToString("already string")).toBe("already string");
    expect(spawnOutputToString(Buffer.from("buffered"))).toBe("buffered");
    expect(spawnOutputToString(null)).toBe("");
    expect(spawnOutputToString(42)).toBe("42");
  });

  it("builds a sandbox script that checks managed provider routing", () => {
    const script = buildCompatibleEndpointSandboxSmokeScript("provider/model'");

    expect(script).toContain("OPENCLAW_CONFIG_OK");
    expect(script).toContain("INFERENCE_SMOKE_OK");
    expect(script).toContain("models.providers.inference");
    expect(script).toContain("https://inference.local/v1/chat/completions");
    expect(script).toContain("MODEL='provider/model'\\'''");
  });

  it("budgets enough max_tokens for reasoning-mode models (#3341)", () => {
    const script = buildCompatibleEndpointSandboxSmokeScript("Qwen/Qwen3.6-27B");

    expect(script).toContain('"max_tokens": 256');
    // Regex (not substring) so a regression to `"max_tokens": 32` without the
    // trailing comma also fails the test, per CR review on PR #3356.
    expect(script).not.toMatch(/"max_tokens":\s*32\b/);
  });

  it("accepts a reasoning-only response as a valid smoke signal (#3341)", () => {
    const script = buildCompatibleEndpointSandboxSmokeScript("Qwen/Qwen3.6-27B");

    // Fallback lookup walks both `reasoning` and `reasoning_content` and only
    // accepts non-empty STRING payloads, so a truthy non-string value in one
    // field cannot mask a valid string in the other.
    expect(script).toContain('message.get("reasoning")');
    expect(script).toContain('message.get("reasoning_content")');
    expect(script).toContain("reasoning-only response");
    expect(script).toMatch(/isinstance\(value,\s*str\)\s+and\s+value\.strip\(\)/);
  });

  it("guards against empty or malformed choices arrays (#3341)", () => {
    const script = buildCompatibleEndpointSandboxSmokeScript("Qwen/Qwen3.6-27B");

    // The parser must verify choices is a non-empty list of dicts before
    // indexing, instead of relying on data.get("choices", [{}])[0] which
    // crashed on choices=[] with IndexError.
    expect(script).toContain("not isinstance(choices, list) or not choices");
    expect(script).toContain("not isinstance(choices[0], dict)");
    expect(script).not.toContain('data.get("choices", [{}])[0]');
  });

  it("wraps the script as a base64 decoded temporary shell command", () => {
    const command = buildCompatibleEndpointSandboxSmokeCommand("nvidia/model");

    expect(command).toContain("set -eu");
    expect(command).toContain("base64.b64decode");
    expect(command).toContain('sh "$tmp"');
    expect(command).toContain("trap");
  });
});
