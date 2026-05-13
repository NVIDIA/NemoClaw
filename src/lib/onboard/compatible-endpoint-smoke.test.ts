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

  it("wraps the script as a base64 decoded temporary shell command", () => {
    const command = buildCompatibleEndpointSandboxSmokeCommand("nvidia/model");

    expect(command).toContain("set -eu");
    expect(command).toContain("base64.b64decode");
    expect(command).toContain('sh "$tmp"');
    expect(command).toContain("trap");
  });
});
