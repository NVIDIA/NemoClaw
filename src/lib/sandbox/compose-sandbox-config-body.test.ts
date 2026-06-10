// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const { composeSandboxConfigBody } = require("../../../dist/lib/sandbox/config") as {
  composeSandboxConfigBody: (
    config: Record<string, unknown>,
    target: {
      agentName: string;
      configPath: string;
      configDir: string;
      format: string;
      configFile: string;
    },
  ) => string;
};

const HERMES_TARGET = {
  agentName: "hermes",
  configPath: "/sandbox/.hermes/config.yaml",
  configDir: "/sandbox/.hermes",
  format: "yaml",
  configFile: "config.yaml",
};

const OPENCLAW_TARGET = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
};

describe("composeSandboxConfigBody", () => {
  it("prepends the upstream header and keeps the YAML body parseable for Hermes targets", () => {
    const config = {
      _nemoclaw_upstream: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      model: {
        default: "nvidia/nemotron-3-super-120b-a12b",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };

    const written = composeSandboxConfigBody(config, HERMES_TARGET);

    expect(written.startsWith("# Managed by NemoClaw")).toBe(true);
    expect(written).toContain("# Upstream provider: nvidia-prod");
    expect(written).toContain("# Upstream model: nvidia/nemotron-3-super-120b-a12b");

    const parsed = YAML.parse(written) as Record<string, unknown>;
    expect(parsed._nemoclaw_upstream).toEqual({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
    expect(parsed.model).toEqual({
      default: "nvidia/nemotron-3-super-120b-a12b",
      provider: "custom",
      base_url: "https://inference.local/v1",
    });
  });

  it("does not prepend the header for non-Hermes targets", () => {
    const config = { model: { id: "moonshotai/kimi-k2.6" } };
    const written = composeSandboxConfigBody(config, OPENCLAW_TARGET);
    expect(written.startsWith("#")).toBe(false);
    expect(JSON.parse(written)).toEqual(config);
  });

  it("does not prepend the header when the Hermes target writes JSON", () => {
    const written = composeSandboxConfigBody(
      { _nemoclaw_upstream: { provider: "nvidia-prod", model: "x" } },
      { ...HERMES_TARGET, format: "json", configFile: "config.json" },
    );
    expect(written.startsWith("#")).toBe(false);
  });

  it("rejects header breakout attempts via malicious upstream values", () => {
    const malicious = {
      _nemoclaw_upstream: {
        provider: "nvidia-prod\ngateway:\n  base_url: http://attacker",
        model: "victim\r\nmodel:\n  api_key: leaked",
      },
      model: { default: "victim", provider: "custom", base_url: "https://inference.local" },
    };

    const written = composeSandboxConfigBody(malicious, HERMES_TARGET);

    expect(
      written
        .split(/\r?\n/)
        .every((line) => !line || line.startsWith("#") || !line.startsWith("gateway")),
    ).toBe(true);
    const parsed = YAML.parse(written) as Record<string, unknown>;
    // Header-injected keys must NOT appear in the parsed document.
    expect(parsed.gateway).toBeUndefined();
    // The model block is the one written by the body, not the malicious smuggle.
    const model = parsed.model as Record<string, unknown>;
    expect(model.api_key).toBeUndefined();
    expect(model.base_url).toBe("https://inference.local");
  });

  it("omits the header when no upstream annotation is present", () => {
    const config = { model: { provider: "custom", base_url: "x" } };
    const written = composeSandboxConfigBody(config, HERMES_TARGET);
    expect(written.startsWith("#")).toBe(false);
    expect(YAML.parse(written)).toEqual(config);
  });
});
